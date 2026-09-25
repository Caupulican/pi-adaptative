import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { compactToolResultDetailsForRetention } from "@caupulican/pi-agent-core/message-retention";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enforceSessionEdgeOperation, type SessionEdgeDeps } from "../../src/core/agent-session-edge.ts";
import {
	AnswerClaimChecker,
	collectClaimReceipts,
	judgeClaims,
	mayContainDeliveryClaims,
} from "../../src/core/system-one/claim-delivery.ts";
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

	it("counts the requirement checks a goal completion reran as the checks the answer says passed", () => {
		const completion = (toolName: string, requirementChecks: { passed: number; failed: number }, isError: boolean) =>
			[
				{
					role: "toolResult",
					toolCallId: `g${++callSeq}`,
					toolName,
					content: [{ type: "text", text: "" }],
					details: { action: "complete", applied: !isError, piReceipts: { requirementChecks } },
					isError,
					timestamp: 0,
				},
			] as AgentMessage[];
		const passed = collectClaimReceipts(completion("update_goal", { passed: 3, failed: 0 }, false));
		expect(passed.tests).toEqual({ passed: 3, failed: 0, lastPassed: true });
		expect(judgeClaims({ states_tests_pass: yes }, passed)).toEqual([]);

		const failed = collectClaimReceipts(completion("goal", { passed: 2, failed: 1 }, true));
		expect(judgeClaims({ states_tests_pass: yes }, failed).map((f) => f.verdict)).toEqual(["contradicted"]);

		// Only the goal tools report check runs: the same field on another tool is no receipt.
		const foreign = collectClaimReceipts(completion("some_extension", { passed: 3, failed: 0 }, false));
		expect(foreign.tests.passed).toBe(0);
	});

	it("keeps test and check receipts when a result's details exceed the retention budget", () => {
		// A goal result carries the whole goal state and a test run its output window: both outgrow the
		// budget, and the claim check reads them only after message_end compacted them.
		const bulk = "x".repeat(20_000);
		const goalResult = {
			role: "toolResult",
			toolCallId: `g${++callSeq}`,
			toolName: "goal",
			content: [{ type: "text", text: "goal complete recorded." }],
			details: {
				action: "complete",
				applied: true,
				state: { bulk },
				piReceipts: { requirementChecks: { passed: 2, failed: 0 } },
			},
			isError: false,
			timestamp: 0,
		};
		const testDetails: Record<string, unknown> = { output: bulk };
		Object.defineProperty(testDetails, "piVerification", {
			value: {
				version: 1,
				id: "unit",
				status: "passed",
				summary: "unit passed",
				evidence: "tests",
				outcome: "executed",
			},
			enumerable: true,
			writable: false,
			configurable: false,
		});
		const testResult = {
			role: "toolResult",
			toolCallId: `t${++callSeq}`,
			toolName: "bash",
			content: [{ type: "text", text: "3 passed" }],
			details: testDetails,
			isError: false,
			timestamp: 0,
		};
		for (const message of [goalResult, testResult]) compactToolResultDetailsForRetention(message);
		expect(goalResult.details).toMatchObject({ piToolResultDetailsTruncated: true });
		expect(testResult.details).toMatchObject({ piToolResultDetailsTruncated: true });
		const receipts = collectClaimReceipts([goalResult, testResult] as AgentMessage[]);
		expect(receipts.tests).toEqual({ passed: 3, failed: 0, lastPassed: true });
	});

	it("claims nothing when System One could not settle whether the answer states it", () => {
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

	describe("the prefilter admits every claim the catalog asks about", () => {
		const checkClaims = [
			"The type check passed.",
			"The type check succeeded.",
			"The build completed successfully.",
			"Lint is clean.",
			"It compiles without errors.",
			"tsc reports no errors.",
		];
		const relayed = "The script printed: status report: all green";

		it("reaches System One for genuine check and build claims, and for relayed text", () => {
			for (const answer of [...checkClaims, relayed]) expect(mayContainDeliveryClaims(answer), answer).toBe(true);
		});

		it("skips System One for an answer that names no claim kind (control)", () => {
			expect(mayContainDeliveryClaims("Here is how the parser resolves imports.")).toBe(false);
		});

		it("leaves telling a check claim from relayed text to System One's answer", async () => {
			const asked: string[] = [];
			const checker = new AnswerClaimChecker({
				getController: () => ({
					evaluateAnswerClaims: async (finalAnswer: string) => {
						asked.push(finalAnswer);
						return { states_tests_pass: finalAnswer === relayed ? no : yes };
					},
				}),
				warn: () => {},
			});
			const receipts = turn("git status", false);
			expect((await checker.findings("The type check succeeded.", receipts))?.map((f) => f.kind)).toEqual([
				"tests_pass",
			]);
			expect(await checker.findings(relayed, receipts)).toEqual([]);
			expect(asked).toEqual(["The type check succeeded.", relayed]);
		});
	});

	describe("a claim no receipt backs climbs the ladder", () => {
		const statesTests = async () => ({ states_tests_pass: yes });
		// A test runner the harness does not recognize leaves no receipt; its output is still evidence.
		const unrecognizedRun = turn("pytest -q", false);

		function checker(outcome: { settled: unknown[]; unsettled: unknown[] }) {
			const warnings: string[] = [];
			const delivered: string[][] = [];
			const settleCalls: string[][] = [];
			const instance = new AnswerClaimChecker({
				getController: () => ({ evaluateAnswerClaims: statesTests }),
				warn: (message) => warnings.push(message),
				settle: async (items) => {
					settleCalls.push([...items]);
					return outcome as never;
				},
				deliverToOwner: (items) => delivered.push([...items]),
			});
			return { instance, warnings, delivered, settleCalls };
		}

		it("stands when System One confirms it from the turn's results", async () => {
			const c = checker({
				settled: [{ item: "The tests or checks that were run passed", verdict: "confirmed", by: "system_one" }],
				unsettled: [],
			});
			expect(await c.instance.check("All tests pass.", unrecognizedRun)).toBeUndefined();
			expect(c.settleCalls).toEqual([["The tests or checks that were run passed"]]);
			expect(c.warnings).toEqual([]);
			expect(c.delivered).toEqual([]);
		});

		it("becomes a contradiction, with one correction, when System One refutes it", async () => {
			const c = checker({
				settled: [{ item: "The tests or checks that were run passed", verdict: "refuted", by: "system_one" }],
				unsettled: [],
			});
			const correction = await c.instance.check("All tests pass.", unrecognizedRun);
			expect(correction).toContain("show it did not happen");
		});

		it("goes to the owner when nothing settles it", async () => {
			const c = checker({
				settled: [],
				unsettled: [{ item: "The tests or checks that were run passed", missing: "a test run in this turn" }],
			});
			expect(await c.instance.check("All tests pass.", unrecognizedRun)).toBeUndefined();
			expect(c.delivered).toHaveLength(1);
			expect(c.delivered[0]?.[0]).toContain("no test run during this work recorded a pass");
			expect(c.delivered[0]?.[0]).toContain("(missing: a test run in this turn)");
		});
	});

	describe("in a session", () => {
		let harness: Harness | undefined;
		afterEach(async () => {
			await harness?.cleanup();
			harness = undefined;
		});

		it("records handoff questions without displaying an owner notice", async () => {
			harness = await createHarness();
			const delivery = harness.session as unknown as {
				_handoff: boolean;
				_deliverToOwner(items: readonly string[]): string | undefined;
				_flushOwnerItems(lease: undefined): Promise<void>;
			};
			delivery._deliverToOwner(["The release risk remains unsettled"]);
			delivery._handoff = true;
			const path = delivery._deliverToOwner(["The worker could not settle the release scope"]);
			expect(path).toBeDefined();
			await delivery._flushOwnerItems(undefined);
			expect(readFileSync(path!, "utf8")).toContain("release scope");
			expect(readFileSync(path!, "utf8")).toContain("release risk");
			expect(
				harness.session.agent.state.messages.filter(
					(message) => message.role === "custom" && message.customType === "owner_items",
				),
			).toHaveLength(0);
			expect(harness.eventsOfType("warning")).toEqual([]);
		});

		it("shows newly recorded follow-ups once when the owner returns", async () => {
			harness = await createHarness();
			const delivery = harness.session as unknown as {
				_handoff: boolean;
				_deliverToOwner(items: readonly string[]): string | undefined;
			};
			delivery._handoff = true;
			const path = delivery._deliverToOwner(["The release scope needs the owner"]);
			delivery._handoff = false;
			harness.setResponses([fauxAssistantMessage("Welcome back"), fauxAssistantMessage("Continuing")]);
			await harness.session.prompt("I'm back");
			await harness.session.prompt("Continue");
			const notices = harness.eventsOfType("warning").filter((event) => event.message.includes("follow-ups"));
			expect(notices).toHaveLength(1);
			expect(notices[0]?.message).toContain(path);
		});

		it("defers an ungranted operation during handoff without opening confirmation", async () => {
			harness = await createHarness({ settings: { edge: { allow: [] } } });
			const delivery = harness.session as unknown as {
				_handoff: boolean;
				_edgeDeps(): SessionEdgeDeps;
			};
			delivery._handoff = true;
			const confirm = vi.fn(async () => "allow-once" as const);
			harness.session.setEdgeConfirmation(confirm);
			const result = await enforceSessionEdgeOperation(delivery._edgeDeps(), {
				class: "operation.irreversible",
				operation: "publish the release",
				reason: "Owner approval is missing",
			});
			expect(result.authorized).toBe(false);
			expect(confirm).not.toHaveBeenCalled();
			const path = join(harness.tempDir, "follow-ups", `${harness.sessionManager.getSessionId()}.md`);
			expect(readFileSync(path, "utf8")).toContain("publish the release");
			expect(harness.eventsOfType("warning")).toEqual([]);
		});

		it("preserves owner authority across an internal goal continuation", async () => {
			harness = await createHarness();
			const session = harness.session as unknown as {
				_handoff: boolean;
				_lastUserRequest: string;
				_enableCapabilitiesAuthorizedByUser(request: string, signal?: AbortSignal): Promise<string | undefined>;
			};
			session._handoff = true;
			session._lastUserRequest = "Finish the release and hand it off";
			const classify = vi.spyOn(session, "_enableCapabilitiesAuthorizedByUser").mockImplementation(async () => {
				session._handoff = false;
				return undefined;
			});
			harness.setResponses([fauxAssistantMessage("Continuing"), fauxAssistantMessage("Owner returned")]);
			await harness.session.prompt("Continue active goal.", {
				internalContextType: "goal_continuation_trigger",
				autoContinueGoal: false,
			});
			expect(classify).not.toHaveBeenCalled();
			expect(session._handoff).toBe(true);
			expect(session._lastUserRequest).toBe("Finish the release and hand it off");
			await harness.session.prompt("I am back", { autoContinueGoal: false });
			expect(classify).toHaveBeenCalledOnce();
			expect(session._handoff).toBe(false);
			expect(session._lastUserRequest).toBe("I am back");
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

		it("an unbacked claim nothing settles reaches the owner from the host, not the model", async () => {
			const store = new ExecutionStore({
				run_id: "claims-owner",
				objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
				repo: { root: "/repo", baseline_revision: "rev-0" },
			});
			const unsure = { type: "noul", noul: 0.6 };
			const systemOneController = new SystemOneController({
				store,
				adapter: {
					evaluate: async (request) => ({
						model: "jev-1.13.0",
						latency_ms: 1,
						answers: Object.fromEntries(
							Object.keys(request.questions).map((id) => [
								id,
								id.startsWith("shows_") ? unsure : id === "states_tests_pass" ? yes : no,
							]),
						),
					}),
				},
			});
			harness = await createHarness({ systemOneController });
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command: "echo checked" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Done. All tests pass."),
				fauxAssistantMessage("MISSING: a test run in this turn"),
			]);
			await harness.session.prompt("check it");
			const ownerItems = harness.session.agent.state.messages.filter(
				(message) => message.role === "custom" && message.customType === "owner_items",
			);
			expect(ownerItems).toHaveLength(1);
			expect(JSON.stringify(ownerItems[0])).toContain("no test run during this work recorded a pass");
			// No contradiction, so no correction turn.
			expect(
				harness.session.agent.state.messages.filter(
					(message) => message.role === "custom" && message.customType === "claim_delivery",
				),
			).toHaveLength(0);
		});
	});
});
