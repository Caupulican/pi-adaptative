import { describe, expect, it } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { runContextAudit } from "../src/core/context/context-audit.ts";
import { correlateWithContextGc, planPromptPolicy } from "../src/core/context/context-prompt-policy.ts";
import type { ContextGcReport } from "../src/core/context-gc.ts";

function toolResultMessage(overrides: { toolCallId: string; toolName?: string; text?: string; artifactId?: string }) {
	return {
		role: "toolResult" as const,
		toolCallId: overrides.toolCallId,
		toolName: overrides.toolName ?? "grep",
		content: [{ type: "text" as const, text: overrides.text ?? "some tool output" }],
		details: overrides.artifactId ? { artifactId: overrides.artifactId } : undefined,
		isError: false,
		timestamp: 0,
	};
}

function emptyGcReport(): ContextGcReport {
	return { enabled: true, packedCount: 0, originalTokens: 0, packedTokens: 0, savedTokens: 0, records: [] };
}

describe("context-prompt-policy: planPromptPolicy", () => {
	it("gives an artifact-backed item an available retrieval path and no missing_retrieval_path", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: "x".repeat(100_000),
			toolName: "grep",
			createdAtTurn: 1,
			reproducible: true,
		});
		const audit = runContextAudit([toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id })], {
			turnIndex: 1,
			artifactStore: store,
		});

		const plan = planPromptPolicy(audit);

		expect(plan.items).toHaveLength(1);
		const [item] = plan.items;
		expect(item.hasAvailableRetrievalPath).toBe(true);
		expect(item.primaryRefType).toBe("artifact");
		expect(item.hardConstraints.dropFromPrompt).not.toContain("missing_retrieval_path");
		expect(item.hardConstraints.packToArtifact).not.toContain("missing_retrieval_path");
	});

	it("keeps a normal non-artifact item conservative even with a resolvable transcript ref", () => {
		const audit = runContextAudit([toolResultMessage({ toolCallId: "tc-1", toolName: "read" })], {
			turnIndex: 0,
			sessionEntryIdForToolCallId: () => "entry-1",
		});

		const plan = planPromptPolicy(audit);

		const [item] = plan.items;
		expect(item.hasAvailableRetrievalPath).toBe(false);
		expect(item.primaryRefType).toBe("transcript");
		expect(item.hardConstraints.dropFromPrompt).toContain("missing_retrieval_path");
	});

	it("never applies anything but keep_raw, regardless of hard constraints", () => {
		const audit = runContextAudit(
			[toolResultMessage({ toolCallId: "tc-1" }), toolResultMessage({ toolCallId: "tc-2", toolName: "read" })],
			{ turnIndex: 0 },
		);

		const plan = planPromptPolicy(audit);

		for (const item of plan.items) {
			expect(item.appliedAction).toBe("keep_raw");
		}
	});

	it("keep_raw hard constraints are always empty (no evaluated action restricts it)", () => {
		const audit = runContextAudit([toolResultMessage({ toolCallId: "tc-1" })], { turnIndex: 0 });
		const plan = planPromptPolicy(audit);
		expect(plan.items[0]?.hardConstraints.keepRaw).toEqual([]);
	});

	it("is deterministic across repeated calls with the same audit report", () => {
		const store = createInMemoryArtifactStore();
		const { ref } = store.write({
			kind: "tool_output",
			content: "y".repeat(100_000),
			toolName: "find",
			createdAtTurn: 2,
			reproducible: true,
		});
		const audit = runContextAudit(
			[
				toolResultMessage({ toolCallId: "tc-1", artifactId: ref.id }),
				toolResultMessage({ toolCallId: "tc-2", toolName: "read" }),
			],
			{ turnIndex: 2, artifactStore: store },
		);

		const first = planPromptPolicy(audit);
		const second = planPromptPolicy(audit);

		expect(second).toEqual(first);
	});
});

describe("context-prompt-policy: correlateWithContextGc", () => {
	it("marks an item as actually packed when a matching gc record exists by toolCallId", () => {
		const audit = runContextAudit([toolResultMessage({ toolCallId: "tc-1" })], { turnIndex: 0 });
		const plan = planPromptPolicy(audit);
		const gcReport: ContextGcReport = {
			...emptyGcReport(),
			packedCount: 1,
			records: [
				{
					toolName: "grep",
					toolCallId: "tc-1",
					messageIndex: 0,
					reason: "stale-tool-result",
					originalChars: 1000,
					originalTokens: 250,
					packedTokens: 10,
				},
			],
		};

		const correlation = correlateWithContextGc(plan, gcReport);

		expect(correlation.entries).toHaveLength(1);
		const [entry] = correlation.entries;
		expect(entry.actuallyPackedByLegacyGc).toBe(true);
		expect(entry.gcPackReason).toBe("stale-tool-result");
	});

	it("marks an item as not packed when no gc record matches its toolCallId", () => {
		const audit = runContextAudit([toolResultMessage({ toolCallId: "tc-1" })], { turnIndex: 0 });
		const plan = planPromptPolicy(audit);

		const correlation = correlateWithContextGc(plan, emptyGcReport());

		expect(correlation.entries[0]?.actuallyPackedByLegacyGc).toBe(false);
		expect(correlation.entries[0]?.gcPackReason).toBeUndefined();
	});

	it("reports the raw booleans independently: legacy gc can pack something the policy would not consider pack-eligible", () => {
		// Non-artifact item: policy would NOT allow pack_to_artifact (no store at all here),
		// but legacy gc's own summarize-in-place packing is a different operation and can
		// still act on it. The two booleans are reported as-is, with no derived "agreement"
		// metric between them (see the module doc comment on correlateWithContextGc).
		const audit = runContextAudit([toolResultMessage({ toolCallId: "tc-1", toolName: "read" })], { turnIndex: 0 });
		const plan = planPromptPolicy(audit);
		const gcReport: ContextGcReport = {
			...emptyGcReport(),
			packedCount: 1,
			records: [
				{
					toolName: "read",
					toolCallId: "tc-1",
					messageIndex: 0,
					reason: "stale-tool-result",
					originalChars: 5000,
					originalTokens: 1250,
					packedTokens: 20,
				},
			],
		};

		const correlation = correlateWithContextGc(plan, gcReport);

		const [entry] = correlation.entries;
		expect(entry.actuallyPackedByLegacyGc).toBe(true);
		expect(entry.policyWouldAllowPack).toBe(false);
		expect(entry).not.toHaveProperty("agreesWithLegacyGc");
	});

	it("is deterministic across repeated calls with the same shadow plan and gc report", () => {
		const audit = runContextAudit([toolResultMessage({ toolCallId: "tc-1" })], { turnIndex: 0 });
		const plan = planPromptPolicy(audit);
		const gcReport = emptyGcReport();

		const first = correlateWithContextGc(plan, gcReport);
		const second = correlateWithContextGc(plan, gcReport);

		expect(second).toEqual(first);
	});
});
