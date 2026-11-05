/**
 * The transcript half of the foreground `ParentWritePort`: the appends the session's background-lane controller makes
 * with the session's own writer, and the import of writes another host recorded for this parent.
 *
 * An import lands each recorded write exactly once. Under the parent's session-file mutation lock it looks for the entry
 * that write already produced (its `parentWriteId` marker, or a terminal report's attempt key) and appends only when
 * none exists. The caller acknowledges the record after the lock is released, and only once the entry is physically
 * persisted, so a crash between append and acknowledgement leaves an entry the next import finds.
 */

import type { SessionEntry, SessionManager } from "../../kernel/node.ts";
import { withSessionFileMutation } from "../../kernel/session/session-file-admission.ts";
import type { WorkerClaim, WorkerRequest } from "../autonomy/contracts.ts";
import { appendLaneRecordSnapshot } from "../autonomy/session-lane-record.ts";
import { CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE } from "../memory/continuous-chat-ingest.ts";
import { SESSION_TASK_PROFILE_CUSTOM_TYPE } from "../orchestration/session-task-profile-store.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import type { AttemptParentWrite } from "../orchestration/task-runtime-state.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { ParentWriteImport, ParentWritePort } from "./parent-execution-context.ts";
import { WORKER_CLAIM_CUSTOM_TYPE } from "./session-worker-claim.ts";
import { isWorkerClaim } from "./worker-claim.ts";
import { captureWorkerReceiptOrigin } from "./worker-receipt-origin.ts";
import { snapshotHandoff, type WorkerTerminalHandoff } from "./worker-terminal-handoff-coordinator.ts";

/** The foreground always imports and always answers a terminal report (a session without a report owner logs none). */
export type ForegroundTranscriptWrites = Pick<
	ParentWritePort,
	"appendLaneRecordSnapshot" | "appendSessionTaskProfile" | "captureReceiptOrigin"
> &
	Required<Pick<ParentWritePort, "importParentWrite" | "reportWorkerTerminal">>;

export interface ForegroundTranscriptWriteDeps
	extends Pick<ParentWritePort, "saveWorkerClaimSnapshot" | "notifyParentSession"> {
	getSessionManager(): SessionManager;
	getAgentDir(): string;
	/** The session's project-chat report of a taken terminal handoff; it may throw. */
	reportWorkerTerminal?(handoff: Readonly<WorkerTerminalHandoff>): void;
	warn(message: string): void;
}

/** The entry a recorded write produced in this transcript, if it already landed. */
function landedEntry(
	entries: readonly SessionEntry[],
	write: AttemptParentWrite,
	handoff: WorkerTerminalHandoff | undefined,
): SessionEntry | undefined {
	return entries.find((entry) => {
		if (write.body.kind === "notice")
			return (
				entry.type === "custom_message" &&
				isPlainRecord(entry.details) &&
				entry.details.parentWriteId === write.writeId
			);
		if (entry.type !== "custom" || !isPlainRecord(entry.data)) return false;
		if (write.body.kind === "worker_claim")
			return entry.customType === WORKER_CLAIM_CUSTOM_TYPE && entry.data.parentWriteId === write.writeId;
		// A terminal report is keyed by its attempt: the report owner never logs one attempt twice.
		return (
			entry.customType === CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE &&
			entry.data.claimId === handoff?.terminalAttemptId
		);
	});
}

/**
 * What this parent can apply of a recorded write, or why it never can: a record this parent can never land is refused
 * once instead of holding its attempt's terminal forever.
 */
