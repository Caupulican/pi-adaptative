import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { applyContextGc } from "../src/core/context-gc.ts";
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
			applyContextGc: (msgs) => ({ messages: msgs, report: {} as any, isCurrent: () => true, commit: () => {} }),
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
		const plan = await controller.plan(mockMessages, 0);

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

	it("rebuilds the path-alias legend message byte-identically across independent plan() calls with unchanged content", async () => {
		const mockMessages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text: "Look at p/src/foo.ts" }], timestamp: 1 },
		];
		const controller = new ProviderRequestContextController({
			transformBase: async (msgs) => msgs,
			transformExtensions: async (msgs) => ({ messages: msgs, transientMessages: [] }),
			runContextAudit: () => ({}) as any,
			runPromptPolicyPlanning: () => ({}) as any,
			runMemoryRetrieval: async () => ({}) as any,
			applyContextGc: (msgs) => ({ messages: msgs, report: {} as any, isCurrent: () => true, commit: () => {} }),
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
			// A fixed legend, exactly as the runtime would hand back when nothing new has been minted
			// between two provider requests.
			applyPathAliases: (msgs) => ({
				messages: msgs,
				legend: "PATH ALIASES\np/src/foo.ts=/full/src/foo.ts",
			}),
		});

		// Two fully independent builds of the SAME logical transient (as happen turn after turn while
		// the alias table is unchanged). The A1 contract: unchanged content must serialize to the exact
		// same bytes, never differing only by a build-time timestamp — otherwise the provider's prefix
		// cache is invalidated on every single request for no observable reason.
		const first = await controller.plan(mockMessages, 0);
		const second = await controller.plan(mockMessages, 0);

		const firstLegend = first.transientMessages?.at(-1);
		const secondLegend = second.transientMessages?.at(-1);
		expect(firstLegend).toMatchObject({ customType: PATH_ALIAS_LEGEND_CUSTOM_TYPE });
		expect(JSON.stringify(secondLegend)).toBe(JSON.stringify(firstLegend));
	});

	it("A3: the real context-gc pass never packs a message below sentPrefixCount, and preview/commit agree", async () => {
		function staleToolResult(index: number): ToolResultMessage {
			return {
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "bash",
				content: [{ type: "text", text: `output ${index}\n${"0123456789abcdef".repeat(80)}` }],
				isError: false,
				timestamp: index,
			};
		}
		// Five otherwise-identical, otherwise-packable stale tool results. sentPrefixCount=3 must
		// freeze indices 0-2 and leave 3-4 eligible, through the REAL applyContextGc (not a stub),
		// wired exactly as ProviderRequestContextController's own production deps wire it.
		const mockMessages: AgentMessage[] = Array.from({ length: 5 }, (_, index) => staleToolResult(index));
		const skillVault = {
			previewSystemPromptSection: () => undefined,
			commitSystemPromptSection: () => undefined,
			getContextRevision: () => 1,
		} as unknown as SkillVaultController;
		const controller = new ProviderRequestContextController({
			transformExtensions: async (msgs) => ({ messages: msgs, transientMessages: [] }),
			runContextAudit: () => ({}) as any,
			runPromptPolicyPlanning: () => ({}) as any,
			runMemoryRetrieval: async () => ({}) as any,
			applyContextGc: (msgs, writePayloads, frozenBelow) =>
				applyContextGc(msgs, {
					cwd: "/repo",
					preserveRecentMessages: 0,
					minToolResultChars: 10,
					tools: ["bash"],
					writePayloads,
					frozenBelow,
					semanticMemory: { preserveRecentPages: 0, minChars: Number.MAX_SAFE_INTEGER },
				}),
			correlatePromptPolicyWithContextGc: () => {},
			runPromptEnforcement: (msgs) => ({ messages: msgs, report: {} as any }),
			enqueueRelevanceCuration: () => {},
			maybeDrainBrainCuration: () => {},
			appendMemoryEvidence: (msgs) => msgs,
			previewReflectionCue: () => undefined,
			getGoalState: () => undefined,
			skillVault,
			applyPathAliases: (msgs) => ({ messages: msgs }),
		});

		const plan = await controller.plan(mockMessages, 3);

		// The preview already reflects the freeze: the first 3 messages are byte-identical to the
		// input (never packed), the last 2 are packed (their content changed).
		expect(plan.messages[0]).toEqual(mockMessages[0]);
		expect(plan.messages[1]).toEqual(mockMessages[1]);
		expect(plan.messages[2]).toEqual(mockMessages[2]);
		expect(plan.messages[3]).not.toEqual(mockMessages[3]);
		expect(plan.messages[4]).not.toEqual(mockMessages[4]);

		// Preview and commit must reach the identical decision: prepareCommit()'s own internal
		// isDeepStrictEqual check is exactly the desync guard the A3 contract requires.
		expect(plan.prepareCommit?.()).toBe(true);
		expect(() => plan.commit?.()).not.toThrow();
	});
});
