import {
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "@caupulican/pi-agent-core/messages";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	TASK_AUTOMATION_CONTEXT_CLEARED,
	TASK_AUTOMATION_CONTEXT_CUSTOM_TYPE,
	type TaskAutomationContextPlan,
} from "../src/core/automation/task-automation-runtime-adapter.ts";
import type { EdgeGrantView } from "../src/core/autonomy/edge-policy.ts";
import { applyContextGc } from "../src/core/context-gc.ts";
import {
	ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE,
	AUTHORITY_CONTEXT_CLEARED_TEXT,
	AUTHORITY_CONTEXT_CUSTOM_TYPE,
	PATH_ALIAS_LEGEND_CUSTOM_TYPE,
	ProviderRequestContextController,
	type ProviderRequestContextControllerDeps,
} from "../src/core/provider-request-context-controller.ts";
import { SkillVaultController } from "../src/core/skill-vault.ts";
import {
	TASK_DIRECTORY_CONTEXT_CLEARED,
	TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE,
	type TaskDirectoryContextPlan,
} from "../src/core/tasks/task-directory-context.ts";

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

	it("offers the active skill context as a durable record and clears it once the last skill leaves", async () => {
		let section: string | undefined =
			"ACTIVE SKILL test\nBASE /repo/skills/test\nNON-NEGOTIABLE WHILE ACTIVE:\nUse the skill body.";
		let revision = 1;
		const skillVault = {
			previewSystemPromptSection: () => section,
			commitSystemPromptSection: () => section,
			getContextRevision: () => revision,
		} as unknown as SkillVaultController;
		const controller = new ProviderRequestContextController({
			transformExtensions: async (msgs) => ({ messages: msgs, transientMessages: [] }),
			runContextAudit: () => ({}) as any,
			runPromptPolicyPlanning: () => ({}) as any,
			runMemoryRetrieval: async () => ({}) as any,
			applyContextGc: (msgs) =>
				({ messages: msgs, report: {} as any, isCurrent: () => true, commit: () => {} }) as any,
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
		const history: AgentMessage[] = [{ role: "user", content: "hello", timestamp: 1 }];
		const loaded = await controller.plan(history, 0);
		// Never the system prompt: a system-prompt change invalidates the whole cached prefix.
		expect(loaded.transientSystemPrompt).toBeUndefined();
		const skillRecords = (messages: readonly AgentMessage[] | undefined) =>
			(messages ?? []).filter(
				(message): message is AgentMessage & { role: "custom"; content: string } =>
					message.role === "custom" &&
					message.customType === ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE &&
					typeof message.content === "string",
			);
		expect(skillRecords(loaded.transientMessages)).toHaveLength(1);
		expect(skillRecords(loaded.transientMessages)[0]).toMatchObject({ content: section, display: false });
		expect(() => loaded.commit?.()).not.toThrow();

		// The last skill leaves (unload or idle expiry): one explicit cleared record, so the model
		// never trusts the earlier record as current. A vault that never projected a skill offers nothing.
		section = undefined;
		revision = 2;
		const cleared = skillRecords((await controller.plan(history, 0)).transientMessages);
		expect(cleared).toHaveLength(1);
		expect(cleared[0]?.content).toContain("ACTIVE SKILL CONTEXT: none");
		revision = 0;
		expect(skillRecords((await controller.plan(history, 0)).transientMessages)).toEqual([]);
	});

	function createTestController(
		options: { getEdgeGrants?: () => readonly EdgeGrantView[]; skillVault?: SkillVaultController } = {},
	) {
		const skillVault =
			options.skillVault ??
			new SkillVaultController({
				getSkills: () => [],
			});
		return new ProviderRequestContextController({
			transformExtensions: async (msgs) => ({ messages: msgs, transientMessages: [] }),
			runContextAudit: () => ({}) as ReturnType<ProviderRequestContextControllerDeps["runContextAudit"]>,
			runPromptPolicyPlanning: () =>
				({}) as ReturnType<ProviderRequestContextControllerDeps["runPromptPolicyPlanning"]>,
			runMemoryRetrieval: async () =>
				({}) as Awaited<ReturnType<ProviderRequestContextControllerDeps["runMemoryRetrieval"]>>,
			applyContextGc: (msgs) => ({
				messages: msgs,
				report: {} as ReturnType<ProviderRequestContextControllerDeps["applyContextGc"]>["report"],
				isCurrent: () => true,
				commit: () => {},
			}),
			correlatePromptPolicyWithContextGc: () => {},
			runPromptEnforcement: (msgs) => ({
				messages: msgs,
				report: {} as ReturnType<ProviderRequestContextControllerDeps["runPromptEnforcement"]>["report"],
			}),
			enqueueRelevanceCuration: () => {},
			maybeDrainBrainCuration: () => {},
			appendMemoryEvidence: (msgs) => msgs,
			previewReflectionCue: () => undefined,
			getGoalState: () => undefined,
			skillVault,
			getEdgeGrants: options.getEdgeGrants,
			applyPathAliases: (msgs) => ({ messages: msgs }),
		});
	}

	it("omits initial authority and skill context projections on pristine session with no edge grants and no skills", async () => {
		const controller = createTestController({
			getEdgeGrants: () => [],
		});
		const pristineHistory: AgentMessage[] = [{ role: "user", content: "hello", timestamp: 1 }];
		const plan = await controller.plan(pristineHistory, 0);

		const authorityRecord = plan.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE,
		);
		const skillRecord = plan.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE,
		);

		expect(authorityRecord).toBeUndefined();
		expect(skillRecord).toBeUndefined();
	});

	it("conservatively clears authority and active skill after compactionSummary or branchSummary on restart", async () => {
		const compactionHistory: AgentMessage[] = [
			createCompactionSummaryMessage("compacted history summary", 1000, "2026-01-01T00:00:00.000Z"),
			{ role: "user", content: "continue after compaction", timestamp: 2 },
		];

		const freshController = createTestController({
			getEdgeGrants: () => [],
		});
		const plan = await freshController.plan(compactionHistory, 0);

		const authorityRecord = plan.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE,
		);
		const skillRecord = plan.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE,
		);

		expect(authorityRecord).toBeDefined();
		expect((authorityRecord as { content: string }).content).toContain(AUTHORITY_CONTEXT_CLEARED_TEXT);
		expect(skillRecord).toBeDefined();
		expect((skillRecord as { content: string }).content).toContain("ACTIVE SKILL CONTEXT: none");

		const branchHistory: AgentMessage[] = [
			createBranchSummaryMessage("branch summary", "parent-branch", "2026-01-01T00:00:00.000Z"),
			{ role: "user", content: "continue after branch", timestamp: 2 },
		];
		const branchPlan = await createTestController({ getEdgeGrants: () => [] }).plan(branchHistory, 0);
		const branchAuthority = branchPlan.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE,
		);
		const branchSkill = branchPlan.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE,
		);
		expect(branchAuthority).toBeDefined();
		expect((branchAuthority as { content: string }).content).toContain(AUTHORITY_CONTEXT_CLEARED_TEXT);
		expect(branchSkill).toBeDefined();
		expect((branchSkill as { content: string }).content).toContain("ACTIVE SKILL CONTEXT: none");
	});

	it("clears authority and skill context when history contains prior custom records and current state is empty", async () => {
		const controller = createTestController({ getEdgeGrants: () => [] });
		const historyWithPriorRecords: AgentMessage[] = [
			createCustomMessage(
				AUTHORITY_CONTEXT_CUSTOM_TYPE,
				"Active edge grants...",
				false,
				undefined,
				"2026-01-01T00:00:00Z",
			),
			createCustomMessage(
				ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE,
				"ACTIVE SKILL test\n...",
				false,
				undefined,
				"2026-01-01T00:00:00Z",
			),
			{ role: "user", content: "work", timestamp: 2 },
		];
		const plan = await controller.plan(historyWithPriorRecords, 0);

		const authorityRecord = plan.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE,
		);
		const skillRecord = plan.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE,
		);

		expect(authorityRecord).toBeDefined();
		expect((authorityRecord as { content: string }).content).toContain(AUTHORITY_CONTEXT_CLEARED_TEXT);
		expect(skillRecord).toBeDefined();
		expect((skillRecord as { content: string }).content).toContain("ACTIVE SKILL CONTEXT: none");
	});

	it("preserves pure plan generation across rejected/discarded plans without process-local state leakage", async () => {
		let grants: EdgeGrantView[] = [{ class: "git.publish", source: "instructions" }];
		const controller = createTestController({ getEdgeGrants: () => grants });

		const pristineHistory: AgentMessage[] = [{ role: "user", content: "hello", timestamp: 1 }];

		// First plan observes active grants
		const plan1 = await controller.plan(pristineHistory, 0);
		expect(
			plan1.transientMessages?.find((m) => m.role === "custom" && m.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE),
		).toBeDefined();

		// Plan is discarded (never committed), grants revoked:
		grants = [];
		// With pure history (pristine history without committed authority record and no summary marker),
		// the controller must NOT retain process-local state that would pollute pristine history!
		const plan2 = await controller.plan(pristineHistory, 0);
		const authorityRecord2 = plan2.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE,
		);
		expect(authorityRecord2).toBeUndefined();
	});
});

