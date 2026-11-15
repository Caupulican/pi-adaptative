/**
 * Moves a bot session's orchestration state an earlier build kept in the owner's home (`<agentDir>/state/orchestration`)
 * into the bot's (`bots/<id>/orchestration`), the first time the bot's host loads it after the change: its bundle
 * directory, its deletion tombstone, its lifetime leases and its fleet queue file, each by one rename, never a copy and
 * never over a file the bot's home already has.
 *
 * Each load moves what the owner's home still has of the session, so a move a crash cut short is finished by the next:
 * a piece the bot's home already has is not written over and keeps the rest where it is (told), except a lease registry
 * whose holders are all dead, which records nothing and is removed. The move runs under the bot's `host.lock` and under the bundle locks of both homes (the tombstone locks every lease
 * acquisition, release and deletion reservation takes), the owner's first. In that order, and with these locks, no lease
 * is held in the owner's home while the pieces move: the move starts only when every holder its lease registry records
 * is proven dead, no acquisition can add one before the locks are released, and this host takes its own lease only
 * after, in the bot's home, when its session is built there. The pieces move bundle, tombstone, leases, fleet queue: the
 * bundle first, so a reader without the locks that finds the bot's home holding the session finds its state there.
 *
 * A rename that fails puts back what moved before it. Across devices (`EXDEV`) the state is kept where it was: the
 * session is then opened in the owner's home, which still holds it (`botSessionStorageRoots`), and the host tells the
 * owner once; any other failure is thrown to the load. The order holds while the locks are held: an opener in another
 * process that resolved the session's roots before the move and acquires its lease after it still leases in the owner's
 * home (the lease acquisition does not resolve the roots again under its lock).
 */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
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

/** The index of the lease registry among {@link sessionStatePieces}. */
const LEASES = 2;

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
			// A registry of dead holders only records nothing: the bot's own replaces it rather than being written over.
			const deadLeases = pieces.find((index) => index === LEASES && existsSync(to[index] as string));
			const taken = pieces.find((index) => index !== LEASES && existsSync(to[index] as string));
			if (taken !== undefined) return { kind: "kept", reason: `the bot's home already has ${to[taken]}` };
			if (deadLeases !== undefined) rmSync(from[deadLeases] as string);
			const moved: number[] = [];
			try {
				for (const index of pieces) {
					if (index === deadLeases) continue;
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
