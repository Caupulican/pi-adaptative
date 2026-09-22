import { describe, expect, it } from "vitest";
import {
	type ItemConsult,
	parseItemConsult,
	settleUnsettledItems,
	toolResultEvidence,
} from "../../src/core/system-one/unsettled-ladder.ts";

const yes = { type: "noul", noul: 0.97 };
const no = { type: "noul", noul: 0.03 };
const unsure = { type: "noul", noul: 0.6 };
const soft = { type: "noul", noul: 0.88 };

type Check = { statement: string; evidence: string };

/** A judge that answers each request with the next batch of [shows_true, shows_false] pairs. */
function judge(...batches: [unknown, unknown][][]) {
	const calls: Check[][] = [];
	return {
		calls,
		evaluateUnsettledItems: async (checks: readonly Check[]) => {
			const pairs = batches[calls.length] ?? [];
			calls.push([...checks]);
			const answers: Record<string, unknown> = {};
			checks.forEach((_, index) => {
				answers[`shows_true_${index}`] = pairs[index]?.[0];
				answers[`shows_false_${index}`] = pairs[index]?.[1];
			});
			return answers;
		},
	};
}

const evidence = "[bash] 12 passed, 0 failed";

describe("the unsettled-item ladder", () => {
	it("settles on System One's first pass, either way, and only on a decisive band", async () => {
		const first = judge([
			[yes, no],
			[no, yes],
			[soft, no],
		]);
		const outcome = await settleUnsettledItems(
			{ getJudge: () => first },
			{ items: ["the suite passes", "a test fails", "the suite is complete"], evidence },
		);
		expect(outcome.settled).toEqual([
			{ item: "the suite passes", verdict: "confirmed", by: "system_one" },
			{ item: "a test fails", verdict: "refuted", by: "system_one" },
		]);
		// A provisional band is not a settlement: the item stays open, honestly.
		expect(outcome.unsettled.map((entry) => entry.item)).toEqual(["the suite is complete"]);
		expect(first.calls).toHaveLength(1);
		expect(first.calls[0]?.every((check) => check.evidence === evidence)).toBe(true);
	});

	it("climbs to a stronger model's fact, and Jev decides both the fact and what it settles", async () => {
		const passes = judge(
			[[unsure, unsure]],
			[
				[yes, no],
				[yes, no],
			],
		);
		const consulted: string[] = [];
		const outcome = await settleUnsettledItems(
			{
				getJudge: () => passes,
				consult: async ({ item }) => {
					consulted.push(item);
					return { kind: "fact", fact: "12 passed, 0 failed", model: "big/model" };
				},
			},
			{ items: ["the suite passes"], evidence },
		);
		expect(consulted).toEqual(["the suite passes"]);
		expect(outcome.settled).toEqual([
			{ item: "the suite passes", verdict: "confirmed", by: "system_one+big/model", basis: "12 passed, 0 failed" },
		]);
		expect(outcome.unsettled).toEqual([]);
		// The second pass carries new evidence: the fact against the results, and the item against the fact.
		expect(passes.calls[1]).toEqual([
			{ statement: "12 passed, 0 failed", evidence },
			{ statement: "the suite passes", evidence: "12 passed, 0 failed" },
		]);
	});

	it("never takes the stronger model's word: an ungrounded fact leaves the item for the owner", async () => {
		const passes = judge(
			[[unsure, unsure]],
			[
				[unsure, no],
				[yes, no],
			],
		);
		const outcome = await settleUnsettledItems(
			{
				getJudge: () => passes,
				consult: async () => ({ kind: "fact", fact: "all 40 suites passed", model: "big/model" }),
			},
			{ items: ["the suite passes"], evidence },
		);
		expect(outcome.settled).toEqual([]);
		expect(outcome.unsettled[0]?.missing).toContain("the evidence does not show");
	});

	it("reports what the stronger model says is missing, and spends at most two Jev passes", async () => {
		const passes = judge([[unsure, unsure]]);
		const consult = async (): Promise<ItemConsult> => ({
			kind: "missing",
			missing: "a run of the integration suite",
			model: "big/model",
		});
		const outcome = await settleUnsettledItems(
			{ getJudge: () => passes, consult },
			{ items: ["integration passes"], evidence },
		);
		expect(outcome.unsettled).toEqual([{ item: "integration passes", missing: "a run of the integration suite" }]);
		expect(passes.calls).toHaveLength(1);
	});

	it("keeps every item open and named when System One is down, unbound, or has nothing to read", async () => {
		const down = {
			evaluateUnsettledItems: async () => {
				throw new Error("Jev down");
			},
		};
		const outage = await settleUnsettledItems({ getJudge: () => down }, { items: ["x"], evidence });
		expect(outage).toEqual({ settled: [], unsettled: [{ item: "x", missing: "System One unavailable: Jev down" }] });
		const unbound = await settleUnsettledItems({ getJudge: () => undefined }, { items: ["x"], evidence });
		expect(unbound.unsettled[0]?.missing).toBe("System One is not bound");
		const empty = judge();
		const nothing = await settleUnsettledItems({ getJudge: () => empty }, { items: ["x"], evidence: " " });
		expect(nothing.unsettled[0]?.missing).toBe("the agent recorded no tool results");
		expect(empty.calls).toHaveLength(0);
	});

	it("parses the stronger model's reply, and reads tool results as evidence", () => {
		expect(parseItemConsult("FACT: 12 passed", "m")).toEqual({ kind: "fact", fact: "12 passed", model: "m" });
		expect(parseItemConsult("hmm\nMISSING: a log", "m")).toEqual({ kind: "missing", missing: "a log", model: "m" });
		expect(parseItemConsult("FACT:", "m")).toBeUndefined();
		expect(
			toolResultEvidence([
				{ role: "assistant", content: [{ type: "text", text: "narration is not evidence" }] },
				{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "12 passed" }] },
			]),
		).toBe("[bash] 12 passed");
	});
});