describe("directory request-plan projection", () => {
	function controller(preview: () => TaskDirectoryContextPlan) {
		return new ProviderRequestContextController({
			transformExtensions: async (messages) => ({ messages, transientMessages: [] }),
			runContextAudit: () => ({}) as ReturnType<ProviderRequestContextControllerDeps["runContextAudit"]>,
			runPromptPolicyPlanning: () =>
				({}) as ReturnType<ProviderRequestContextControllerDeps["runPromptPolicyPlanning"]>,
			runMemoryRetrieval: async () =>
				({}) as Awaited<ReturnType<ProviderRequestContextControllerDeps["runMemoryRetrieval"]>>,
			applyContextGc: (messages) => ({
				messages,
				report: {} as ReturnType<ProviderRequestContextControllerDeps["applyContextGc"]>["report"],
				isCurrent: () => true,
				commit: () => {},
			}),
			correlatePromptPolicyWithContextGc: () => {},
			runPromptEnforcement: (messages) => ({
				messages,
				report: {} as ReturnType<ProviderRequestContextControllerDeps["runPromptEnforcement"]>["report"],
			}),
			enqueueRelevanceCuration: () => {},
			maybeDrainBrainCuration: () => {},
			appendMemoryEvidence: (messages) => messages,
			previewTaskDirectoryContext: preview,
			getGoalState: () => undefined,
			skillVault: {
				previewSystemPromptSection: () => undefined,
				commitSystemPromptSection: () => undefined,
				getContextRevision: () => 0,
			} as unknown as SkillVaultController,
			applyPathAliases: (messages) => ({ messages }),
		});
	}

	it("rejects a stale directory plan at acceptance and commit, with a current-plan control", async () => {
		let current = true;
		const planner = controller(() => ({ content: "synthetic directory", isCurrent: () => current }));
		const accepted = await planner.plan([], 0);
		expect(accepted.isCurrent?.()).toBe(true);
		expect(accepted.prepareCommit?.()).toBe(true);
		expect(() => accepted.commit?.()).not.toThrow();
		const stale = await planner.plan([], 0);
		current = false;
		expect(stale.isCurrent?.()).toBe(false);
		expect(stale.prepareCommit?.()).toBe(false);
		expect(() => stale.commit?.()).toThrow("diverged");
	});

	it.each([false, true])(
		"clears missing branch state only when an earlier context record exists (%s)",
		async (previous) => {
			const history = previous
				? [
						createCustomMessage(
							TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE,
							"older pin",
							false,
							undefined,
							"2026-01-01T00:00:00Z",
						),
					]
				: [];
			const plan = await controller(() => ({ content: undefined, isCurrent: () => true })).plan(
				history,
				history.length,
			);
			expect(plan.messages).toEqual(history);
			expect(plan.transientMessages).toEqual(
				previous
					? [
							expect.objectContaining({
								customType: TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE,
								content: TASK_DIRECTORY_CONTEXT_CLEARED,
							}),
						]
					: [],
			);
		},
	);

	it("offers changed context only at the tail and serializes unchanged plans identically", async () => {
		const old = createCustomMessage(
			TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE,
			"old workspace",
			false,
			undefined,
			"2026-01-01T00:00:00Z",
		);
		const history: AgentMessage[] = [old, { role: "user", content: "continue", timestamp: 1 }];
		const planner = controller(() => ({ content: "new workspace", isCurrent: () => true }));
		const first = await planner.plan(history, history.length);
		const second = await planner.plan(history, history.length);
		expect(first.messages).toEqual(history);
		expect(first.messages[0]).toBe(old);
		expect(first.transientSystemPrompt).toBeUndefined();
		expect(first.transientMessages).toEqual([
			expect.objectContaining({
				customType: TASK_DIRECTORY_CONTEXT_CUSTOM_TYPE,
				content: "new workspace",
				display: false,
			}),
		]);
		expect(JSON.stringify(second.transientMessages)).toBe(JSON.stringify(first.transientMessages));
	});
});

