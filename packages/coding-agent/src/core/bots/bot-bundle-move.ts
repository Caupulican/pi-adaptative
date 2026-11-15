/**
 * Moves a bot session's orchestration state an earlier build kept in the owner's home (`<agentDir>/state/orchestration`)
 * into the bot's (`bots/<id>/orchestration`), the first time the bot's host loads it after the change: its bundle
 * directory, its lifetime leases and its fleet queue files (the session's and its away runs'), each by one rename,
 * never a copy. One rename of one directory cannot carry them: the homes keep a session's pieces in separate trees (the
 * bundle under `sessions/`, the tombstone and leases under `deletions/`, the fleet queue files under the state
 * directory's `fleet/queue/`), and moving those trees would move the owner's own paths.
 *
 * Each load moves what the owner's home still has of the session, so a move a crash cut short is finished by the next.
 * A piece the bot's home already has is not written over: a lease registry whose holders are all dead records nothing
 * and is removed; of two copies of a fleet queue file the newer is kept (the bot's when it is not older, else the
 * owner's replaces it, finishing the move); a bundle in both homes keeps the rest where it is, and the host tells the owner. A session
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
 * A bundle whose session ran workers is not moved at all: their transcripts' birth records, their bindings in the
 * session's event store and the home's project-specialist entries name the transcripts by absolute path in the owner's
 * home, which a rename cannot rewrite, so the session keeps its state there (`kept`, `worker-records`) and keeps using
 * it there, as every opener derives (`resolveSessionHome`: no bot home holds it).
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
	botHostBlockers,
	readSessionLeaseHolders,
	sessionBundleDeletionPolicy,
	withSessionBundleInspection,
} from "../../kernel/session/session-bundle-lifecycle.ts";
import {
	type OrchestrationHome,
	orchestrationSessionDeletionFile,
	orchestrationSessionDir,
	ownerOrchestrationHome,
	workerConversationSessionsDir,
} from "../../kernel/session/session-bundle-paths.ts";
import { sessionFleetQueueMetadataPaths } from "../fleet/fleet-queue-store.ts";

/**
 * `none`: the owner's home has nothing of the session. `moved`: the bot's home holds it now. `deleting`: a tombstone
 * stands for it in either home; nothing moves while its deletion protocol owns it (a permanent deletion has set the
 * pointer aside already; an expiry's settles, and a later load moves what is left). `held`: a holder of the owner's
 * home that keeps the bot's host out (`botHostBlockers`, the rule its admission counts by) serves it; it stays, and
 * the host's own lease there is refused while that holder keeps it out, which is what the owner is told. `kept`: the
 * move was not made (`reason`), and the host tells the owner once: the bot's home already has a bundle of the session
 * (`in-both-homes`, the session uses the bot's, and the owner's stays unused at `ownerBundle`), the session's workers
 * recorded their transcripts in the owner's home (`worker-records`), the homes lie on different devices
 * (`cross-device`), or processes `pids` not proven dead still hold it in the owner's home, none of which keeps the
 * bot's host out (away runs' hosts: `still-held`); in those three the session uses the owner's.
 */
export type BotBundleMove =
	| { readonly kind: "none" }
	| { readonly kind: "moved" }
	| { readonly kind: "deleting" }
	| { readonly kind: "held" }
	| { readonly kind: "kept"; readonly reason: "in-both-homes"; readonly ownerBundle: string }
	| { readonly kind: "kept"; readonly reason: "worker-records" | "cross-device" }
	| { readonly kind: "kept"; readonly reason: "still-held"; readonly pids: readonly number[] };

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

/**
 * The indexes of the bundle, the lease registry and the fleet queue files among {@link sessionStatePieces}: the
 * session's, and its away runs' (`sessionFleetQueueMetadataPaths`).
 */
const BUNDLE = 0;
const LEASES = 1;
const FLEET_QUEUES: readonly number[] = [2, 3];

/** The pieces of one session's orchestration state in `home` that move, in the order they move. */
export function sessionStatePieces(home: OrchestrationHome, sessionId: string): string[] {
	return [
		orchestrationSessionDir(home, sessionId),
		`${orchestrationSessionDeletionFile(home, sessionId)}.leases.json`,
		...sessionFleetQueueMetadataPaths(home, sessionId),
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
			// Any holder not proven dead stops the renames; whether the bot's host is refused beside it is its admission's rule.
			const recorded = readSessionLeaseHolders(owner, sessionId);
			const holding = recorded.filter((holder) => holder.standing !== "dead");
			if (holding.length > 0)
				return botHostBlockers(holding).length > 0
					? { kind: "held" }
					: { kind: "kept", reason: "still-held", pids: holding.map((holder) => holder.owner.pid) };
			const inBoth = pieces.filter((index) => existsSync(to[index] as string));
			if (inBoth.includes(BUNDLE))
				return { kind: "kept", reason: "in-both-homes", ownerBundle: from[BUNDLE] as string };
			// The bot's bundle, when there is one, is the one the session uses; else the owner's stays where its workers wrote.
			if (existsSync(workerConversationSessionsDir(owner, sessionId)))
				return { kind: "kept", reason: "worker-records" };
			// What the bot's home already has wins where the owner's records nothing newer: a registry of dead holders only,
			// or a fleet queue file older than the bot's. A newer owner's fleet queue file replaces the bot's below.
			const dropped = inBoth.filter(
				(index) =>
					index === LEASES ||
					(FLEET_QUEUES.includes(index) &&
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
