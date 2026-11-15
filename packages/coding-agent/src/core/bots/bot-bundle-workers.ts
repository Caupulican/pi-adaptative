/**
 * Whether a bot session's bundle stays in the owner's home for its workers, read before the move into the bot's home
 * (`bot-bundle-move.ts`). Its workers' records name their transcripts by absolute path in the owner's home; this build
 * reads them under the bundle's new place (`worker-storage-identity.ts`), the records themselves are never rewritten.
 * The bundle stays while a move would cut what other readers of those records still hold:
 * - `worker-records`: its workers are shared with another session of the home: an agent binding of the session (in its
 *   projection or its retention archives) names a worker transcript outside its bundle (a specialist another session's
 *   bundle holds, which the session claimed), or a specialist directory of the home names the session (a specialist
 *   born in its bundle, claimable by every session of the home);
 * - `worker-mail-pending`: work its load would deliver into a worker's transcript is still open: a worker mailbox of the
 *   bundle holds an undelivered task-bearing message, or a worker started for another worker of the session has a
 *   terminal handoff not yet delivered. An earlier build loading the session opens that transcript by its recorded
 *   path, which a moved bundle no longer holds; this build settles them in the owner's home, and a later load moves it;
 * - `records-unreadable`: one of these records could not be read, so nothing is decided: the bundle stays where it is,
 *   as an earlier build keeps it, and the next load decides again.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { type OrchestrationHome, orchestrationSessionDir } from "../../kernel/session/session-bundle-paths.ts";
import { isPendingTaskBearingMessage } from "../delegation/worker-mailbox-obligations.ts";
import { readWorkerMailboxRecord } from "../delegation/worker-mailbox-record.ts";
import { projectSpecialistsNameSession } from "../delegation/worker-project-directory.ts";
import { OrchestrationEventStore } from "../orchestration/event-store.ts";
import { readRetentionArchives, retentionArchiveDir } from "../orchestration/retention-archive.ts";
import { readTaskRuntimeProjection } from "../orchestration/task-runtime-reader.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { workerTerminalNotificationId } from "../orchestration/worker-terminal-notification.ts";
import { readBoundedDirectoryNamesSync } from "../util/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

/** Why the bundle stays in the owner's home; undefined when it moves. */
export type BundleWorkersStay =
	| { readonly reason: "worker-records" | "worker-mail-pending" }
	| { readonly reason: "records-unreadable"; readonly error: string };

const MAX_MAILBOX_FILES = 4096;

/** The worker transcripts the agent bindings of the session's retention archives name. */
function archivedWorkerTranscripts(store: OrchestrationEventStore, sessionId: string): string[] {
	const files: string[] = [];
	for (const archive of readRetentionArchives(retentionArchiveDir(store.rootDir)).archives) {
		if (archive.sessionId !== sessionId) continue;
		for (const agent of Object.values(archive.records.agents ?? {})) {
			if (!isPlainRecord(agent) || !isPlainRecord(agent.resumeContext))
				throw new Error("Archived agent binding is malformed.");
			const { provider, sessionFile } = agent.resumeContext;
			if (provider === "pi" && typeof sessionFile === "string" && sessionFile) files.push(sessionFile);
		}
	}
	return files;
}

/** The worker transcripts the session's agent bindings name: in its projection, and in its retention archives. */
function boundWorkerTranscripts(
	store: OrchestrationEventStore,
	projection: TaskRuntimeProjection | undefined,
	sessionId: string,
): string[] {
	if (!projection) return [];
	const files: string[] = [];
	for (const agent of Object.values(projection.agents)) {
		if (agent.resumeContext.provider === "pi" && agent.resumeContext.sessionFile)
			files.push(agent.resumeContext.sessionFile);
	}
	return [...files, ...archivedWorkerTranscripts(store, sessionId)];
}

/**
 * Whether a worker started for another worker of the session has a terminal handoff not yet delivered: the handoff is
 * delivered into the parent worker's transcript (`deliverWorkerTerminalHandoff`).
 */
function workerHandoffPending(projection: TaskRuntimeProjection): boolean {
	return Object.values(projection.attempts).some((attempt) => {
		const child = attempt.agentId ?? attempt.dispatch.logicalLaneId ?? attempt.taskId;
		const parent = projection.agents[child]?.parentAgentId ?? attempt.dispatch.parentAgentId;
		return (
			parent !== undefined &&
			projection.notifications[workerTerminalNotificationId(attempt.attemptId)]?.status !== "delivered"
		);
	});
}

/** Whether a worker mailbox of the bundle holds an undelivered task-bearing message. */
function workerMailPending(bundle: string): boolean {
	const dir = join(bundle, "worker-mailboxes");
	if (!existsSync(dir)) return false;
	// Lock directories and temporary files a dead writer left are not mailboxes; the move runs only once every holder is
	// proven dead.
	for (const name of readBoundedDirectoryNamesSync(dir, MAX_MAILBOX_FILES, "Worker mailbox directory")) {
		if (!name.endsWith(".json")) continue;
		const { mailbox } = readWorkerMailboxRecord(join(dir, name));
		if (!isPlainRecord(mailbox) || !Array.isArray(mailbox.messages))
			throw new Error(`Worker mailbox ${name} is malformed.`);
		if (mailbox.messages.some((message) => isPlainRecord(message) && isPendingTaskBearingMessage(message)))
			return true;
	}
	return false;
}

function decide(home: OrchestrationHome, sessionId: string): BundleWorkersStay | undefined {
	const bundle = resolve(orchestrationSessionDir(home, sessionId));
	const outside = (file: string) => {
		const offset = relative(bundle, resolve(file));
		return offset === "" || offset.startsWith("..") || isAbsolute(offset);
	};
	const store = new OrchestrationEventStore({ orchestrationHome: home, sessionId });
	const projection = existsSync(store.rootDir) ? readTaskRuntimeProjection(store) : undefined;
	if (
		boundWorkerTranscripts(store, projection, sessionId).some(outside) ||
		projectSpecialistsNameSession(home, sessionId)
	)
		return { reason: "worker-records" };
	if ((projection && workerHandoffPending(projection)) || workerMailPending(bundle))
		return { reason: "worker-mail-pending" };
	return undefined;
}

/** Why session `sessionId`'s bundle stays in `home` for its workers; undefined when it moves with them. */
export function bundleWorkersStay(home: OrchestrationHome, sessionId: string): BundleWorkersStay | undefined {
	try {
		return decide(home, sessionId);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		harnessLog.warn(
			"bots",
			"a bot session's worker records did not read; its bundle stays in the owner's home",
			() => ({
				sessionId,
				error: reason,
			}),
		);
		return { reason: "records-unreadable", error: reason };
	}
}
