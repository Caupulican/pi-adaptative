/**
 * Acceptance test: the incremental per-message memo `ContextPipeline.runContextAudit` /
 * `estimateCurrentContextTokens` build on top of `context/context-audit.ts`'s `ContextAuditMemo`
 * seam. Equivalence is the bar (see docs/plan §3): the memoized hot path must be byte-identical
 * to a forced full recompute for the same input, across a realistic multi-round-trip turn that
 * includes a compaction rewrite (new summary object + shifted-index survivor) and a branch
 * switch (an entirely different message array) -- both of which must invalidate cleanly with no
 * explicit reset. A spy on the underlying expensive per-message primitives
 * (`estimateTokensFromText`/`estimateByteLength` for the audit, `estimateTokens` for the token
 * estimate) proves the expensive work is skipped for unchanged messages on the 2nd+ round trip.
 *
 * Each round below does two `runContextAudit`/`estimateCurrentContextTokens` calls: the real
 * (memoized) one, then -- after forcibly clearing the memo -- a "forced full recompute" one used
 * only to assert byte-identical equivalence. Both calls tick the spies, so the perf assertions
 * always read the spy's call-count DELTA across just the first (memoized) call, captured before
 * the memo is cleared -- not the cumulative count, which would double-count the deliberately
 * cold second call.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import * as agentNode from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextAuditReport } from "../src/core/context/context-audit.ts";
import * as contextItemModule from "../src/core/context/context-item.ts";
import { ContextPipeline, type ContextPipelineDeps } from "../src/core/context-pipeline.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createPipeline(turnIndexRef: { value: number }): ContextPipeline {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-context-incremental-"));
	tempDirs.push(agentDir);
	const sessionManager = {
		getSessionId: () => "session-incremental",
		getBranch: () => [] as SessionEntry[],
	} as unknown as SessionManager;
	return new ContextPipeline({
		getTurnIndex: () => turnIndexRef.value,
		getSessionManager: () => sessionManager,
		getSettingsManager: () => ({}) as ReturnType<ContextPipelineDeps["getSettingsManager"]>,
		getModelRegistry: () => ({}) as ReturnType<ContextPipelineDeps["getModelRegistry"]>,
		getModel: () => undefined,
		getAgentDir: () => agentDir,
		getCwd: () => agentDir,
		getActiveToolNames: () => [],
		isDisposed: () => false,
		getMemoryManager: () => ({}) as ReturnType<ContextPipelineDeps["getMemoryManager"]>,
		addSpawnedUsage: () => undefined,
		runIsolatedCompletion: async () => {
			throw new Error("not used");
		},
	});
}

function userMessage(text: string, timestamp: number): AgentMessage {
	return { role: "user", content: text, timestamp };
}

function emptyCost() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

/** An assistant message that never counts as a usable "usage anchor" (aborted), so
 * `estimateContextTokensMemoized` always takes the sum-over-all-messages branch -- the branch
 * that makes the per-message memo's growing-array reuse directly observable. */
function assistantMessageNoUsage(text: string, timestamp: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: emptyCost() },
		stopReason: "aborted",
		timestamp,
	} as AgentMessage;
}

function assistantMessageWithUsage(text: string, timestamp: number, totalTokens: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: emptyCost() },
		stopReason: "stop",
		timestamp,
	} as AgentMessage;
}

function toolResultMessage(toolCallId: string, text: string, timestamp: number, artifactId?: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "grep",
		content: [{ type: "text", text }],
		details: artifactId ? { artifactId } : undefined,
		isError: false,
		timestamp,
	} as AgentMessage;
}

/** Clears a private memo field via the same cast-to-reach-private-field pattern already used by
 * this suite (see context-pipeline-entry-lookup.test.ts) to force a full, non-memoized
 * recompute -- the "no-memo recompute variant" the equivalence bar calls for. */
function clearMemo(pipeline: ContextPipeline, field: "_auditMemo" | "_tokenMemo"): void {
	(pipeline as unknown as Record<string, Map<unknown, unknown>>)[field].clear();
}

function memoSize(pipeline: ContextPipeline, field: "_auditMemo" | "_tokenMemo"): number {
	return (pipeline as unknown as Record<string, Map<unknown, unknown>>)[field].size;
}

