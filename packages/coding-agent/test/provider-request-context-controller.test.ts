import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { describe, expect, it } from "vitest";
import {
	PATH_ALIAS_LEGEND_CUSTOM_TYPE,
	ProviderRequestContextController,
} from "../src/core/provider-request-context-controller.ts";
import type { SkillVaultController } from "../src/core/skill-vault.ts";

describe("ProviderRequestContextController", () => {
	it("commits without crashing when path aliases are dynamically pruned by GC", async () => {
		const mockMessages: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "Look at p/src/foo.ts" }],
				timestamp: 1,
			},
		];

		// We mock the dependencies to simulate the GC and Alias lifecycle.
		const controller = new ProviderRequestContextController({
			transformBase: async (msgs) => msgs,
			transformExtensions: async (msgs) => ({ messages: msgs, transientMessages: [] }),
			runContextAudit: () => ({}) as any,
			runPromptPolicyPlanning: () => ({}) as any,
			runMemoryRetrieval: async () => ({}) as any,
			applyContextGc: (msgs) => ({ messages: msgs, report: {} as any }),
			correlatePromptPolicyWithContextGc: () => {},
			runPromptEnforcement: (msgs) => ({ messages: msgs, report: {} as any }),
			enqueueRelevanceCuration: () => {},
			maybeDrainBrainCuration: () => {},
			appendMemoryEvidence: (msgs) => msgs,
			previewReflectionCue: () => undefined,
			getGoalState: () => undefined,
			skillVault: {
				previewSystemPromptSection: () => undefined,
				commitSystemPromptSection: () => undefined,
				getContextRevision: () => 1,
			} as unknown as SkillVaultController,

			// Simulate the new dynamic aliasing logic:
			// The current payload contains "p/src/foo.ts", so the dynamically scoped legend only contains that.
			applyPathAliases: (msgs) => ({
				messages: msgs,
				legend: "PATH ALIASES\np/src/foo.ts=/full/src/foo.ts",
			}),
		});

		// 1. Generate the plan (Preview phase)
		const plan = await controller.plan(mockMessages);

		// 2. The legend rides at the TAIL as a transient message, never in the system prompt: a new
		// alias must not invalidate the provider's cached prefix from byte zero (prefix-stability.ts).
		expect(plan.transientSystemPrompt).toBeUndefined();
		const legendMessage = plan.transientMessages?.at(-1);
		expect(legendMessage).toMatchObject({
			role: "custom",
			customType: PATH_ALIAS_LEGEND_CUSTOM_TYPE,
			content: "PATH ALIASES\np/src/foo.ts=/full/src/foo.ts",
		});

		// 3. Prepare commit should pass
		expect(plan.prepareCommit?.()).toBe(true);

		// 4. Commit should NOT throw an error!
		// (In the buggy code, commit() called a hardcoded peekPathAliasLegend() which would dump all
		// historical aliases, mismatching transientSystemPrompt and crashing.)
		expect(() => plan.commit?.()).not.toThrow();
	});
});
