import type { AgentTool } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness } from "./suite/harness.ts";

const bashParameters = Type.Object({ command: Type.String() });

/**
 * The three projection phases that had no producer: DELIVER while an admitted outward-facing tool
 * call runs, BLOCKED on an operator blocker until the owner acts, ADAPT while a capability is
 * synthesized (with one milestone at first sight and one at activation).
 */
describe("operator projection phases reach the projection from their real boundaries", () => {
	it("projects DELIVER while a granted package.publish call runs, and clears a blocker when the owner grants", async () => {
		const phasesDuringTools: string[] = [];
		let session: Awaited<ReturnType<typeof createHarness>>["session"] | undefined;
		const commands: string[] = [];
		const tool = {
			name: "bash",
			label: "Bash",
			description: "Run a shell command",
			parameters: bashParameters,
			execute: async (_id: string, args: unknown) => {
				commands.push((args as { command: string }).command);
				if (session) phasesDuringTools.push(session.operatorProjection.getProjection().phase);
				return { content: [{ type: "text" as const, text: "ok" }], details: {} };
			},
		} satisfies AgentTool<typeof bashParameters>;
		const harness = await createHarness({ baseToolsOverride: [tool], settings: { edge: { allow: [] } } });
		session = harness.session;
		harness.session.setEdgeConfirmation(async () => "deny");
		try {
			harness.session.setOperatorBlocker("git.publish needs you: git push");
			expect(harness.session.operatorProjection.getProjection().phase).toBe("blocked");
			harness.session.grantEdge("package.publish", "operator", { note: "release day" });
			expect(harness.session.operatorProjection.getProjection().phase).not.toBe("blocked");

			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "echo status" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("bash", { command: "npm publish" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Done"),
			]);
			await harness.session.prompt("Publish");
			expect(commands).toEqual(["echo status", "npm publish"]);
			expect(phasesDuringTools[0]).not.toBe("deliver");
			expect(phasesDuringTools[1]).toBe("deliver");
			expect(harness.session.operatorProjection.getProjection().phase).not.toBe("deliver");
		} finally {
			await harness.cleanup();
		}
	});

	it("projects ADAPT while a capability is synthesized, with one milestone at first sight and one at activation", async () => {
		const harness = await createHarness({ settings: { edge: { allow: [] } } });
		try {
			const projection = harness.session.operatorProjection;
			const milestones = () =>
				projection
					.getVisibleEvents()
					.filter((event) => event.category === "adaptation")
					.map((event) => event.title);
			harness.session.setAdaptationProjection({ kind: "capability", label: "cap_1", state: "building" });
			expect(projection.getProjection().phase).toBe("adapt");
			harness.session.setAdaptationProjection({ kind: "capability", label: "cap_1", state: "verifying" });
			expect(milestones()).toEqual(["Capability synthesized · cap_1"]);
			harness.session.setAdaptationProjection({ kind: "capability", label: "cap_1", state: "active" });
			expect(milestones()).toEqual(["Capability synthesized · cap_1", "Capability activated · cap_1"]);
			harness.session.setAdaptationProjection(undefined);
			expect(projection.getProjection().phase).not.toBe("adapt");
			expect(milestones()).toHaveLength(2);
		} finally {
			await harness.cleanup();
		}
	});
});