describe("ContextPipeline incremental memo: audit", () => {
	it("is byte-identical to a forced full recompute across a multi-round-trip turn with compaction and a branch switch, and skips expensive work for unchanged messages", () => {
		const turnIndexRef = { value: 0 };
		const pipeline = createPipeline(turnIndexRef);
		const store = pipeline.getToolArtifactStore();
		const { ref: artifactRef } = store.write({
			kind: "tool_output",
			content: "artifact payload".repeat(50),
			toolName: "grep",
			createdAtTurn: 2,
			reproducible: true,
		});

		const tokenizeSpy = vi.spyOn(contextItemModule, "estimateTokensFromText");
		const byteSpy = vi.spyOn(contextItemModule, "estimateByteLength");

		/** Runs the memoized hot path, records the expensive-work delta it alone incurred, then
		 * forces a full recompute (cold memo) and asserts it is byte-identical to the memoized
		 * result. Returns the memoized report plus that round's expensive-call delta. */
		function auditRound(messages: AgentMessage[]): {
			report: ContextAuditReport;
			tokenizeCalls: number;
			byteCalls: number;
		} {
			const tokenizeBefore = tokenizeSpy.mock.calls.length;
			const byteBefore = byteSpy.mock.calls.length;
			const memoized = pipeline.runContextAudit(messages);
			const tokenizeCalls = tokenizeSpy.mock.calls.length - tokenizeBefore;
			const byteCalls = byteSpy.mock.calls.length - byteBefore;
			const memoizedSnapshot = structuredClone(memoized);
			clearMemo(pipeline, "_auditMemo");
			const forcedFull = pipeline.runContextAudit(messages); // cold: touches the spies again, ignored below
			expect(forcedFull).toEqual(memoizedSnapshot);
			return { report: memoized, tokenizeCalls, byteCalls };
		}

		// Round 1: three tool-call round trips' worth of history in one shot (first pass -- cold memo).
		const tc1 = toolResultMessage("call-1", "first tool output", 10);
		const tc2 = toolResultMessage("call-2", "second tool output", 20);
		const tc3 = toolResultMessage("call-3", "third tool output, artifact-backed", 30, artifactRef.id);
		let messages: AgentMessage[] = [
			userMessage("go", 0),
			assistantMessageNoUsage("working", 5),
			tc1,
			assistantMessageNoUsage("still working", 15),
			tc2,
			assistantMessageNoUsage("almost done", 25),
			tc3,
		];
		let round = auditRound(messages);
		expect(round.tokenizeCalls).toBe(3); // tc1, tc2, tc3 all cold
		expect(round.byteCalls).toBe(3);

		// Round 2 (2nd round trip on a WARM memo): append exactly one new toolResult. Only the
		// new message should trigger the expensive text-extraction/estimate work.
		turnIndexRef.value = 1;
		const tc4 = toolResultMessage("call-4", "fourth tool output", 40);
		messages = [...messages, assistantMessageNoUsage("continuing", 35), tc4];
		round = auditRound(messages);
		expect(round.tokenizeCalls).toBe(1);
		expect(round.byteCalls).toBe(1);

		// Round 3: append one more. Still only the new message recomputes; the artifact-backed
		// item's createdAtTurn must stay pinned to the artifact's real capture turn (2) even
		// though the live turnIndex has moved on to 2.
		turnIndexRef.value = 2;
		const tc5 = toolResultMessage("call-5", "fifth tool output", 50);
		messages = [...messages, assistantMessageNoUsage("wrapping up", 45), tc5];
		round = auditRound(messages);
		expect(round.tokenizeCalls).toBe(1);
		expect(round.byteCalls).toBe(1);
		const artifactItem = round.report.items.find((entry) => entry.toolCallId === "call-3");
		expect(artifactItem?.item.createdAtTurn).toBe(2); // the artifact's own createdAtTurn, not live turnIndex
		const nonArtifactItem = round.report.items.find((entry) => entry.toolCallId === "call-5");
		expect(nonArtifactItem?.item.createdAtTurn).toBe(2); // live turnIndex (2), freshly derived

		// Round 4: simulate a compaction rewrite. A brand-new summary message object replaces
		// the discarded prefix (tc1/tc2 are gone); tc3 (artifact-backed), tc4, and tc5 SURVIVE
		// with the SAME object identity but each at a SHIFTED index (tc3: 6->1, tc4: 8->3, tc5:
		// 10->4) -- the index guard must treat every one of them as a miss (not silently reuse a
		// stale messageIndex). Only tc6 is a genuinely new object.
		turnIndexRef.value = 3;
		const compactionSummary = userMessage("(compaction summary)", 100);
		const tc6 = toolResultMessage("call-6", "sixth tool output, post-compaction", 60);
		messages = [compactionSummary, tc3, assistantMessageNoUsage("post-compaction", 55), tc4, tc5, tc6];
		round = auditRound(messages);
		expect(round.tokenizeCalls).toBe(4); // tc3, tc4, tc5 (index-guard misses) + tc6 (new)
		expect(round.byteCalls).toBe(4);
		const survivorItem = round.report.items.find((entry) => entry.toolCallId === "call-3");
		// The artifact's createdAtTurn is still pinned, unaffected by the reshuffle.
		expect(survivorItem?.item.createdAtTurn).toBe(2);

		// Round 4b (same array, next round trip, memo now warm at THESE indices): nothing
		// changed -> zero expensive recomputation.
		turnIndexRef.value = 4;
		round = auditRound(messages);
		expect(round.tokenizeCalls).toBe(0);
		expect(round.byteCalls).toBe(0);
		expect(memoSize(pipeline, "_auditMemo")).toBe(4); // tc3, tc4, tc5, tc6 -- no stale entries retained

		// Round 5: branch switch -- an entirely unrelated message array (different session
		// branch/resume). Every toolResult is a fresh object -> all misses; the memo must not
		// leak entries from the abandoned branch.
		turnIndexRef.value = 0;
		const branchTc = toolResultMessage("call-branch-1", "alternate branch tool output", 5);
		messages = [userMessage("alternate branch prompt", 0), assistantMessageNoUsage("alt", 3), branchTc];
		round = auditRound(messages);
		expect(round.tokenizeCalls).toBe(1);
		expect(round.byteCalls).toBe(1);
		expect(memoSize(pipeline, "_auditMemo")).toBe(1); // only the new branch's single toolResult -- old branch dropped
	});

	it("keeps getContextAuditReport's messages-arg recompute variant a pure full scan that never populates the hot-path memo", () => {
		const turnIndexRef = { value: 7 };
		const pipeline = createPipeline(turnIndexRef);
		const tc = toolResultMessage("call-1", "output", 0);
		const messages = [tc];

		pipeline.runContextAudit(messages); // warms the hot-path memo
		expect(memoSize(pipeline, "_auditMemo")).toBe(1);

		clearMemo(pipeline, "_auditMemo");
		const inspected = pipeline.getContextAuditReport(messages);
		// The read-only recompute path must be a pure full scan: it must NOT repopulate the
		// hot-path memo (it uses its own no-memo call), so the memo stays empty afterward.
		expect(memoSize(pipeline, "_auditMemo")).toBe(0);
		expect(inspected.items).toHaveLength(1);
	});
});

