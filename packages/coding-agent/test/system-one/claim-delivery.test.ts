import type { AgentMessage } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AnswerClaimChecker, collectClaimReceipts, judgeClaims } from "../../src/core/system-one/claim-delivery.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const yes = { type: "noul", noul: 0.97 };
const no = { type: "noul", noul: 0.02 };

let callSeq = 0;
function turn(command: string, isError: boolean): AgentMessage[] {
	const id = `c${++callSeq}`;
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
		} as unknown as AgentMessage,
		{
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			content: [{ type: "text", text: "" }],
			isError,
			timestamp: 0,
		} as AgentMessage,
	];
}

describe("claims against deliveries", () => {
	it("reads commit, push and publish receipts from the turn's own shell calls", () => {
		const receipts = collectClaimReceipts([...turn("git commit -m x", false), ...turn("git push origin main", true)]);
		expect(receipts.commits).toEqual({ succeeded: 1, failed: 0 });
		expect(receipts.pushes).toEqual({ succeeded: 0, failed: 1 });
		expect(receipts.publishes).toEqual({ succeeded: 0, failed: 0 });
	});

	it("contradicts a stated push whose every push failed, and flags a stated commit nothing backs", () => {
		const receipts = collectClaimReceipts(turn("git push origin main", true));
		const findings = judgeClaims({ states_pushed: yes, states_committed: yes, states_tests_pass: no }, receipts);
		expect(findings.map((f) => [f.kind, f.verdict])).toEqual([
			["committed", "unsupported"],
			["pushed", "contradicted"],
		]);
	});

	it("claims nothing when Jev could not settle whether the answer states it", () => {
		const receipts = collectClaimReceipts(turn("git push origin main", true));
		expect(judgeClaims({ states_pushed: { type: "noul", noul: 0.5 } }, receipts)).toEqual([]);
	});

	it("blocks a worker report its own results contradict, and a verifier's acceptance nothing inspected", async () => {
		const warnings: string[] = [];
		const checker = new AnswerClaimChecker({
			getController: () => ({
				evaluateAnswerClaims: async () => ({ states_pushed: yes, states_tests_pass: no }),
			}),
			warn: (message) => warnings.push(message),
		});
		const pushed = await checker.workerReportBlockers({
			summary: "Pushed the fix.",
			messages: turn("git push origin main", true),
		});
		expect(pushed).toHaveLength(1);
		expect(pushed[0]).toContain("pushed");
		// An inspection backs an acceptance; a subject without tests is verified by reading it.
		const inspected = await checker.workerReportBlockers({
			summary: "Reviewed the change.",
			messages: turn("git status", false),
			verifierVerdict: "accepted",
		});
		expect(inspected).toEqual([]);
		const uninspected = await checker.workerReportBlockers({
			summary: "Reviewed the change.",
			messages: turn("git status", true),
			verifierVerdict: "accepted",
		});
		expect(uninspected).toEqual([
			"verification accepted with no successful inspection in the verifier's own transcript",
		]);
		const nothing = await checker.workerReportBlockers({
			summary: "Reviewed the change.",
			messages: [],
			verifierVerdict: "accepted",
		});
		expect(nothing).toEqual(uninspected);
	});

	describe("in a session", () => {
		let harness: Harness | undefined;
		afterEach(async () => {
			await harness?.cleanup();
			harness = undefined;
		});

		it("a contradicted claim buys exactly one correction turn, with or without a live objective", async () => {
			const store = new ExecutionStore({
				run_id: "claims",
				objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
				repo: { root: "/repo", baseline_revision: "rev-0" },
			});
			const evaluatedAnswers: string[] = [];
			const systemOneController = new SystemOneController({
				store,
				adapter: {
					evaluate: async (request) => {
						const state = request.state as { final_answer?: string };
						if (state.final_answer !== undefined) evaluatedAnswers.push(state.final_answer);
						return {
							model: "jev-1.13.0",
							latency_ms: 1,
							answers: Object.fromEntries(
								Object.keys(request.questions).map((id) => [id, id === "states_pushed" ? yes : no]),
							),
						};
					},
				},
			});
			harness = await createHarness({ systemOneController });
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "git push origin main" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Done: I pushed the changes to origin."),
				fauxAssistantMessage("Correction: the push failed; nothing was pushed."),
			]);
			await harness.session.prompt("push it");
			expect(evaluatedAnswers).toEqual(["Done: I pushed the changes to origin."]);
			expect(harness.getPendingResponseCount()).toBe(0);
			const texts = harness.session.agent.state.messages.map((message) =>
				message.role === "custom" ? `custom:${message.customType}` : message.role,
			);
			expect(texts.filter((entry) => entry === "custom:claim_delivery")).toHaveLength(1);
		});
	});
});
