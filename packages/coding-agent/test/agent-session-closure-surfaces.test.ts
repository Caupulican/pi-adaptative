/**
 * The session surfaces the release closure added (RCG-010..RCG-055).
 *
 * Part of the verification-harness coverage set: these are the branches AgentSession gained for
 * durable owner rules, project-rule hooks, worker supervision, acquisition screening, the live
 * operator projection and semantic-plane health.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROJECT_RULE_REPAIR_CUSTOM_TYPE } from "../src/core/project-rules/session-project-rules.ts";
import { semanticPlaneHealthLabel } from "../src/core/system-one/semantic-plane-health.ts";
import { createRcSdkHarness } from "./suite/rc-sdk-harness.ts";

const AGENTS_MD = ["## Code Quality", "- Never use inline imports (`await import()`)."].join("\n");

describe("Session closure surfaces", () => {
	it("records an owner development directive and ignores an ordinary request", async () => {
		const harness = await createRcSdkHarness();
		harness.replyWith("ok", "ok");

		await harness.session.prompt("add a button to the settings screen");
		expect(harness.session.getOwnerRulePolicies()).toEqual([]);

		await harness.session.prompt("no TDD, mandatory, fast paced only");
		expect(harness.session.getOwnerRulePolicies()).toHaveLength(1);
		expect(harness.session.renderOwnerRulesForMission()).toContain("MANDATORY OWNER DEVELOPMENT RULES");
	});

	it("blocks a rule-violating mutation through the live tool gate and queues repair work", async () => {
		const harness = await createRcSdkHarness({ agentsFiles: [{ path: "AGENTS.md", content: AGENTS_MD }] });
		const violating = join(harness.cwd, "offender.ts");
		writeFileSync(violating, "const mod = await import('./x.ts');\n");

		const gate = (
			harness.session as unknown as {
				_toolGate: {
					afterToolCall(input: unknown): Promise<{ isError?: boolean } | undefined>;
				};
			}
		)._toolGate;
		const blocked = await gate.afterToolCall({
			toolCall: { id: "call-1", name: "write", arguments: { path: violating } },
			args: { path: violating },
			result: { content: [{ type: "text", text: "wrote" }] },
			isError: false,
		});

		expect(blocked?.isError).toBe(true);
		expect(harness.session.getQueuedRuleRepairWork()).toHaveLength(1);
		expect(
			harness.session.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === PROJECT_RULE_REPAIR_CUSTOM_TYPE),
		).toBe(true);
	});

	it("leaves a compliant mutation and a non-mutating tool untouched", async () => {
		const harness = await createRcSdkHarness({ agentsFiles: [{ path: "AGENTS.md", content: AGENTS_MD }] });
		const clean = join(harness.cwd, "clean.ts");
		writeFileSync(clean, "import { join } from 'node:path';\nexport const p = join('a');\n");

		const gate = (
			harness.session as unknown as {
				_toolGate: { afterToolCall(input: unknown): Promise<{ isError?: boolean } | undefined> };
			}
		)._toolGate;
		const compliant = await gate.afterToolCall({
			toolCall: { id: "call-1", name: "write", arguments: { path: clean } },
			args: { path: clean },
			result: { content: [{ type: "text", text: "wrote" }] },
			isError: false,
		});
		expect(compliant?.isError).not.toBe(true);

		const reading = await gate.afterToolCall({
			toolCall: { id: "call-2", name: "read", arguments: { path: clean } },
			args: { path: clean },
			result: { content: [{ type: "text", text: "contents" }] },
			isError: false,
		});
		expect(reading?.isError).not.toBe(true);
		expect(harness.session.getQueuedRuleRepairWork()).toEqual([]);
	});

	it("screens an acquisition-shaped command at the boundary and passes ordinary work", async () => {
		const harness = await createRcSdkHarness({ prompt: "build and test the project" });
		const gate = (
			harness.session as unknown as {
				_toolGate: {
					beforeToolCall(input: unknown, signal?: AbortSignal): Promise<{ block?: boolean } | undefined>;
				};
			}
		)._toolGate;
		const assistantMessage = { provider: "faux", model: "faux-model" };

		const ordinary = await gate.beforeToolCall({
			toolCall: { id: "call-1", name: "bash", arguments: {} },
			args: { command: "npm test" },
			assistantMessage,
		});
		expect(ordinary?.block).not.toBe(true);

		const acquiring = await gate.beforeToolCall({
			toolCall: { id: "call-2", name: "bash", arguments: {} },
			args: { command: "npm install left-pad@1.3.0" },
			assistantMessage,
		});
		expect(acquiring?.block).toBe(true);
		expect(harness.session.acquisitionGate?.getRecords().length).toBeGreaterThan(0);
	});

	it("moves the live projection through its real phases", async () => {
		const harness = await createRcSdkHarness();
		const projection = () => harness.session.operatorProjection.getProjection();
		expect(projection().phase).toBe("understand");

		harness.session.setAdaptationProjection({ kind: "specialist", label: "css-specialist", state: "planning" });
		expect(projection().phase).toBe("adapt");
		harness.session.setAdaptationProjection({ kind: "capability", label: "cap-x", state: "active" });
		expect(projection().phase).toBe("adapt");
		harness.session.setAdaptationProjection(undefined);

		harness.session.setDeliveryState("in_progress");
		expect(projection().phase).toBe("deliver");
		harness.session.setDeliveryState("none");

		harness.session.setOperatorBlocker("charter denies push");
		expect(projection().health).toBe("blocked");
		harness.session.setOperatorBlocker(undefined);
		expect(projection().phase).toBe("understand");

		expect(harness.session.operatorProjection.getVisibleEvents().length).toBeGreaterThan(0);
	});

	it("reports the semantic plane's observed health", async () => {
		const harness = await createRcSdkHarness();
		expect(semanticPlaneHealthLabel(harness.session.getSemanticPlaneHealth())).toBe("JEV ready");

		const engine = (
			harness.session as unknown as {
				_semanticDecisionEngine(): { evaluate(p: unknown, s: unknown, o: unknown): Promise<unknown> } | undefined;
			}
		)._semanticDecisionEngine();
		await engine?.evaluate(
			{
				schema_version: "1.0",
				program_id: "probe",
				description: "probe",
				decisions: [{ id: "q", instruction: "is it so?" }],
			},
			{},
			{},
		);
		expect(harness.session.getSemanticPlaneHealth().state).toBe("ok");
	});

	it("observes worker progress through the supervision coordinator", async () => {
		// A normally-progressing worker: no gap, no stall, no repetition.
		const harness = await createRcSdkHarness({
			decisions: { fallback: { kind: "boolean", probabilityTrue: 0.05 } },
		});
		const observed = await harness.session.workerSupervision.observe({
			agentId: "agent-1",
			objectiveId: "obj-1",
			taskId: "task-1",
			attemptId: "att-1",
			role: "implementer",
			mission: "implement",
			toolCalls: 6,
			elapsedMs: 30_000,
			changedFiles: [],
			recentFailures: [],
		});
		expect(observed?.action).toBe("continue");
		expect(observed?.summaryEvent).toBeUndefined();
		expect(harness.session.workerSupervision.getPendingRootRequests()).toEqual([]);

		// A worker the engine says needs a specialist becomes a root request, not a local action.
		const escalating = await createRcSdkHarness({
			decisions: { fallback: { kind: "boolean", probabilityTrue: 0.95 } },
		});
		const request = await escalating.session.workerSupervision.observe({
			agentId: "agent-2",
			objectiveId: "obj-2",
			taskId: "task-2",
			attemptId: "att-2",
			role: "implementer",
			mission: "implement",
			toolCalls: 6,
			elapsedMs: 30_000,
			changedFiles: [],
			recentFailures: [],
		});
		expect(request?.action).toBe("request_specialist");
		expect(escalating.session.workerSupervision.getPendingRootRequests()).toHaveLength(1);
	});
});
