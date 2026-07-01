import { describe, expect, it } from "vitest";
import type { ContextItem, ContextItemKind, ContextRetentionClass } from "../src/core/context/context-item.ts";
import {
	canDropFromPrompt,
	canPackToArtifact,
	canSummarize,
	evaluateRetentionEligibility,
	isHardRetained,
} from "../src/core/context/context-retention.ts";

function makeItem(overrides: Partial<ContextItem> = {}): ContextItem {
	return {
		id: "item-1",
		kind: "tool_output",
		retentionClass: "ephemeral",
		source: "tool",
		createdAtTurn: 1,
		tokenEstimate: 10,
		byteEstimate: 40,
		...overrides,
	};
}

const HARD_RETAINED_KINDS: ContextItemKind[] = ["user_instruction", "approval", "denial", "safety_constraint"];

describe("hard retention rules", () => {
	it.each(HARD_RETAINED_KINDS)("never allows dropping or summarizing a %s item", (kind) => {
		const item = makeItem({ kind, retentionClass: "active" });

		expect(isHardRetained(item)).toBe(true);
		expect(canDropFromPrompt(item)).toBe(false);
		expect(canSummarize(item)).toBe(false);
		expect(canPackToArtifact(item)).toBe(false);
		expect(evaluateRetentionEligibility(item).allowedActions).toEqual(["keep_raw"]);
	});

	it("treats any pinned item as hard-retained regardless of kind", () => {
		const item = makeItem({ kind: "goal_state", retentionClass: "pinned" });

		expect(isHardRetained(item)).toBe(true);
		expect(canDropFromPrompt(item)).toBe(false);
		expect(evaluateRetentionEligibility(item).allowedActions).toEqual(["keep_raw"]);
	});

	it("never allows dropping an open requirement or an active blocker", () => {
		const requirement = makeItem({ kind: "requirement", retentionClass: "active" });
		const blocker = makeItem({ kind: "blocker", retentionClass: "active" });

		expect(canDropFromPrompt(requirement)).toBe(false);
		expect(canDropFromPrompt(blocker)).toBe(false);
	});

	it("never allows dropping the latest unresolved failure or current diff summary", () => {
		const latestFailure = makeItem({ kind: "test_result", retentionClass: "decision_bearing" });
		const currentDiff = makeItem({ kind: "diff_summary", retentionClass: "decision_bearing" });

		expect(canDropFromPrompt(latestFailure)).toBe(false);
		expect(canDropFromPrompt(currentDiff)).toBe(false);
	});
});

describe("evidence-gated summarization", () => {
	it("refuses to summarize decision-bearing content with no retrieval path", () => {
		const item = makeItem({ kind: "evidence", retentionClass: "decision_bearing" });

		expect(canSummarize(item)).toBe(false);
		expect(evaluateRetentionEligibility(item).reasonCodes).toContain("decision_bearing_no_retrieval_path");
	});

	it("allows summarizing decision-bearing content once an evidence ref exists", () => {
		const item = makeItem({
			kind: "evidence",
			retentionClass: "decision_bearing",
			evidenceRefs: [{ type: "transcript", ref: { sessionEntryId: "entry-1" } }],
		});

		expect(canSummarize(item)).toBe(true);
	});

	it("allows packing ephemeral content with no prior retrieval path, but refuses to drop it", () => {
		const item = makeItem({ retentionClass: "ephemeral" });

		expect(canPackToArtifact(item)).toBe(true); // packing itself creates the retrieval path
		expect(canDropFromPrompt(item)).toBe(false); // but dropping without any ref is still refused
	});

	it("allows dropping ephemeral content once it has an artifact ref", () => {
		const item = makeItem({
			retentionClass: "ephemeral",
			primaryRef: {
				type: "artifact",
				ref: {
					id: "artifact-1",
					kind: "tool_output",
					byteLength: 5000,
					createdAtTurn: 1,
					reproducible: true,
				},
			},
		});

		expect(canDropFromPrompt(item)).toBe(true);
	});
});

describe("useful and expired classes", () => {
	it("allows the full range of actions for retrievable useful items", () => {
		const item = makeItem({
			kind: "file_snapshot",
			retentionClass: "useful",
			evidenceRefs: [{ type: "transcript", ref: { sessionEntryId: "entry-1" } }],
		});

		expect(evaluateRetentionEligibility(item).allowedActions).toEqual([
			"keep_raw",
			"summarize",
			"pack_to_artifact",
			"drop_from_prompt",
		]);
	});

	it("only allows keep_raw for a useful item with no retrieval/source ref", () => {
		const item = makeItem({ kind: "file_snapshot", retentionClass: "useful" });

		expect(evaluateRetentionEligibility(item).allowedActions).toEqual(["keep_raw"]);
		expect(canSummarize(item)).toBe(false);
		expect(canDropFromPrompt(item)).toBe(false);
		expect(canPackToArtifact(item)).toBe(false);
	});

	it("only allows retrieval-on-demand for expired items", () => {
		const item = makeItem({ retentionClass: "expired" });

		expect(evaluateRetentionEligibility(item).allowedActions).toEqual(["drop_from_prompt"]);
		expect(canSummarize(item)).toBe(false);
	});

	it.each<ContextRetentionClass>(["active", "decision_bearing", "useful", "ephemeral", "expired"])(
		"never marks a non-pinned, non-hard-kind %s item as hardRetained",
		(retentionClass) => {
			const item = makeItem({ kind: "tool_output", retentionClass });
			expect(evaluateRetentionEligibility(item).hardRetained).toBe(false);
		},
	);
});
