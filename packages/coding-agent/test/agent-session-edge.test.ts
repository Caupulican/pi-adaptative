import type { AgentTool } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { EDGE_CONFIRMATION_REQUIRED, type EdgeConfirmationRequest } from "../src/core/autonomy/edge-policy.ts";
import type { SemanticDecisionEngine } from "../src/core/decision/engine.ts";
import { createDecisionEvaluation } from "../src/core/decision/evaluation.ts";
import { noulBand } from "../src/core/decision/noul.ts";
import type { DecisionProgram } from "../src/core/decision/program.ts";
import { SystemOneSteeringPlane } from "../src/core/steering/system-one-steering-plane.ts";
import { createHarness } from "./suite/harness.ts";

const bashParameters = Type.Object({ command: Type.String() });

function bashSpy() {
	const commands: string[] = [];
	const tool = {
		name: "bash",
		label: "Bash",
		description: "Run a shell command",
		parameters: bashParameters,
		execute: async (_id: string, args: unknown) => {
			commands.push((args as { command: string }).command);
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		},
	} satisfies AgentTool<typeof bashParameters>;
	return { tool, commands };
}

function lastToolResultText(harness: Awaited<ReturnType<typeof createHarness>>): string {
	const results = harness.session.agent.state.messages.filter((message) => message.role === "toolResult");
	const last = results[results.length - 1];
	if (last?.role !== "toolResult") throw new Error("no tool result");
	return last.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

describe("the edge in a session", () => {
	it("blocks an ungranted edge operation when nobody can answer, and names every way to grant it", async () => {
		const bash = bashSpy();
		const harness = await createHarness({ baseToolsOverride: [bash.tool], settings: { edge: { allow: [] } } });
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf ." })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Done"),
			]);
			await harness.session.prompt("Delete the repository");
			expect(bash.commands).toEqual([]);
			const text = lastToolResultText(harness);
			expect(text).toContain(EDGE_CONFIRMATION_REQUIRED);
			expect(text).toContain("goal grant_edge");
			expect(text).toContain("/edge allow destructive.fs");
		} finally {
			await harness.cleanup();
		}
	});

	it("runs ordinary work and granted classes without asking", async () => {
		const bash = bashSpy();
		const harness = await createHarness({ baseToolsOverride: [bash.tool], settings: { edge: { allow: [] } } });
		let asked = 0;
		harness.session.setEdgeConfirmation(async () => {
			asked++;
			return "deny";
		});
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "npm test" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Done"),
			]);
			await harness.session.prompt("Check the tree");
			expect(bash.commands).toEqual(["npm test"]);
			expect(asked).toBe(0);

			harness.session.grantEdge("destructive.fs", "operator", { note: "release day" });
			expect(harness.session.getEdgeGrants()).toEqual([
				expect.objectContaining({ class: "destructive.fs", source: "operator", note: "release day" }),
			]);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf ." })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Done"),
			]);
			await harness.session.prompt("Delete the repository");
			expect(bash.commands).toEqual(["npm test", "rm -rf ."]);
			expect(asked).toBe(0);

			expect(harness.session.revokeEdge("destructive.fs")).toBe(true);
			expect(harness.session.getEdgeGrants()).toEqual([]);
			expect(harness.session.revokeEdge("destructive.fs")).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("asks the interactive host once: deny blocks, allow once runs, allow for the session records a grant", async () => {
		const bash = bashSpy();
		const harness = await createHarness({ baseToolsOverride: [bash.tool], settings: { edge: { allow: [] } } });
		const requests: EdgeConfirmationRequest[] = [];
		const answers: Array<"deny" | "allow-once" | "allow-session"> = ["deny", "allow-once", "allow-session"];
		harness.session.setEdgeConfirmation(async (request) => {
			requests.push(request);
			return answers.shift() ?? "deny";
		});
		try {
			for (const command of ["rm -rf .", "rm -rf .", "rm -rf .", "rm -rf ."]) {
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
					fauxAssistantMessage("Done"),
				]);
				await harness.session.prompt("Publish");
			}
			expect(requests.map((request) => request.class)).toEqual([
				"destructive.fs",
				"destructive.fs",
				"destructive.fs",
			]);
			expect(requests[0]).toMatchObject({ toolName: "bash", operation: "rm -rf ." });
			// deny → blocked; allow-once → ran; allow-session → ran and granted; fourth → granted, no question.
			expect(bash.commands).toEqual(["rm -rf .", "rm -rf .", "rm -rf ."]);
			expect(harness.session.getEdgeGrants()).toEqual([
				expect.objectContaining({ class: "destructive.fs", source: "operator" }),
			]);
		} finally {
			await harness.cleanup();
		}
	});

	it("honours the machine's standing grants from settings", async () => {
		const bash = bashSpy();
		const harness = await createHarness({
			baseToolsOverride: [bash.tool],
			settings: { edge: { allow: ["destructive.fs", "bogus"] } },
		});
		try {
			expect(harness.session.getEdgeGrants()).toEqual([{ class: "destructive.fs", source: "settings" }]);
			expect(harness.session.revokeEdge("destructive.fs")).toBe(false);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "rm -rf ." })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Done"),
			]);
			await harness.session.prompt("Delete the repository");
			expect(bash.commands).toEqual(["rm -rf ."]);
		} finally {
			await harness.cleanup();
		}
	});

	it("does not treat a scoped operation grant as blanket authority for a different command", async () => {
		const command = "git status --short";
		const bash = bashSpy();
		const harness = await createHarness({ baseToolsOverride: [bash.tool], settings: { edge: { allow: [] } } });
		const probabilities: Readonly<Record<string, number>> = {
			leaves_machine: 0.98,
			cannot_be_undone: 0.01,
			touches_outside_task: 0.01,
			acquires_external_code: 0.01,
			request_authorizes: 0.01,
		};
		let evaluations = 0;
		const decisionEngine: SemanticDecisionEngine = {
			id: "scoped-grant-test",
			model: "faux/scoped-grant-test",
			capabilities: () => ({
				boolean: true,
				choice: true,
				score: true,
				set: true,
				fullDistributions: false,
				parallelIndependentDecisions: true,
				confidenceProvenance: "native_calibrated",
			}),
			async evaluate(program: DecisionProgram) {
				evaluations++;
				const results = Object.fromEntries(
					program.decisions.map(({ id }) => {
						const probabilityTrue = probabilities[id] ?? 0.01;
						return [
							id,
							{
								kind: "boolean" as const,
								probabilityTrue,
								direction: "required_true" as const,
								band: noulBand(probabilityTrue, "required_true"),
								confidence: {
									value: 0.99,
									provenance: "native_calibrated" as const,
									isCalibrated: true,
									noulProbabilityTrue: probabilityTrue,
								},
							},
						];
					}),
				);
				return createDecisionEvaluation({
					programId: program.id,
					programVersion: program.version,
					engineId: this.id,
					model: this.model,
					confidenceProvenance: "native_calibrated",
					results,
				});
			},
		};
		harness.session.attachAdaptiveRuntime({ steeringPlane: new SystemOneSteeringPlane({ decisionEngine }) });
		harness.session.grantEdge("operation.irreversible", "operator", { scopeKey: "different-command-only" });
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Done"),
			]);
			await harness.session.prompt("Summarise the build only; do not send it anywhere.");
			expect(evaluations).toBe(1);
			expect(bash.commands).toEqual([]);
			expect(lastToolResultText(harness)).toContain("System One refused");

			harness.session.grantEdge("operation.irreversible", "operator");
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Done"),
			]);
			await harness.session.prompt("Summarise the build only; do not send it anywhere.");
			expect(evaluations).toBe(1);
			expect(bash.commands).toEqual([command]);
		} finally {
			await harness.cleanup();
		}
	});

	it("records an instruction grant only from the operator's exact words", async () => {
		const harness = await createHarness({ settings: { edge: { allow: [] } } });
		try {
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("goal", {
							action: "grant_edge",
							edgeClass: "git.publish",
							quote: "please push it when you are done",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Noted"),
			]);
			await harness.session.prompt("Fix the typo and push when done");
			expect(lastToolResultText(harness)).toContain("matches the complete quoted statement");
			expect(harness.session.getEdgeGrants()).toEqual([]);

			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("goal", {
							action: "grant_edge",
							edgeClass: "git.publish",
							quote: "Fix the typo and push when done",
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Granted"),
			]);
			await harness.session.prompt("Go ahead");
			expect(lastToolResultText(harness)).toContain("edge granted: git.publish");
			expect(harness.session.getEdgeGrants()).toEqual([
				expect.objectContaining({
					class: "git.publish",
					source: "instructions",
					quote: "Fix the typo and push when done",
				}),
			]);
		} finally {
			await harness.cleanup();
		}
	});
});
