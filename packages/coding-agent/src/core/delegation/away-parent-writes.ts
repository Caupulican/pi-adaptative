/**
 * The parent write port of a host that does not own the parent transcript (a parent opened away). It has no session
 * writer and no transcript reader: every write the parent must see is recorded on the worker's attempt
 * (`recordParentWrite`), and the parent imports those records exactly once when it next opens or sees the store change.
 * What the parent re-derives on its own (the lane-record projection, terminal handoffs, usage receipts) is not written
 * here at all. Findings nothing could settle go to the owner's follow-up document, as under a handoff. A write this
 * host cannot record (no attempt to carry it, or the attempt's outbox refuses it) is reported once, never dropped
 * silently.
 */

import { randomUUID } from "node:crypto";
import type { JsonObject } from "../autonomy/contracts.ts";
import type { DurableTaskRuntime } from "../orchestration/task-runtime.ts";
import type { AttemptParentWriteBody } from "../orchestration/task-runtime-state.ts";
import { appendUnsettledWorkerFollowUps, ownerFollowUpPath } from "../system-one/owner-question-routing.ts";
import type { ParentWriteOrigin, ParentWritePort } from "./parent-execution-context.ts";
import { snapshotHandoff } from "./worker-terminal-handoff-coordinator.ts";

/** A port call a parent opened away refuses by contract; the away dispatch preconditions keep it unreached. */
export class AwayParentWriteRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AwayParentWriteRefusal";
	}
}

export interface AwayParentWriteDeps {
	getRuntime(): Pick<DurableTaskRuntime, "recordParentWrite" | "getSnapshot">;
	getAgentDir(): string;
	getParentSessionId(): string;
	/** The host's wall clock, read from its timer source. */
	now(): number;
	/** The away host's diagnostics: warnings and every write this host cannot record. */
	report(message: string): void;
}

export type AwayParentWrites = Omit<ParentWritePort, "importParentWrite"> &
	Required<Pick<ParentWritePort, "notifyParentSession">>;

export function createAwayParentWrites(deps: AwayParentWriteDeps): AwayParentWrites {
	const reported = new Set<string>();
	const reportOnce = (message: string): void => {
		if (reported.has(message)) return;
		reported.add(message);
		deps.report(message);
	};
	/** Records one write on its attempt's outbox; returns its id, or undefined after reporting why it was not recorded. */
	const record = (attemptId: string | undefined, body: AttemptParentWriteBody, what: string): string | undefined => {
		if (!attemptId) {
			reportOnce(`A ${what} for the parent was not recorded: it names no worker attempt.`);
			return undefined;
		}
		const writeId = randomUUID();
		try {
			deps.getRuntime().recordParentWrite(attemptId, writeId, body);
			return writeId;
		} catch (error) {
			// The outbox is bounded per attempt and validates each body; a refusal is the attempt's, reported once.
			reportOnce(
				`A ${what} of attempt ${attemptId} was not recorded for the parent: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	};
	const notice = (customType: string, text: string, origin: ParentWriteOrigin | undefined): void => {
		record(origin?.attemptId, { kind: "notice", customType, text }, `${customType} notice`);
	};
	return {
		emit: (event) => {
			// Only a warning carries something an operator must see; the rest drives an interactive view this host has not.
			if (event.type === "warning") deps.report(event.message);
		},
		notifyParentSession: notice,
		// The terminal stays in the durable notification store; the parent's coordinator replays it when it opens.
		notifyWorkerTerminalHandoff: async () => {},
		// Telemetry observes the foreground; it is not evidence and nothing reads it back.
		emitAutonomyTelemetry: () => {},
		saveWorkerClaimSnapshot: (claim, request, options) => {
			record(
				options?.attemptId ?? claim.terminalAttemptId,
				{
					kind: "worker_claim",
					claim: structuredClone(claim) as unknown as JsonObject,
					...(request ? { request: structuredClone(request) as unknown as JsonObject } : {}),
					...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
				},
				"worker claim",
			);
		},
		reportWorkerTerminal: (handoff) => {
			try {
				const writeId = record(
					handoff.terminalAttemptId,
					{ kind: "terminal_report", handoff: snapshotHandoff(handoff) as unknown as JsonObject },
					"terminal report",
				);
				return writeId
					? { ok: true }
					: { ok: false, reason: "the terminal report was not recorded for the parent" };
			} catch (error) {
				return { ok: false, reason: error instanceof Error ? error.message : String(error) };
			}
		},
		// The parent re-derives the lane-record projection from the attempt's pending notification.
		appendLaneRecordSnapshot: () => {},
		appendSessionTaskProfile: () => {
			throw new AwayParentWriteRefusal(
				"A parent opened away creates no session task profile: only the root's delegate tool does.",
			);
		},
		// An away dispatch is a saved intent whose origin is pinned, so admission never captures one from the transcript.
		captureReceiptOrigin: () => {
			throw new AwayParentWriteRefusal(
				"A parent opened away captures no receipt origin: only a dispatch with a pinned origin runs away.",
			);
		},
		// The owner is not in the loop of a run away, exactly as under a handoff: what stays open goes to the parent's
		// durable follow-up document (not its transcript), which the parent announces at the owner's next prompt.
		recordUnsettledForOwner: (items, origin) => {
			if (items.length === 0) return undefined;
			const attemptId = origin?.attemptId;
			const request = attemptId
				? deps.getRuntime().getSnapshot().attempts[attemptId]?.dispatch.instructions
				: undefined;
			try {
				return appendUnsettledWorkerFollowUps(
					ownerFollowUpPath(deps.getAgentDir(), deps.getParentSessionId()),
					items,
					request ?? "",
					new Date(deps.now()).toISOString(),
				);
			} catch (error) {
				reportOnce(
					`Unsettled findings of attempt ${attemptId ?? "(unknown)"} were not written for the owner: ${error instanceof Error ? error.message : String(error)}`,
				);
				return undefined;
			}
		},
		// Usage stays in the attempt's durable receipts; the parent's receipt delivery charges it when it opens. This is
		// the normal path of every run away, not a refused write, so nothing is reported.
		addSpawnedUsage: () => undefined,
	};
}