describe("ContextPipeline incremental memo: token estimate", () => {
	it("is byte-identical to a forced full recompute across a growing conversation and skips re-tokenizing unchanged messages", () => {
		const turnIndexRef = { value: 0 };
		const pipeline = createPipeline(turnIndexRef);
		const tokensSpy = vi.spyOn(agentNode, "estimateTokens");

		function tokenRound(messages: AgentMessage[]): { tokens: number; calls: number } {
			const before = tokensSpy.mock.calls.length;
			const memoized = pipeline.estimateCurrentContextTokens(messages);
			const calls = tokensSpy.mock.calls.length - before;
			clearMemo(pipeline, "_tokenMemo");
			const forcedFull = pipeline.estimateCurrentContextTokens(messages); // cold, ignored for the delta
			expect(forcedFull).toBe(memoized);
			return { tokens: memoized, calls };
		}

		let messages: AgentMessage[] = [
			userMessage("go", 0),
			assistantMessageNoUsage("working", 5),
			toolResultMessage("call-1", "first tool output", 10),
		];
		let round = tokenRound(messages);
		expect(round.calls).toBe(3); // all three messages, cold memo

		messages = [...messages, assistantMessageNoUsage("more", 15), toolResultMessage("call-2", "second", 20)];
		round = tokenRound(messages);
		expect(round.calls).toBe(2); // only the two new messages

		// Same array again (e.g. a read triggered twice in the same round trip): fully warm, zero work.
		round = tokenRound(messages);
		expect(round.calls).toBe(0);
	});

	it("only tokenizes the trailing window after the last usable assistant usage, and reuses it across round trips", () => {
		const turnIndexRef = { value: 0 };
		const pipeline = createPipeline(turnIndexRef);
		const tokensSpy = vi.spyOn(agentNode, "estimateTokens");

		const usageAssistant = assistantMessageWithUsage("done", 10, 1234);
		const base: AgentMessage[] = [userMessage("go", 0), usageAssistant];
		const trailing1 = toolResultMessage("call-1", "trailing output one", 20);
		let messages = [...base, trailing1];

		const before1 = tokensSpy.mock.calls.length;
		const first = pipeline.estimateCurrentContextTokens(messages);
		const calls1 = tokensSpy.mock.calls.length - before1;
		clearMemo(pipeline, "_tokenMemo");
		const forcedFull = pipeline.estimateCurrentContextTokens(messages);
		expect(forcedFull).toBe(first);
		// Only the trailing message after the usage-bearing assistant message is ever tokenized;
		// the usage-covered prefix (user + usage assistant) never touches estimateTokens.
		expect(calls1).toBe(1);

		const trailing2 = toolResultMessage("call-2", "trailing output two", 30);
		messages = [...messages, trailing2];
		const before2 = tokensSpy.mock.calls.length;
		pipeline.estimateCurrentContextTokens(messages);
		const calls2 = tokensSpy.mock.calls.length - before2;
		expect(calls2).toBe(1); // only the new trailing message
	});
});