describe("task automation request-plan projection", () => {
	function controller(preview: () => TaskAutomationContextPlan) {
		return new ProviderRequestContextController({
			transformExtensions: async (messages) => ({ messages, transientMessages: [] }),
			runContextAudit: () => ({}) as ReturnType<ProviderRequestContextControllerDeps["runContextAudit"]>,
			runPromptPolicyPlanning: () =>
				({}) as ReturnType<ProviderRequestContextControllerDeps["runPromptPolicyPlanning"]>,
			runMemoryRetrieval: async () =>
				({}) as Awaited<ReturnType<ProviderRequestContextControllerDeps["runMemoryRetrieval"]>>,
			applyContextGc: (messages) => ({
				messages,
				report: {} as ReturnType<ProviderRequestContextControllerDeps["applyContextGc"]>["report"],
				isCurrent: () => true,
				commit: () => {},
			}),
			correlatePromptPolicyWithContextGc: () => {},
			runPromptEnforcement: (messages) => ({
				messages,
				report: {} as ReturnType<ProviderRequestContextControllerDeps["runPromptEnforcement"]>["report"],
			}),
			enqueueRelevanceCuration: () => {},
			maybeDrainBrainCuration: () => {},
			appendMemoryEvidence: (messages) => messages,
			previewTaskAutomationContext: preview,
			getGoalState: () => undefined,
			skillVault: {
				previewSystemPromptSection: () => undefined,
				commitSystemPromptSection: () => undefined,
				getContextRevision: () => 0,
			} as unknown as SkillVaultController,
			applyPathAliases: (messages) => ({ messages }),
		});
	}

	it("rejects a stale task automation plan at acceptance and commit, with a current-plan control", async () => {
		let current = true;
		const planner = controller(() => ({ content: "synthetic automation", isCurrent: () => current }));
		const accepted = await planner.plan([], 0);
		expect(accepted.isCurrent?.()).toBe(true);
		expect(accepted.prepareCommit?.()).toBe(true);
		expect(() => accepted.commit?.()).not.toThrow();
		const stale = await planner.plan([], 0);
		current = false;
		expect(stale.isCurrent?.()).toBe(false);
		expect(stale.prepareCommit?.()).toBe(false);
		expect(() => stale.commit?.()).toThrow("diverged");
	});

	it.each([false, true])(
		"clears missing branch state only when an earlier task automation context record exists (%s)",
		async (previous) => {
			const history = previous
				? [
						createCustomMessage(
							TASK_AUTOMATION_CONTEXT_CUSTOM_TYPE,
							"older automation pin",
							false,
							undefined,
							"2026-01-01T00:00:00Z",
						),
					]
				: [];
			const plan = await controller(() => ({ content: undefined, isCurrent: () => true })).plan(
				history,
				history.length,
			);
			expect(plan.messages).toEqual(history);
			expect(plan.transientMessages).toEqual(
				previous
					? [
							expect.objectContaining({
								customType: TASK_AUTOMATION_CONTEXT_CUSTOM_TYPE,
								content: TASK_AUTOMATION_CONTEXT_CLEARED,
							}),
						]
					: [],
			);
		},
	);
});
