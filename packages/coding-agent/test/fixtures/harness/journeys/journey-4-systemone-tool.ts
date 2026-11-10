import "../builtin-install.ts";
import { expect } from "vitest";
import { calls, createBarrier, type ScriptedRequest } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { ICM_INTAKE_JUDGMENTS, latestBatchResults } from "./shared.ts";

const STATE = "The retry limit in src/limits.ts is 3.";
/** The intake judgments a plain prompt consumes here: a start without a profile asks no capability question. */
const { capabilities_authorized: _capabilities, ...INTAKE_JUDGMENTS } = ICM_INTAKE_JUDGMENTS;

/** The result of the `systemone` call a request answers. */
function toolResult(request: ScriptedRequest): { isError: boolean; text: string } {
	const result = latestBatchResults(request).find((entry) => entry.toolName === "systemone");
	if (!result) throw new Error("the request carries no systemone result");
	return { isError: result.isError, text: result.text };
}

/**
 * System One as a tool of the root. The root asks the tool for its status, then for one judgment of its own: whether a
 * statement says what the root thinks it says. With System One on, the status says it is ready and the judgment comes
 * back with the probability the evaluator gave and one priced usage receipt. With System One off the tool is not
 * offered at all, so each call is refused as an unknown tool and nothing reaches the evaluator.
 */
export async function runJourney4SystemOneToolPhase(world: HarnessWorld): Promise<void> {
	const { trace } = world;
	const agentDir = `${world.agentDir}-systemone-tool`;
	const manager = world.createSessionManager(agentDir);
	const { session } = await world.createRootSession("root", {
		agentDir,
		sessionManager: manager,
		settings: {
			autoLearn: { enabled: false },
			proactivity: { enabled: false },
			orchestrator: { delegationGate: false },
		},
	});
	const results: Record<string, { isError: boolean; text: string }> = {};
	const answered = createBarrier();
	world.provider.enqueue(
		"root",
		calls("j4-s1-status-call", [{ id: "j4-s1-status", name: "systemone", arguments: { action: "status" } }]),
		{
			...calls("j4-s1-evaluate-call", [
				{
					id: "j4-s1-evaluate",
					name: "systemone",
					arguments: {
						action: "evaluate",
						evaluation: {
							state: STATE,
							questions: {
								limit_is_three: { type: "noul", instructions: "Does the state say the retry limit is 3?" },
							},
						},
					},
				},
			]),
			check: (request) => {
				results.status = toolResult(request);
			},
		},
		{
			name: "j4-s1-answer",
			check: (request) => {
				results.evaluate = toolResult(request);
				answered.release();
			},
			reply: { content: [{ type: "text", text: "System One answered." }] },
		},
	);
	world.systemOne.enterPhase("j4-systemone-tool", {
		...INTAKE_JUDGMENTS,
		limit_is_three: { kind: "noul", probability: 0.97 },
	});
	await withDeadline(trace, "the System One tool turn", session.prompt("Ask System One whether the limit is three."));
	await withDeadline(trace, "the System One tool answers", answered.promise);
	await withDeadline(trace, "the session is at rest", session.waitForForegroundIdle());
	if (!world.systemOne.enabled) {
		expect(
			Object.values(results).map((result) => [
				result.isError,
				result.text.includes('Unknown tool name \\"systemone\\".'),
			]),
			"with System One off the tool is not offered: each call is refused as an unknown tool",
		).toEqual([
			[true, true],
			[true, true],
		]);
	} else {
		const status = JSON.parse(results.status?.text ?? "{}") as {
			enabled?: boolean;
			authenticationVerified?: boolean;
		};
		const evaluation = JSON.parse(results.evaluate?.text ?? "{}") as {
			response?: { answers?: Record<string, unknown> };
			receipts?: { status: string }[];
			costStatus?: string;
		};
		expect(
			{
				errors: [results.status?.isError, results.evaluate?.isError],
				status: { enabled: status.enabled, verified: status.authenticationVerified },
				answer: evaluation.response?.answers?.limit_is_three,
				receipts: evaluation.receipts?.map((receipt) => receipt.status),
				cost: evaluation.costStatus,
			},
			"the tool says System One is ready, and the root's own question comes back with the evaluator's probability and one priced usage receipt",
		).toEqual({
			errors: [false, false],
			status: { enabled: true, verified: true },
			answer: { type: "noul", noul: 0.97 },
			receipts: ["recorded"],
			cost: "catalog_priced",
		});
	}
	expect(await world.disposeSessionInBody(session), "the System One tool session closes").toBeUndefined();
	trace.mark("root", "systemone-tool.closed");
}
