import { describe, expect, it } from "vitest";
import {
	type ContextArtifactRef,
	type ContextItem,
	estimateByteLength,
	estimateLineCount,
	estimateTokensFromChars,
	estimateTokensFromText,
	HARD_RETAINED_CONTEXT_KINDS,
} from "../src/core/context/context-item.ts";

function makeArtifactRef(overrides: Partial<ContextArtifactRef> = {}): ContextArtifactRef {
	return {
		id: "artifact-1",
		kind: "tool_output",
		byteLength: 1000,
		createdAtTurn: 1,
		reproducible: true,
		...overrides,
	};
}

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

describe("ContextItem serialization", () => {
	it("round-trips through JSON without losing evidence refs", () => {
		const item = makeItem({
			primaryRef: { type: "artifact", ref: makeArtifactRef() },
			evidenceRefs: [{ type: "transcript", ref: { sessionEntryId: "entry-1" } }],
		});

		const roundTripped = JSON.parse(JSON.stringify(item)) as ContextItem;

		expect(roundTripped).toEqual(item);
		expect(roundTripped.primaryRef).toEqual({ type: "artifact", ref: makeArtifactRef() });
	});

	it("labels evidence refs by source type", () => {
		const item = makeItem({
			evidenceRefs: [
				{ type: "artifact", ref: makeArtifactRef() },
				{
					type: "memory",
					ref: { providerId: "pi-okf", itemId: "mem-1", scope: "project", kind: "design_decision" },
				},
				{ type: "transcript", ref: { sessionEntryId: "entry-2" } },
				{ type: "runtime", id: "rt-1", description: "policy gate" },
			],
		});

		const types = item.evidenceRefs?.map((ref) => ref.type);
		expect(types).toEqual(["artifact", "memory", "transcript", "runtime"]);
	});

	it("marks user_instruction, approval, denial, and safety_constraint as hard-retained kinds", () => {
		expect(HARD_RETAINED_CONTEXT_KINDS.has("user_instruction")).toBe(true);
		expect(HARD_RETAINED_CONTEXT_KINDS.has("approval")).toBe(true);
		expect(HARD_RETAINED_CONTEXT_KINDS.has("denial")).toBe(true);
		expect(HARD_RETAINED_CONTEXT_KINDS.has("safety_constraint")).toBe(true);
		expect(HARD_RETAINED_CONTEXT_KINDS.has("tool_output")).toBe(false);
	});
});

describe("no-tokenizer size estimate helpers", () => {
	it("estimates bytes as UTF-8 length", () => {
		expect(estimateByteLength("abc")).toBe(3);
		expect(estimateByteLength("é")).toBe(2);
		expect(estimateByteLength("")).toBe(0);
	});

	it("estimates line count including a trailing partial line", () => {
		expect(estimateLineCount("")).toBe(0);
		expect(estimateLineCount("one line")).toBe(1);
		expect(estimateLineCount("line one\nline two")).toBe(2);
		expect(estimateLineCount("line one\nline two\n")).toBe(3);
	});

	it("estimates tokens as ceil(chars / 4), matching the repo's existing no-tokenizer ratio", () => {
		expect(estimateTokensFromChars(0)).toBe(0);
		expect(estimateTokensFromChars(4)).toBe(1);
		expect(estimateTokensFromChars(5)).toBe(2);
		expect(estimateTokensFromChars(-10)).toBe(0);
		expect(estimateTokensFromText("abcdefgh")).toBe(2);
	});
});
