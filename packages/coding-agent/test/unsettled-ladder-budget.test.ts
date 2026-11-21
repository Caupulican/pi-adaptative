import { describe, expect, it, vi } from "vitest";
import { ModelEvaluationBudgetError } from "../src/core/system-one/model-evaluation-batches.ts";
import {
	settleUnsettledItems,
	toolResultEvidence,
	type UnsettledItemJudge,
} from "../src/core/system-one/unsettled-ladder.ts";

function callAndResult(id: string, command: string, output: string) {
	return [
		{ role: "assistant", content: [{ type: "toolCall", id, arguments: { command } }] },
		{
			role: "toolResult",
			toolName: "bash",
			toolCallId: id,
			isError: false,
			content: [{ type: "text", text: output }],
		},
	];
}

describe("settlement with oversized evidence", () => {
	const item = "The tests ran.";
	const quote = "tests passed";
	const consult = async () => ({ kind: "fact" as const, fact: quote, model: "consult" });

	it("keeps the producing command when asking the judge about a selected quote", async () => {
		const evidence = toolResultEvidence(callAndResult("a", "echo 'tests passed'", quote));
		const evaluate = vi
			.fn<UnsettledItemJudge["evaluateUnsettledItems"]>()
			.mockRejectedValueOnce(new ModelEvaluationBudgetError("shows_true_0"))
			.mockResolvedValueOnce({ shows_false_0: { band: "hard_pass" } });
		const result = await settleUnsettledItems(
			{ getJudge: () => ({ evaluateUnsettledItems: evaluate }), consult },
			{ items: [item], evidence },
		);
		expect(evaluate.mock.calls[1]?.[0]).toEqual([{ statement: item, evidence: evidence.text }]);
		expect(result.settled[0]?.verdict).toBe("refuted");
	});

	it("includes a newer contradictory receipt even when the consult selects the earlier success", async () => {
		const evidence = toolResultEvidence([
			...callAndResult("a", "run checks", "tests passed"),
			...callAndResult("b", "run checks", "tests failed"),
		]);
		const evaluate = vi
			.fn<UnsettledItemJudge["evaluateUnsettledItems"]>()
			.mockRejectedValueOnce(new ModelEvaluationBudgetError("shows_true_0"))
			.mockResolvedValueOnce({});
		await settleUnsettledItems(
			{ getJudge: () => ({ evaluateUnsettledItems: evaluate }), consult },
			{ items: [item], evidence },
		);
		expect(evaluate.mock.calls[1]?.[0][0]?.evidence).toBe(evidence.text);
	});

	it.each([
		toolResultEvidence([...callAndResult("a", "echo a", quote), ...callAndResult("b", "echo b", quote)]),
		toolResultEvidence(callAndResult("a", "echo a", quote), quote.length),
		toolResultEvidence(callAndResult("a", "x".repeat(601), quote)),
	])("leaves an ambiguous or incomplete citation unsettled", async (evidence) => {
		const evaluate = vi
			.fn<UnsettledItemJudge["evaluateUnsettledItems"]>()
			.mockRejectedValue(new ModelEvaluationBudgetError("shows_true_0"));
		const result = await settleUnsettledItems(
			{ getJudge: () => ({ evaluateUnsettledItems: evaluate }), consult },
			{ items: [item], evidence },
		);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(result.settled).toHaveLength(0);
		expect(result.unsettled[0]?.missing).toContain("review budget");
	});
});
