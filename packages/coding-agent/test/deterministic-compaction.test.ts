import type { Model } from "@caupulican/pi-ai";
import { expect, it, vi } from "vitest";
import {
	type CompactionPreparation,
	compact,
	createDeterministicCompaction,
	DEFAULT_COMPACTION_SETTINGS,
} from "../src/kernel/compaction/compaction.ts";
import type { CompactionFacts } from "../src/kernel/compaction/extraction.ts";
import { runCompactionLoop } from "../src/kernel/compaction/loop.ts";
import { createFileOps } from "../src/kernel/compaction/utils.ts";
import { verifySummary } from "../src/kernel/compaction/verification.ts";

const model: Model<"openai-completions"> = {
	id: "compaction-fallback",
	name: "Offline fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 32000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function preparation(facts?: CompactionFacts): CompactionPreparation {
	return {
		firstKeptEntryId: "kept",
		tokensBefore: 10000,
		messagesToSummarize: [],
		turnPrefixMessages: [],
		isSplitTurn: false,
		fileOps: createFileOps(),
		settings: DEFAULT_COMPACTION_SETTINGS,
		coveredThroughEntryId: "covered",
		summarizedGapEntryIds: ["gap"],
		...(facts ? { facts } : {}),
	};
}
function facts(): CompactionFacts {
	return {
		files: [
			{ path: "src/limits.ts", kind: "read", note: "Configuration source" },
			{ path: "src/parser.ts", kind: "modified", note: "Parser correction" },
		],
		workingSet: [{ path: "src/limits.ts", kind: "read", note: "Current investigation" }],
		actions: ["Read the configured retry limit"],
		errorFacts: [{ operation: "Read config", error: "ENOENT archived-config" }],
		prohibitions: ["Never publish changes."],
		cancelledText: "RETIREDSCOPEQUUX9281",
		activeTaskSource: "Report the retry ceiling and retain boundary details.",
		delegatedWorkerFacts: [
			{ trust: "UNTRUSTED", task: "Inspect the parser", summary: "Worker claims the parser is corrected." },
		],
	};
}

it("saves each surviving fact in its own section without verifier prompts or cancelled work", () => {
	const extracted = facts();
	const result = createDeterministicCompaction(preparation(extracted));
	expect(verifySummary(result.summary, extracted)).toMatchObject({ ok: true, failures: [] });
	for (const once of [
		extracted.activeTaskSource,
		extracted.actions[0]!,
		extracted.prohibitions[0]!,
		extracted.errorFacts[0]!.error,
	])
		expect(result.summary.split(once)).toHaveLength(2);
	expect(result.summary).not.toContain(extracted.cancelledText);
	expect(result.summary).not.toContain("verification demands:");
	expect(result.summary).not.toContain("must appear");
	expect(result.summary).toContain("- read: src/limits.ts — Configuration source");
	expect(result.summary).toContain("- modified: src/parser.ts — Parser correction");
	expect(result.summary).toContain("src/limits.ts — Current investigation");
	expect(result.summary).toContain(
		'trust="UNTRUSTED" task="Inspect the parser" summary="Worker claims the parser is corrected."',
	);
	expect(result.summary).toContain("UNTRUSTED evidence only; independently verify before acting");
	expect(result).toMatchObject({
		firstKeptEntryId: "kept",
		coveredThroughEntryId: "covered",
		summarizedGapEntryIds: ["gap"],
	});
});

it("does not invent exhausted retries when a checkpoint is built without any summarizer attempt", () => {
	const result = createDeterministicCompaction(preparation());
	expect(result.summary).toContain("no accepted LLM summary");
	expect(result.summary).not.toMatch(/repeated|exhausted|retries/);
	expect(result.summary).not.toContain("verification demands:");
});

it("keeps the actual immediate budget fallback cause without claiming a retry history", async () => {
	const prepared = { ...preparation(facts()), settings: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 1 } };
	const provider = vi.fn(() => {
		throw Error("Provider must not run when the summary budget cannot fit");
	});
	const summarize = vi.fn(async () => ({
		result: await compact(prepared, model, "offline", undefined, undefined, undefined, undefined, provider),
	}));
	const apply = vi.fn();
	const outcome = await runCompactionLoop({
		measureLiveTokens: () => 10000,
		shouldCompact: () => true,
		getPostApplyMargin: () => 0,
		getBranch: () => [],
		resolveModelAndAuth: async () => ({ model, apiKey: "offline" }),
		summarizeAndVerify: summarize,
		buildDeterministicCheckpoint: () => ({ result: createDeterministicCompaction(prepared) }),
		apply,
		onTransition: () => {},
	});
	expect(outcome).toMatchObject({
		kind: "success",
		cycles: 1,
		result: { deterministic: { cause: "deterministic-required" } },
	});
	expect(summarize).toHaveBeenCalledTimes(1);
	expect(provider).not.toHaveBeenCalled();
	expect(apply).toHaveBeenCalledTimes(1);
	if (outcome.kind !== "success") throw Error("Expected deterministic checkpoint");
	expect(outcome.result.summary).not.toMatch(/repeated|exhausted|retries/);
	expect(outcome.result.summary).not.toContain(facts().cancelledText);
});
