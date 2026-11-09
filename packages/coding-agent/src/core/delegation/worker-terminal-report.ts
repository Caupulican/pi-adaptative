/**
 * The continuous chat's report of a worker's terminal: one entry per claim (or per terminal when no claim exists), written
 * once, shaped from the worker's own report when it made one and from its terminal status otherwise. The bot's turn outcome
 * is recorded alongside it when the terminal belongs to a bot. The coordinator supplies the roster store and the transcript
 * reference through its host port; the report never builds a worker or a store itself.
 */
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { BackgroundLaneControllerDeps } from "../background-lane-deps.ts";
import {
	CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE,
	type ContinuousChatWorkReportEntry,
} from "../memory/continuous-chat-ingest.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import type { BotRuntimeBindings } from "./bot-runtime-bindings.ts";
import type { PersistentBotTeamStore } from "./persistent-bot-team-store.ts";
import { getWorkerClaimSnapshots } from "./session-worker-claim.ts";
import { workerReportClaimText } from "./worker-report.ts";

/** The terminal of one worker lane or attempt, as the lane records it. */
export interface WorkerTerminalReportInput {
	laneId: string;
	attemptId?: string;
	status: string;
	completedAt?: string;
	reasonCode?: string;
	reasonDetail?: string;
}

/** What the report reads from the coordinator: the roster store and the transcript reference of the terminal's attempt. */
export interface WorkerTerminalReportHost {
	getBotTeamStore(): PersistentBotTeamStore;
	workerTranscriptReference(record: Pick<LaneRecord, "laneId" | "attemptId">): string | undefined;
}

/** Persists the terminal reports of the worker lanes of one session into its continuous chat. */
export class WorkerTerminalReport {
	private readonly deps: Pick<BackgroundLaneControllerDeps, "getSessionManager">;
	private readonly botBindings: Pick<BotRuntimeBindings, "alias" | "generationContext">;
	private readonly host: WorkerTerminalReportHost;

	constructor(
		deps: Pick<BackgroundLaneControllerDeps, "getSessionManager">,
		botBindings: Pick<BotRuntimeBindings, "alias" | "generationContext">,
		host: WorkerTerminalReportHost,
	) {
		this.deps = deps;
		this.botBindings = botBindings;
		this.host = host;
	}

	persist(name: string, terminal: WorkerTerminalReportInput): void {
		const entries = this.deps.getSessionManager().getEntries();
		const claim =
			terminal.attemptId === undefined
				? undefined
				: getWorkerClaimSnapshots(entries).find((candidate) => candidate.terminalAttemptId === terminal.attemptId);
		const claimId = terminal.attemptId ?? `lane:${terminal.laneId}:${terminal.completedAt ?? ""}:${terminal.status}`;
		if (
			entries.some(
				(entry) =>
					entry.type === "custom" &&
					entry.customType === CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE &&
					(entry.data as { claimId?: unknown } | undefined)?.claimId === claimId,
			)
		) {
			return;
		}
		const reason = terminal.reasonCode ? ` (${terminal.reasonCode})` : "";
		const detail = terminal.reasonDetail ? boundedRedactedDiagnosticText(terminal.reasonDetail) : undefined;
		const transcriptReference = this.host.workerTranscriptReference(terminal);
		const report: ContinuousChatWorkReportEntry = {
			version: 1,
			name,
			claimId,
			text: claim
				? workerReportClaimText(claim)
				: `Terminal status ${terminal.status}${reason}.${detail ? ` Diagnostic: ${detail}` : ""}`,
			timestamp: Date.now(),
			...(transcriptReference ? { transcriptReference } : {}),
		};
		this.deps.getSessionManager().appendCustomEntry(CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE, report);
		try {
			const context = this.botBindings.generationContext(name);
			const alias = context.agentId;
			if (!context.teamId && !this.botBindings.alias(name)) return;
			this.host.getBotTeamStore().recordBotTurnOutcome({
				agentId: alias,
				...(context.teamId ? { teamId: context.teamId, teamIncarnationId: context.teamIncarnationId } : {}),
				summary: report.text,
				transcriptRef: transcriptReference,
				timestamp: report.timestamp,
			});
		} catch {
			// Outcome recording is advisory; must not fail terminal report persistence
		}
	}
}
