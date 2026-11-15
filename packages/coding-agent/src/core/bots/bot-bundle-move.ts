/**
 * Moves a bot session's orchestration state an earlier build kept in the owner's home (`<agentDir>/state/orchestration`)
 * into the bot's (`bots/<id>/orchestration`), the first time the bot's host loads it after the change: its bundle
 * directory, its lifetime leases and its fleet queue file, each by one rename, never a copy. One rename of one directory
 * cannot carry them: the homes keep a session's pieces in separate trees (the bundle under `sessions/`, the tombstone
 * and leases under `deletions/`, the fleet queue under the state directory's `fleet/queue/`), and moving those trees
 * would move the owner's own paths.
 *
 * Each load moves what the owner's home still has of the session, so a move a crash cut short is finished by the next.
 * A piece the bot's home already has is not written over: a lease registry whose holders are all dead records nothing
 * and is removed; of two fleet queue files the newer is kept (the bot's when it is not older, else the owner's replaces
 * it, finishing the move); a bundle in both homes keeps the rest where it is, and the host tells the owner. A session
 * whose deletion either home reserved (a tombstone stands: a permanent deletion, or an expiry retiring its bundle) is
 * not moved at all: the deletion protocol owns it until it settles, and a tombstone never moves. The move runs under the
 * bot's `host.lock` and under the bundle locks of both homes (the tombstone locks every lease acquisition, release and
 * deletion reservation takes, and taking it creates only its lock, never the tombstone), the owner's first. In that
 * order, and with these locks, no lease is held and no deletion is reserved in the owner's home while the pieces move:
 * the move starts only when no tombstone stands and every holder its lease registry records is proven dead, no
 * acquisition or reservation can add one before the locks are released, and this host takes its own lease only after,
 * in the bot's home, when its session is built there. The bundle moves first, so a reader without the locks that finds
 * the bot's home holding the session finds its state there.
 *
 * A rename that fails puts back what moved before it. Across devices (`EXDEV`) the state is kept where it was: the
 * session is then opened in the owner's home, which still holds it (`botSessionStorageRoots`), and the host tells the
 * owner once; any other failure is thrown to the load, and a put-back that fails too is thrown with it, naming which
 * pieces stand in which home. An opener in another process that chose the owner's home before the move and takes its
 * lease after it is refused (`SessionHomeChangedError`): a lease derives the session's home again under its tombstone
 * lock (`sessionHomeNow`), so no session holds leases in two homes.
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
	readSessionLeaseHolders,
	sessionBundleDeletionPolicy,
	withSessionBundleInspection,
} from "../../kernel/session/session-bundle-lifecycle.ts";
import {
	type OrchestrationHome,
	orchestrationSessionDeletionFile,
	orchestrationSessionDir,
	ownerOrchestrationHome,
} from "../../kernel/session/session-bundle-paths.ts";
import { fleetQueueMetadataPath } from "../fleet/fleet-queue-store.ts";

/**
 * `none`: the owner's home has nothing of the session. `moved`: the bot's home holds it now. `deleting`: a tombstone
 * stands for it in either home; nothing moves while its deletion protocol owns it (a permanent deletion has set the
 * pointer aside already; an expiry's settles, and a later load moves what is left). `held`: a holder of the owner's
 * home not proven dead serves it; it stays, and the host's own lease there is refused while that holder lives, which
 * is what the owner is told. `kept`: the move was not made (`reason`), and the host tells the owner once: the bot's
 * home already has a bundle of the session (`in-both-homes`, the session uses the bot's, and the owner's stays unused
 * at `ownerBundle`), or the homes lie on different devices (`cross-device`, the session uses the owner's).
 */
export type BotBundleMove =
	| { readonly kind: "none" }
	| { readonly kind: "moved" }
	| { readonly kind: "deleting" }
	| { readonly kind: "held" }
	| { readonly kind: "kept"; readonly reason: "in-both-homes"; readonly ownerBundle: string }
	| { readonly kind: "kept"; readonly reason: "cross-device" };

/**
 * A move that failed and whose put-back failed too: `errors` holds the failure first, then each put-back's.
 * `inBotHome` lists the pieces that stand in the bot's home, `inOwnerHome` those that stand in the owner's.
 */
