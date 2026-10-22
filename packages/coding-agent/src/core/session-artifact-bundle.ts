import { spawnSync } from "node:child_process";
import { lstat, rm, unlink } from "node:fs/promises";
import { readSessionHeaderResult } from "../kernel/session/session-manager.ts";
import { orchestrationSessionDir } from "./agent-paths.ts";
import { sessionJournalPaths } from "./cost/semantic-usage-journal.ts";
import { WorkerConversationStore } from "./delegation/worker-conversation-store.ts";
import { reserveSessionBundleDeletion, settleSessionBundleDeletion } from "./orchestration/session-bundle-lifecycle.ts";
import { isMissingFileError } from "./util/atomic-file.ts";

export type SessionArtifactDeletionMethod = "trash" | "unlink" | "preserved";

export interface SessionArtifactPathDeletion {
	ok: boolean;
	method: SessionArtifactDeletionMethod;
	error?: string;
}

type SessionArtifactBundlePart =
	| SessionArtifactPathDeletion
	| { ok: true; method: "absent" }
	| { ok: false; method: "preserved" };

export interface ForegroundSessionBundleDeletion {
	foreground: SessionArtifactPathDeletion;
	/** The session's usage-journal sidecars: they record spend into this file and cannot outlive it. */
	journal: SessionArtifactBundlePart;
	workerArtifacts: SessionArtifactBundlePart;
	complete: boolean;
}

export interface DeleteForegroundSessionBundleOptions {
	agentDir: string;
	parentSessionId: string;
	sessionPath: string;
	removePath?: (path: string) => Promise<SessionArtifactPathDeletion>;
}

function describeTrashError(result: ReturnType<typeof spawnSync>): string | undefined {
	const parts: string[] = [];
	if (result.error) parts.push(result.error.message);
	const stderr = typeof result.stderr === "string" ? result.stderr.trim() : undefined;
	if (stderr) parts.push(stderr.split("\n")[0] ?? stderr);
	return parts.length > 0 ? `trash: ${parts.join(" · ").slice(0, 200)}` : undefined;
}

/**
 * Move a managed path to the platform trash when available. Permanent removal is a documented
 * fallback only when trash cannot complete the individual path.
 */
export async function removePathWithTrashFallback(path: string): Promise<SessionArtifactPathDeletion> {
	const trashArgs = path.startsWith("-") ? ["--", path] : [path];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8", timeout: 10_000 });
	if (trashResult.status === 0) return { ok: true, method: "trash" };

	try {
		const stat = await lstat(path).catch((error: unknown) => {
			if (isMissingFileError(error)) return undefined;
			throw error;
		});
		if (stat === undefined) return { ok: true, method: "trash" };
		if (stat.isDirectory()) {
			await rm(path, { recursive: true, force: false });
		} else {
			await unlink(path);
		}
		return { ok: true, method: "unlink" };
	} catch (error) {
		const fallbackError = error instanceof Error ? error.message : String(error);
		const trashError = describeTrashError(trashResult);
		return {
			ok: false,
			method: "unlink",
			error: trashError ? `${fallbackError} (${trashError})` : fallbackError,
		};
	}
}

/** Every usage-journal sidecar of the session file, removed one by one under the same policy; preserved when they cannot be listed. */
async function removeJournalSidecars(
	sessionPath: string,
	removePath: (path: string) => Promise<SessionArtifactPathDeletion>,
): Promise<SessionArtifactBundlePart> {
	let paths: string[];
	try {
		paths = sessionJournalPaths(sessionPath);
	} catch {
		return { ok: false, method: "preserved" };
	}
	if (paths.length === 0) return { ok: true, method: "absent" };
	let last: SessionArtifactPathDeletion = { ok: true, method: "trash" };
	for (const path of paths) {
		last = await removePath(path);
		if (!last.ok) return last;
	}
	return last;
}

/** One deletion reservation spans foreground, journal and optional worker-artifact removal. */
export async function deleteForegroundSessionBundle(
	options: DeleteForegroundSessionBundleOptions,
): Promise<ForegroundSessionBundleDeletion> {
	const removePath = options.removePath ?? removePathWithTrashFallback;
	const reservation = reserveSessionBundleDeletion(
		options.agentDir,
		options.parentSessionId,
		"permanent",
		(existingPolicy) => {
			const read = readSessionHeaderResult(options.sessionPath);
			// A prior admitted deletion can retry its remaining sidecars after the foreground is gone.
			if (
				!read.ok &&
				read.reason === "unreadable" &&
				isMissingFileError(read.cause) &&
				existingPolicy === "permanent"
			)
				return true;
			if (!read.ok || read.header.id !== options.parentSessionId)
				throw new Error("Selected session identity changed or could not be read; refresh the session list.");
			return true;
		},
	);
	if (!reservation) {
		return {
			foreground: { ok: false, method: "preserved", error: "Session is active or another deletion owns it." },
			journal: { ok: false, method: "preserved" },
			workerArtifacts: { ok: false, method: "preserved" },
			complete: false,
		};
	}

	const workerArtifactsPath = orchestrationSessionDir(options.agentDir, options.parentSessionId);
	let outcome: "removed" | "retained" = "retained";
	const failures: unknown[] = [];
	let result: ForegroundSessionBundleDeletion | undefined;
	try {
		result = await (async (): Promise<ForegroundSessionBundleDeletion> => {
			const foreground = await removePath(options.sessionPath);
			if (!foreground.ok)
				return {
					foreground,
					journal: { ok: false, method: "preserved" },
					workerArtifacts: { ok: false, method: "preserved" },
					complete: false,
				};
			const journal = await removeJournalSidecars(options.sessionPath, removePath);
			if (!WorkerConversationStore.canDeleteReservedBundle(options.agentDir, reservation))
				return { foreground, journal, workerArtifacts: { ok: false, method: "preserved" }, complete: false };
			const exists = await lstat(workerArtifactsPath).then(
				() => true,
				(error: unknown) => {
					if (isMissingFileError(error)) return false;
					throw error;
				},
			);
			if (!exists) {
				outcome = "removed";
				return { foreground, journal, workerArtifacts: { ok: true, method: "absent" }, complete: journal.ok };
			}
			const workerArtifacts = await removePath(workerArtifactsPath);
			if (workerArtifacts.ok) outcome = "removed";
			return { foreground, journal, workerArtifacts, complete: journal.ok && workerArtifacts.ok };
		})();
	} catch (error) {
		failures.push(error);
	}
	try {
		settleSessionBundleDeletion(options.agentDir, reservation, outcome);
	} catch (settlementError) {
		failures.push(settlementError);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Session deletion and reservation settlement failed.");
	return result!;
}
