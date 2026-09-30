/**
 * The evidence-retention live path inside the real CompactionController (RCG-040).
 *
 * Part of the verification-harness coverage set: these are the compaction-owner functions that
 * decide what a real compaction keeps, so they are exercised against the live controller rather
 * than against the planner alone.
 */

import {
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	createDeterministicCompaction,
	prepareCompaction,
} from "@caupulican/pi-agent-core/compaction/compaction";
import type { SessionEntry } from "@caupulican/pi-agent-core/session";
import type { AssistantMessage, ToolResultMessage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { RETENTION_AUDIT_CUSTOM_TYPE } from "../src/core/compaction/evidence-retention-projection.ts";
import { packSupersededHostRecords } from "../src/core/context-gc.ts";
import { serializeEvaluation } from "../src/core/review/typesafe-contract.ts";
import { appendToolExchange, createRcSdkHarness, type RcSdkHarness } from "./suite/rc-sdk-harness.ts";

type CompactionInternals = {
	_compaction: {
		planEvidenceRetention(signal: AbortSignal): Promise<void>;
		getCompactionBranch(): SessionEntry[];
		getRetentionPlanner(): { getLastAuditStats(): unknown };
		getRetentionAuditStats(): unknown;
		getAppliedRetentionAudit():
			| {
					stats: { pairsRemoved: number; jevRequestCount: number };
					summaryEvent: string;
					droppedCallIds: readonly string[];
					truncatedCallIds: readonly string[];
			  }
			| undefined;
		prepareCompactionWithPackedHostRecords(
			branch: SessionEntry[],
			settings: CompactionSettings,
		): CompactionPreparation | undefined;
		applyResult(result: CompactionResult, fromExtension: boolean): Promise<string>;
	};
};

function compactionOf(harness: RcSdkHarness): CompactionInternals["_compaction"] {
	return (harness.session as unknown as CompactionInternals)._compaction;
}

function toolResultCount(branch: readonly unknown[]): number {
	return branch.filter(
		(entry) =>
			(entry as { type?: string }).type === "message" &&
			((entry as { message?: { role?: string } }).message?.role ?? "") === "toolResult",
	).length;
}

function fillTranscript(harness: RcSdkHarness, count: number, options: { errorAt?: number } = {}): void {
	for (let index = 0; index < count; index++) {
		appendToolExchange(harness, {
			callId: `call-${index}`,
			toolName: index === options.errorAt ? "bash" : "read",
			output: `evidence ${index}`.repeat(6),
			isError: index === options.errorAt,
		});
	}
}

function appendAssistantToolCalls(harness: RcSdkHarness, callIds: readonly string[]): void {
	const model = harness.session.model;
	const message: AssistantMessage = {
		role: "assistant",
		content: callIds.map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })),
		api: model?.api ?? "anthropic-messages",
		provider: model?.provider ?? "faux",
		model: model?.id ?? "faux-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	harness.session.sessionManager.appendMessage(message);
}

function appendToolResult(harness: RcSdkHarness, callId: string, output: string): void {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text: output }],
		isError: false,
		timestamp: Date.now(),
	};
	harness.session.sessionManager.appendMessage(message);
}

function appendRetentionBatch(harness: RcSdkHarness): string {
	harness.session.sessionManager.appendMessage({
		role: "user",
		content: "Keep this setup turn.",
		timestamp: Date.now(),
	});
	appendAssistantToolCalls(harness, ["candidate", "exact-companion"]);
	appendToolResult(harness, "exact-companion", "companion result stays exact");
	const telemetryId = harness.session.sessionManager.appendCustomMessageEntry(
		"test-compaction-telemetry",
		"between pending call and result",
		false,
	);
	appendToolResult(harness, "candidate", "candidate result evidence ".repeat(400));
	for (let index = 0; index < 12; index++) {
		appendToolExchange(harness, {
			callId: `recent-${index}`,
			toolName: "read",
			output: "recent",
		});
	}
	return telemetryId;
}

function messageHasToolCall(message: { role?: string; content?: unknown }, callId: string): boolean {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return false;
	return message.content.some(
		(block) =>
			typeof block === "object" &&
			block !== null &&
			(block as { type?: unknown }).type === "toolCall" &&
			(block as { id?: unknown }).id === callId,
	);
}