function admitWrite(
	write: AttemptParentWrite,
	deps: Pick<ForegroundTranscriptWriteDeps, "notifyParentSession" | "reportWorkerTerminal">,
): { handoff?: WorkerTerminalHandoff } | { refused: string } {
	const body = write.body;
	if (body.kind === "worker_claim") {
		if (!isWorkerClaim(body.claim)) return { refused: "it holds an invalid claim" };
		const request = body.request;
		if (request !== undefined && typeof request.id !== "string") return { refused: "it holds an invalid request" };
		return {};
	}
	if (body.kind === "notice")
		return deps.notifyParentSession ? {} : { refused: "this parent takes no session notices" };
	if (!deps.reportWorkerTerminal) return { refused: "this parent takes no worker terminal reports" };
	try {
		// The durable shape is the handoff coordinator's own; it rejects any field outside that contract.
		return { handoff: snapshotHandoff(body.handoff as unknown as WorkerTerminalHandoff) };
	} catch (error) {
		return {
			refused: `it holds an invalid terminal handoff: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export function createForegroundTranscriptWrites(deps: ForegroundTranscriptWriteDeps): ForegroundTranscriptWrites {
	// A notice is delivered as a steer, which persists when the parent takes it; until then this process does not
	// offer it again. A restart before it persisted offers it once more, because it never landed.
	const offeredNotices = new Set<string>();
	const reportedFailures = new Set<string>();

	const reportTerminal = deps.reportWorkerTerminal;

	const warnOnce = (message: string): void => {
		if (reportedFailures.has(message)) return;
		reportedFailures.add(message);
		deps.warn(message);
	};

	/** Applies an admitted write; `admitWrite` already proved the claim, the request and the needed capability. */
	const apply = (write: AttemptParentWrite, handoff: WorkerTerminalHandoff | undefined): void => {
		const body = write.body;
		if (body.kind === "worker_claim") {
			deps.saveWorkerClaimSnapshot(body.claim as unknown as WorkerClaim, body.request as unknown as WorkerRequest, {
				...(body.cwd === undefined ? {} : { cwd: body.cwd }),
				parentWriteId: write.writeId,
			});
			return;
		}
		if (body.kind === "notice") {
			if (offeredNotices.has(write.writeId)) return;
			offeredNotices.add(write.writeId);
			deps.notifyParentSession?.(body.customType, body.text, { parentWriteId: write.writeId });
			return;
		}
		if (handoff) reportTerminal?.(handoff);
	};

	return {
		reportWorkerTerminal: (handoff) => {
			try {
				reportTerminal?.(handoff);
				return { ok: true };
			} catch (error) {
				return { ok: false, reason: error instanceof Error ? error.message : String(error) };
			}
		},
		appendLaneRecordSnapshot: (record) => {
			appendLaneRecordSnapshot(deps.getSessionManager(), record);
		},
		appendSessionTaskProfile: (record) => {
			deps.getSessionManager().appendCustomEntry(SESSION_TASK_PROFILE_CUSTOM_TYPE, record);
		},
		captureReceiptOrigin: (assertOuterCurrent, anchor) =>
			captureWorkerReceiptOrigin(deps.getSessionManager(), assertOuterCurrent, anchor),
		importParentWrite: (attemptId, write): ParentWriteImport => {
			const session = deps.getSessionManager();
			const file = session.getSessionFile();
			// Only a persisted parent proves an import landed; an uncertain one is retried on the next pass.
			if (!file || session.isPersistenceStateUncertain()) return "pending";
			const admitted = admitWrite(write, deps);
			if ("refused" in admitted) {
				warnOnce(`Parent write ${write.writeId} of attempt ${attemptId} is refused: ${admitted.refused}.`);
				return "refused";
			}
			try {
				return withSessionFileMutation(deps.getAgentDir(), file, session.getSessionId(), "append", () => {
					if (!landedEntry(session.getEntries(), write, admitted.handoff)) apply(write, admitted.handoff);
					session.flushBufferedEntries();
					const landed = landedEntry(session.getEntries(), write, admitted.handoff);
					return landed && session.isEntryPersisted(landed.id) ? "imported" : "pending";
				});
			} catch (error) {
				warnOnce(
					`Parent write ${write.writeId} of attempt ${attemptId} stays pending: ${error instanceof Error ? error.message : String(error)}`,
				);
				return "pending";
			}
		},
	};
}

/**
 * Import every write other hosts recorded for this parent, in record order per attempt. An attempt stops at its first
 * write still pending, so a later write never lands before an earlier one; a refused write was reported and is
 * acknowledged so it cannot hold its attempt. Returns the attempts still holding writes: their terminals are not
 * published here until those writes land.
 */
export function importRecordedParentWrites(
	runtime: Pick<DurableTaskRuntime, "getSnapshot" | "acknowledgeParentWrite">,
	importWrite: NonNullable<ParentWritePort["importParentWrite"]>,
	warn: (message: string) => void,
): ReadonlySet<string> {
	const holding = new Set<string>();
	for (const attempt of Object.values(runtime.getSnapshot().attempts)) {
		if (!attempt.parentWrites) continue;
		for (const write of Object.values(attempt.parentWrites).sort((left, right) => left.sequence - right.sequence)) {
			if (importWrite(attempt.attemptId, write) === "pending") {
				holding.add(attempt.attemptId);
				break;
			}
			try {
				runtime.acknowledgeParentWrite(attempt.attemptId, write.writeId);
			} catch (error) {
				// The entry landed; the next pass finds it and acknowledges again.
				warn(
					`Parent write ${write.writeId} of attempt ${attempt.attemptId} landed but is not acknowledged yet: ${error instanceof Error ? error.message : String(error)}`,
				);
				holding.add(attempt.attemptId);
				break;
			}
		}
	}
	return holding;
}
