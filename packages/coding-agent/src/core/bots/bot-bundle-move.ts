/**
 * Moves a bot session's orchestration state an earlier build kept in the owner's home (`<agentDir>/state/orchestration`)
 * into the bot's (`bots/<id>/orchestration`), the first time the bot's host loads it after the change: its bundle
 * directory, its deletion tombstone, its lifetime leases and its fleet queue file, each by one rename, never a copy.
 *
 * Each load moves what the owner's home still has of the session, so a move a crash cut short is finished by the next.
 * A piece the bot's home already has is not written over: a lease registry whose holders are all dead records nothing
 * and is removed; of two fleet queue files the newer is kept (the bot's when it is not older, else the owner's replaces
 * it, finishing the move); a bundle or tombstone in both homes keeps the rest where it is, and the host tells the owner. The move runs under the bot's `host.lock` and under the bundle locks of both homes (the tombstone locks every lease
 * acquisition, release and deletion reservation takes), the owner's first. In that order, and with these locks, no lease
 * is held in the owner's home while the pieces move: the move starts only when every holder its lease registry records
 * is proven dead, no acquisition can add one before the locks are released, and this host takes its own lease only
 * after, in the bot's home, when its session is built there. The pieces move bundle, tombstone, leases, fleet queue: the
 * bundle first, so a reader without the locks that finds the bot's home holding the session finds its state there.
 *
 * A rename that fails puts back what moved before it. Across devices (`EXDEV`) the state is kept where it was: the
 * session is then opened in the owner's home, which still holds it (`botSessionStorageRoots`), and the host tells the
 * owner once; any other failure is thrown to the load. An opener in another process that chose the
 * owner's home before the move and takes its lease after it is refused (`SessionHomeChangedError`): a lease derives the
 * session's home again under its tombstone lock (`sessionHomeNow`), so no session holds leases in two homes.
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { readSessionLeaseHolders, withSessionBundleInspection } from "../../kernel/session/session-bundle-lifecycle.ts";
import {
	type OrchestrationHome,
	orchestrationSessionDeletionFile,
	orchestrationSessionDir,
	ownerOrchestrationHome,
} from "../../kernel/session/session-bundle-paths.ts";
import { fleetQueueMetadataPath } from "../fleet/fleet-queue-store.ts";

/**
 * `none`: the owner's home has nothing of the session. `moved`: the bot's home holds it now.
 * `held`: a holder of the owner's home not proven dead serves it; it stays, and the session is opened where it is.
 * `kept`: the move could not be made (`reason`); it stays where it was.
 */
export type BotBundleMove =
	| { readonly kind: "none" }
	| { readonly kind: "moved" }
	| { readonly kind: "held" }
	| { readonly kind: "kept"; readonly reason: string };

/** The indexes of the lease registry and the fleet queue file among {@link sessionStatePieces}. */
const LEASES = 2;
const FLEET_QUEUE = 3;

/** The pieces of one session's orchestration state in `home`, in the order they move. */
function sessionStatePieces(home: OrchestrationHome, sessionId: string): string[] {
	const tombstone = orchestrationSessionDeletionFile(home, sessionId);
	return [
		orchestrationSessionDir(home, sessionId),
		tombstone,
		`${tombstone}.leases.json`,
		fleetQueueMetadataPath(home, sessionId),
	];
}

function isCrossDevice(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "EXDEV";
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
			const leases = readSessionLeaseHolders(owner, sessionId);
			if (leases.some((holder) => holder.standing !== "dead")) return { kind: "held" };
			const inBoth = pieces.filter((index) => existsSync(to[index] as string));
			const taken = inBoth.find((index) => index !== LEASES && index !== FLEET_QUEUE);
			if (taken !== undefined) return { kind: "kept", reason: `the bot's home already has ${to[taken]}` };
			// What the bot's home already has wins where the owner's records nothing newer: a registry of dead holders only,
			// or a fleet queue file older than the bot's. A newer owner's fleet queue file replaces the bot's below.
			const dropped = inBoth.filter(
				(index) =>
					index === LEASES || statSync(to[index] as string).mtimeMs >= statSync(from[index] as string).mtimeMs,
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
				for (const index of moved.reverse()) renameSync(to[index] as string, from[index] as string);
				if (!isCrossDevice(error)) throw error;
				return { kind: "kept", reason: error instanceof Error ? error.message : String(error) };
			}
			return { kind: "moved" };
		}),
	);
}