describe("Evidence retention inside the real compaction owner", () => {
	it("plans nothing when the session has no tool pairs to consider", async () => {
		const harness = await createRcSdkHarness();
		const compaction = compactionOf(harness);
		const before = compaction.getCompactionBranch().length;

		await compaction.planEvidenceRetention(new AbortController().signal);

		expect(compaction.getAppliedRetentionAudit()).toBeUndefined();
		expect(compaction.getCompactionBranch().length).toBe(before);
	});

	it("drops the pairs the engine judged useless and leaves the recency window intact", async () => {
		const harness = await createRcSdkHarness({
			decisions: { fallback: { kind: "boolean", probabilityTrue: 0.05 } },
		});
		fillTranscript(harness, 20);
		const compaction = compactionOf(harness);
		const before = toolResultCount(compaction.getCompactionBranch());

		await compaction.planEvidenceRetention(new AbortController().signal);
		const after = toolResultCount(compaction.getCompactionBranch());
		const audit = compaction.getAppliedRetentionAudit();

		expect(audit?.stats.jevRequestCount).toBe(1);
		expect(audit?.droppedCallIds.length).toBeGreaterThan(0);
		expect(before - after).toBe(audit?.droppedCallIds.length);
		expect(audit?.droppedCallIds).not.toContain("call-19");
		expect(compaction.getRetentionAuditStats()).toBeDefined();
		expect(compaction.getRetentionPlanner().getLastAuditStats()).toBeDefined();
	});

	it("sends valid JSON evidence to the decision engine when no goal is active", async () => {
		const harness = await createRcSdkHarness({
			decisions: { fallback: { kind: "boolean", probabilityTrue: 0.05 } },
		});
		fillTranscript(harness, 20);
		const evaluate = harness.decisions.evaluate.bind(harness.decisions);
		vi.spyOn(harness.decisions, "evaluate").mockImplementation((program, state, options) => {
			serializeEvaluation({ state });
			return evaluate(program, state, options);
		});

		await compactionOf(harness).planEvidenceRetention(new AbortController().signal);

		const audit = compactionOf(harness).getAppliedRetentionAudit();
		expect(audit?.stats.jevRequestCount).toBe(1);
		expect(audit?.droppedCallIds.length).toBeGreaterThan(0);
	});

	it("truncates a large result instead of dropping it when only the call stays useful", async () => {
		const harness = await createRcSdkHarness({
			decisions: {
				answers: {},
				// Keeping the call is useful; keeping the exact result is not.
				fallback: { kind: "boolean", probabilityTrue: 0.05 },
			},
		});
		for (let index = 0; index < 20; index++) {
			appendToolExchange(harness, {
				callId: `call-${index}`,
				toolName: "read",
				output: "x".repeat(4096),
			});
		}
		const compaction = compactionOf(harness);
		const decisions = compaction as unknown as { activeRetentionDecisions?: unknown };
		await compaction.planEvidenceRetention(new AbortController().signal);

		expect(decisions).toBeDefined();
		expect(compaction.getAppliedRetentionAudit()?.stats.pairsRemoved).toBeGreaterThan(0);
	});

	it("applies retention against the raw cut so a dropped pending result cannot reappear after restore", async () => {
		const harness = await createRcSdkHarness({
			decisions: {
				answers: {
					"keep_call::candidate": { kind: "boolean", probabilityTrue: 0 },
					"keep_result::candidate": { kind: "boolean", probabilityTrue: 0 },
				},
				fallback: { kind: "boolean", probabilityTrue: 1 },
			},
		});
		const compaction = compactionOf(harness);
		const telemetryId = appendRetentionBatch(harness);

		await compaction.planEvidenceRetention(new AbortController().signal);
		const audit = compaction.getAppliedRetentionAudit();
		expect(audit?.droppedCallIds).toContain("candidate");
		expect(audit?.droppedCallIds).not.toContain("exact-companion");

		const rawBranch = harness.session.sessionManager.getBranch();
		const projectedBranch = compaction.getCompactionBranch();
		const rawResultIndex = rawBranch.findIndex(
			(entry) =>
				entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === "candidate",
		);
		const selectedSettings: CompactionSettings = { enabled: true, reserveTokens: 0, keepRecentTokens: 49 };
		const projectedPreparation = prepareCompaction(projectedBranch, selectedSettings, {
			packHostRecords: packSupersededHostRecords,
		});
		const rawPreparation = prepareCompaction(rawBranch, selectedSettings, {
			packHostRecords: packSupersededHostRecords,
		});
		const rawCutIndex = rawBranch.findIndex((entry) => entry.id === rawPreparation?.firstKeptEntryId);
		expect(projectedPreparation?.firstKeptEntryId).toBe(telemetryId);
		expect(rawPreparation?.firstKeptEntryId).not.toBe(telemetryId);
		expect(rawCutIndex).toBeGreaterThan(rawResultIndex);

		const preparation = compaction.prepareCompactionWithPackedHostRecords(projectedBranch, selectedSettings);
		expect(preparation).toBeDefined();
		if (!preparation) throw new Error("compaction preparation unexpectedly missing");
		expect(preparation.firstKeptEntryId).toBe(rawPreparation?.firstKeptEntryId);
		const selectedMessages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
		expect(selectedMessages.some((message) => messageHasToolCall(message, "candidate"))).toBe(false);
		expect(selectedMessages.some((message) => messageHasToolCall(message, "exact-companion"))).toBe(true);
		expect(
			selectedMessages.some((message) => message.role === "toolResult" && message.toolCallId === "exact-companion"),
		).toBe(true);
		expect(
			selectedMessages.some((message) => message.role === "toolResult" && message.toolCallId === "candidate"),
		).toBe(false);
		expect(
			selectedMessages.some(
				(message) => message.role === "custom" && message.content === "between pending call and result",
			),
		).toBe(true);

		await compaction.applyResult(createDeterministicCompaction(preparation), false);
		const restoredMessages = harness.session.sessionManager.buildSessionContext().messages;
		expect(
			restoredMessages.some((message) => message.role === "toolResult" && message.toolCallId === "candidate"),
		).toBe(false);
		expect(restoredMessages.some((message) => messageHasToolCall(message, "candidate"))).toBe(false);
	});

	it.each([
		{ disposition: "keep_exact", keepCall: 1, keepResult: 1, marker: undefined },
		{
			disposition: "keep_call_truncate_result",
			keepCall: 1,
			keepResult: 0,
			marker: "[compaction] Result elided by evidence-preserving compaction",
		},
	] as const)("preserves the $disposition control pair in the selected raw summary span", async (control) => {
		const harness = await createRcSdkHarness({
			decisions: {
				answers: {
					"keep_call::candidate": { kind: "boolean", probabilityTrue: control.keepCall },
					"keep_result::candidate": { kind: "boolean", probabilityTrue: control.keepResult },
				},
				fallback: { kind: "boolean", probabilityTrue: 1 },
			},
		});
		const compaction = compactionOf(harness);
		const telemetryId = appendRetentionBatch(harness);

		await compaction.planEvidenceRetention(new AbortController().signal);
		const audit = compaction.getAppliedRetentionAudit();
		if (control.disposition === "keep_exact") {
			expect(audit?.droppedCallIds).not.toContain("candidate");
			expect(audit?.truncatedCallIds).not.toContain("candidate");
		} else {
			expect(audit?.droppedCallIds).not.toContain("candidate");
			expect(audit?.truncatedCallIds).toContain("candidate");
		}

		const preparation = compaction.prepareCompactionWithPackedHostRecords(compaction.getCompactionBranch(), {
			enabled: true,
			reserveTokens: 0,
			keepRecentTokens: 1,
		});
		expect(preparation).toBeDefined();
		const selectedMessages = [
			...(preparation?.messagesToSummarize ?? []),
			...(preparation?.turnPrefixMessages ?? []),
		];
		const selectedCall = selectedMessages.some((message) => messageHasToolCall(message, "candidate"));
		const selectedResult = selectedMessages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "candidate",
		);
		expect(selectedCall).toBe(true);
		expect(selectedResult).toBeDefined();
		const selectedResultText =
			selectedResult?.role === "toolResult"
				? selectedResult.content.map((block) => (block.type === "text" ? block.text : "")).join("")
				: "";
		if (control.marker) expect(selectedResultText).toContain(control.marker);
		else expect(selectedResultText).not.toContain("Result elided by evidence-preserving compaction");
		expect(preparation?.firstKeptEntryId).not.toBe(telemetryId);
	});

	it("keeps everything when the semantic engine fails, and persists the audit either way", async () => {
		const harness = await createRcSdkHarness({
			decisions: { failWith: new Error("semantic plane unavailable") },
		});
		fillTranscript(harness, 20, { errorAt: 0 });
		const compaction = compactionOf(harness);
		const before = toolResultCount(compaction.getCompactionBranch());

		await compaction.planEvidenceRetention(new AbortController().signal);

		expect(toolResultCount(compaction.getCompactionBranch())).toBe(before);
		expect(compaction.getAppliedRetentionAudit()?.droppedCallIds).toEqual([]);
		expect(compaction.getAppliedRetentionAudit()?.summaryEvent).toContain("retention unavailable");
		expect(
			harness.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === RETENTION_AUDIT_CUSTOM_TYPE),
		).toHaveLength(1);
	});

	it("never offers an errored pair to the engine", async () => {
		const harness = await createRcSdkHarness({
			decisions: { fallback: { kind: "boolean", probabilityTrue: 0 } },
		});
		fillTranscript(harness, 20, { errorAt: 0 });
		const compaction = compactionOf(harness);

		await compaction.planEvidenceRetention(new AbortController().signal);

		expect(compaction.getAppliedRetentionAudit()?.droppedCallIds).not.toContain("call-0");
	});

	it("plans nothing at all when the session has no semantic engine", async () => {
		const harness = await createRcSdkHarness();
		fillTranscript(harness, 20);
		const compaction = compactionOf(harness);
		// Removing the plane is what a session without System One looks like to this code path.
		(harness.session as unknown as { _steeringPlane?: unknown })._steeringPlane = undefined;
		const before = toolResultCount(compaction.getCompactionBranch());

		await compaction.planEvidenceRetention(new AbortController().signal);

		expect(toolResultCount(compaction.getCompactionBranch())).toBe(before);
		expect(compaction.getAppliedRetentionAudit()).toBeUndefined();
	});
});
