/**
 * Moves a bot session's orchestration state an earlier build kept in the owner's home (`<agentDir>/state/orchestration`)
 * into the bot's (`bots/<id>/orchestration`), the first time the bot's host loads it after the change: its bundle
 * directory, its deletion tombstone, its lifetime leases and its fleet queue file, each by one rename, never a copy and
 * never over a file the bot's home already has.
 *
 * The move runs under the bot's `host.lock` and under the bundle locks of both homes (the tombstone locks every lease
 * acquisition, release and deletion reservation takes), the owner's first. In that order, and with these locks, no lease
 * is held in the owner's home while the pieces move: the move starts only when every holder its lease registry records
 * is proven dead, no acquisition can add one before the locks are released, and this host takes its own lease only
 * after, in the bot's home, when its session is built there. The pieces move bundle, tombstone, leases, fleet queue: the
 * bundle first, so a reader without the locks that finds the bot's home holding the session finds its state there.
 *
 * A move across devices (`EXDEV`) puts back what it moved and keeps the state where it was: the session is then
 * opened in the owner's home, which still holds it (`botSessionStorageRoots`), and the host tells the owner once.
 */
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import {
	orchestrationHomeHoldsSession,
	readSessionLeaseHolders,
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
 * `none`: nothing to move (the bot's home holds the session, or no home does). `moved`: the bot's home holds it now.
 * `held`: a holder of the owner's home not proven dead serves it; it stays, and the session is opened where it is.
 * `kept`: the move could not be made (`reason`); it stays where it was.
 */
export type BotBundleMove =
	| { readonly kind: "none" }
	| { readonly kind: "moved" }
	| { readonly kind: "held" }
	| { readonly kind: "kept"; readonly reason: string };

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
 * Moves bot session `sessionId`'s state from the owner's home into `botHome` when only the owner's holds it. Called by
 * the bot's host under its `host.lock`, before the session is opened.
 */
export function moveBotSessionBundle(agentDir: string, botHome: OrchestrationHome, sessionId: string): BotBundleMove {
	const owner = ownerOrchestrationHome(agentDir);
	if (orchestrationHomeHoldsSession(botHome, sessionId) || !orchestrationHomeHoldsSession(owner, sessionId))
		return { kind: "none" };
	return withSessionBundleInspection(owner, sessionId, () =>
		withSessionBundleInspection(botHome, sessionId, (): BotBundleMove => {
			if (orchestrationHomeHoldsSession(botHome, sessionId) || !orchestrationHomeHoldsSession(owner, sessionId))
				return { kind: "none" };
			if (readSessionLeaseHolders(owner, sessionId).some((holder) => holder.standing !== "dead"))
				return { kind: "held" };
			const from = sessionStatePieces(owner, sessionId);
			const to = sessionStatePieces(botHome, sessionId);
			const taken = to.find((path, index) => existsSync(from[index]!) && existsSync(path));
			if (taken !== undefined) return { kind: "kept", reason: `the bot's home already has ${taken}` };
			const moved: number[] = [];
			for (const [index, source] of from.entries()) {
				if (!existsSync(source)) continue;
				const target = to[index]!;
				try {
					mkdirSync(dirname(target), { recursive: true });
					renameSync(source, target);
				} catch (error) {
					if (!isCrossDevice(error)) throw error;
					for (const back of moved.reverse()) renameSync(to[back]!, from[back]!);
					return { kind: "kept", reason: error instanceof Error ? error.message : String(error) };
				}
				moved.push(index);
			}
			return { kind: "moved" };
		}),
	);
}