export class BotBundleSplitError extends AggregateError {
	readonly inBotHome: readonly string[];
	readonly inOwnerHome: readonly string[];

	constructor(sessionId: string, errors: unknown[], inBotHome: string[], inOwnerHome: string[]) {
		super(
			errors,
			`Bot session ${sessionId}'s orchestration state was moved only in part: in the bot's home ${inBotHome.join(", ")}; in the owner's home ${inOwnerHome.join(", ") || "nothing"}.`,
		);
		this.name = "BotBundleSplitError";
		this.inBotHome = inBotHome;
		this.inOwnerHome = inOwnerHome;
	}
}

/** The indexes of the bundle, the lease registry and the fleet queue file among {@link sessionStatePieces}. */
const BUNDLE = 0;
const LEASES = 1;
const FLEET_QUEUE = 2;

/** The pieces of one session's orchestration state in `home` that move, in the order they move. */
function sessionStatePieces(home: OrchestrationHome, sessionId: string): string[] {
	return [
		orchestrationSessionDir(home, sessionId),
		`${orchestrationSessionDeletionFile(home, sessionId)}.leases.json`,
		fleetQueueMetadataPath(home, sessionId),
	];
}

function isCrossDevice(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "EXDEV";
}

/** Puts back what moved, last first; a put-back that fails is thrown with `failure`, naming where each piece stands. */
function putBack(sessionId: string, failure: unknown, moved: number[], from: string[], to: string[]): void {
	const errors: unknown[] = [failure];
	const inBotHome: string[] = [];
	for (const index of [...moved].reverse()) {
		try {
			renameSync(to[index] as string, from[index] as string);
		} catch (error) {
			errors.push(error);
			inBotHome.push(to[index] as string);
		}
	}
	if (errors.length > 1)
		throw new BotBundleSplitError(
			sessionId,
			errors,
			inBotHome,
			from.filter((path) => existsSync(path)),
		);
}

/**
 * Moves what the owner's home has of bot session `sessionId`'s state into `botHome`. Called by the bot's host under its
 * `host.lock`, before the session is opened.
 */
export function moveBotSessionBundle(agentDir: string, botHome: OrchestrationHome, sessionId: string): BotBundleMove {
	const owner = ownerOrchestrationHome(agentDir);
	const from = sessionStatePieces(owner, sessionId);
	const to = sessionStatePieces(botHome, sessionId);
	if (!from.some((path) => existsSync(path))) return { kind: "none" };
	return withSessionBundleInspection(owner, sessionId, () =>
		withSessionBundleInspection(botHome, sessionId, (): BotBundleMove => {
			const pieces = from.flatMap((source, index) => (existsSync(source) ? [index] : []));
			if (pieces.length === 0) return { kind: "none" };
			const deleting = [owner, botHome].some((home) => sessionBundleDeletionPolicy(home, sessionId) !== undefined);
			if (deleting) return { kind: "deleting" };
			const leases = readSessionLeaseHolders(owner, sessionId);
			if (leases.some((holder) => holder.standing !== "dead")) return { kind: "held" };
			const inBoth = pieces.filter((index) => existsSync(to[index] as string));
			if (inBoth.includes(BUNDLE))
				return { kind: "kept", reason: "in-both-homes", ownerBundle: from[BUNDLE] as string };
			// What the bot's home already has wins where the owner's records nothing newer: a registry of dead holders only,
			// or a fleet queue file older than the bot's. A newer owner's fleet queue file replaces the bot's below.
			const dropped = inBoth.filter(
				(index) =>
					index === LEASES ||
					(index === FLEET_QUEUE &&
						statSync(to[index] as string).mtimeMs >= statSync(from[index] as string).mtimeMs),
			);
			for (const index of dropped) rmSync(from[index] as string);
			const moved: number[] = [];
			try {
				for (const index of pieces) {
					if (dropped.includes(index)) continue;
					const target = to[index] as string;
					mkdirSync(dirname(target), { recursive: true });
					renameSync(from[index] as string, target);
					moved.push(index);
				}
			} catch (error) {
				// Whatever stopped it, what moved goes back: the owner's home holds the session whole again.
				putBack(sessionId, error, moved, from, to);
				if (!isCrossDevice(error)) throw error;
				return { kind: "kept", reason: "cross-device" };
			}
			return { kind: "moved" };
		}),
	);
}
