import type { AgentTool } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { EDGE_CONFIRMATION_REQUIRED, type EdgeConfirmationRequest } from "../src/core/autonomy/edge-policy.ts";
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
		const harness = await createHarness({ tools: [bash.tool] });
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "git push origin main" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Done"),
			]);
			await harness.session.prompt("Push the branch");
			expect(bash.commands).toEqual([]);
			const text = lastToolResultText(harness);
			expect(text).toContain(EDGE_CONFIRMATION_REQUIRED);
			expect(text).toContain("goal grant_edge");
			expect(text).toContain("/edge allow git.publish");
		} finally {
			await harness.cleanup();
		}
	});

	it("runs ordinary work and granted classes without asking", async () => {
		const bash = bashSpy();
		const harness = await createHarness({ tools: [bash.tool] });
		let asked = 0;
		harness.session.setEdgeConfirmation(async () => {
			asked++;
			return "deny";
		});
		try {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "git status && npm install" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Done"),
			]);
			await harness.session.prompt("Check the tree");
			expect(bash.commands).toEqual(["git status && npm install"]);
			expect(asked).toBe(0);

			harness.session.grantEdge("git.publish", "operator", { note: "release day" });
			expect(harness.session.getEdgeGrants()).toEqual([
				expect.objectContaining({ class: "git.publish", source: "operator", note: "release day" }),
			]);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "git push" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Done"),
			]);
			await harness.session.prompt("Push");
			expect(bash.commands).toEqual(["git status && npm install", "git push"]);
			expect(asked).toBe(0);

			expect(harness.session.revokeEdge("git.publish")).toBe(true);
			expect(harness.session.getEdgeGrants()).toEqual([]);
			expect(harness.session.revokeEdge("git.publish")).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("asks the interactive host once: deny blocks, allow once runs, allow for the session records a grant", async () => {
		const bash = bashSpy();
		const harness = await createHarness({ tools: [bash.tool] });
		const requests: EdgeConfirmationRequest[] = [];
		const answers: Array<"deny" | "allow-once" | "allow-session"> = ["deny", "allow-once", "allow-session"];
		harness.session.setEdgeConfirmation(async (request) => {
			requests.push(request);
			return answers.shift() ?? "deny";
		});
		try {
			for (const command of ["npm publish", "npm publish", "npm publish", "npm publish"]) {
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
					fauxAssistantMessage("Done"),
				]);
				await harness.session.prompt("Publish");
			}
			expect(requests.map((request) => request.class)).toEqual([
				"package.publish",
				"package.publish",
				"package.publish",
			]);
			expect(requests[0]).toMatchObject({ toolName: "bash", operation: "npm publish" });
			// deny → blocked; allow-once → ran; allow-session → ran and granted; fourth → granted, no question.
			expect(bash.commands).toEqual(["npm publish", "npm publish", "npm publish"]);
			expect(harness.session.getEdgeGrants()).toEqual([
				expect.objectContaining({ class: "package.publish", source: "operator" }),
			]);
		} finally {
			await harness.cleanup();
		}
	});

	it("honours the machine's standing grants from settings", async () => {
		const bash = bashSpy();
		const harness = await createHarness({
			tools: [bash.tool],
			settings: { edge: { allow: ["git.publish", "bogus"] } },
		});
		try {
			expect(harness.session.getEdgeGrants()).toEqual([{ class: "git.publish", source: "settings" }]);
			expect(harness.session.revokeEdge("git.publish")).toBe(false);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "git push --tags" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Done"),
			]);
			await harness.session.prompt("Push tags");
			expect(bash.commands).toEqual(["git push --tags"]);
		} finally {
			await harness.cleanup();
		}
	});

	it("records an instruction grant only from the operator's exact words", async () => {
		const harness = await createHarness();
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
