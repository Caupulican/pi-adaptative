import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { type CustomEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import {
	enforceSessionEdge,
	enforceSessionEdgeOperation,
	recordEdgeGrant,
	recordEdgeRevoke,
	type SessionEdgeDeps,
	sessionEdgeGrants,
} from "../src/core/agent-session-edge.ts";
import {
	buildToolkitScriptOperation,
	classifyAllEdgeOperations,
	collectEdgeGrants,
	deriveToolkitScriptScopeKey,
	EDGE_GRANT_CUSTOM_TYPE,
	EDGE_REVOKE_CUSTOM_TYPE,
	type EdgeGrantRecord,
	type EdgeGrantView,
	type EdgeOperation,
	isEdgeOperationGranted,
	resolveToolkitScriptScope,
} from "../src/core/autonomy/edge-policy.ts";
import type { ContextAuditReport } from "../src/core/context/context-audit.ts";
import type { PromptEnforcementReport } from "../src/core/context/context-prompt-enforcement.ts";
import type { PromptPolicyShadowReport } from "../src/core/context/context-prompt-policy.ts";
import type { MemoryRetrievalReport } from "../src/core/context/memory-retrieval.ts";
import type { ContextGcReport, ContextGcResult } from "../src/core/context-gc.ts";
import {
	ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE,
	AUTHORITY_CONTEXT_CLEARED_TEXT,
	AUTHORITY_CONTEXT_CUSTOM_TYPE,
	formatAuthorityContext,
	ProviderRequestContextController,
} from "../src/core/provider-request-context-controller.ts";
import {
	appendSessionSkillExclusion,
	boundReasonInBytes,
	checkSkillEvolutionEligibility,
	decodeSessionSkillPolicyPayload,
	isValidSkillName,
	MAX_SESSION_SKILL_EXCLUSIONS,
} from "../src/core/session-skill-policy.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SkillVaultController } from "../src/core/skill-vault.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { SystemPromptBuilder } from "../src/core/system-prompt-builder.ts";
import { createSkillVaultToolDefinition } from "../src/core/tools/skill.ts";

function createTempSkill(dir: string, name: string, description: string, body: string): string {
	const filePath = join(dir, `${name}.md`);
	writeFileSync(
		filePath,
		`---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`,
	);
	return filePath;
}

function createMockController(
	skillVault: SkillVaultController,
	options: { getEdgeGrants?: () => readonly EdgeGrantView[] } = {},
): ProviderRequestContextController {
	return new ProviderRequestContextController({
		transformExtensions: async (msgs) => ({ messages: msgs, transientMessages: [] }),
		runContextAudit: () => ({}) as unknown as ContextAuditReport,
		runPromptPolicyPlanning: () => ({}) as unknown as PromptPolicyShadowReport,
		runMemoryRetrieval: async () => ({}) as unknown as MemoryRetrievalReport,
		applyContextGc: (msgs) =>
			({
				messages: msgs,
				report: {} as unknown as ContextGcReport,
				isCurrent: () => true,
				commit: () => {},
			}) as unknown as ContextGcResult,
		correlatePromptPolicyWithContextGc: () => {},
		runPromptEnforcement: (msgs) => ({ messages: msgs, report: {} as unknown as PromptEnforcementReport }),
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

describe("owner handoff precedence", () => {
	it.each(["full", "lean", "minimal"] as const)("keeps handed-off authority in the %s prompt", (capability) => {
		const prompt = buildSystemPrompt({
			cwd: "/repo",
			modelCapability: {
				class: capability,
				systemPromptMaxChars: 20_000,
				reasonCode: "test",
				contextWindow: 200_000,
			},
		});
		expect(prompt).toContain("YOLO within the handed-off task");
		expect(prompt).toContain("Owner instructions override conflicting skill/memory approval rules");
		expect(prompt).toContain("Preserve explicit limits and release conditions");
		expect(prompt).not.toContain("authorization rules are never overridable");
	});

	it("includes system prompt guidance for broadcast common-only, targeted assignments, and memory_read broker", () => {
		const settingsManager = SettingsManager.inMemory({
			workerDelegation: { enabled: true },
		});
		const builder = new SystemPromptBuilder({
			getCwd: () => "/repo",
			getSettingsManager: () => settingsManager,
			getResourceLoader: () =>
				({
					getSystemPrompt: () => undefined,
					getAppendSystemPrompt: () => undefined,
					getAgentsFiles: () => ({ agentsFiles: [] }),
					getActiveSkills: () => [],
				}) as never,
			getMemoryManager: () => ({ buildSystemPromptBlock: () => undefined }) as never,
			hasTool: (name) => name === "delegate",
			getToolPromptSnippet: () => undefined,
			getToolPromptGuidelines: () => undefined,
			getModelAdaptationRules: () => [],
			getModelCapabilityProfile: () => ({
				class: "full",
				reasonCode: "test",
				contextWindow: 200_000,
				systemPromptMaxChars: 20_000,
				backgroundLanesEnabled: false,
				laneMaxOutputTokens: 8192,
			}),
			getActiveExtensions: () => [],
			isChildSession: () => false,
		});

		const prompt = builder.rebuildSystemPrompt(["delegate"]);
		expect(prompt).toContain(
			"Use targeted assignments for specific worker tasks; broadcast is for common coordination evidence only.",
		);
		expect(prompt).toContain(
			"Worker memory access is read-only via the memory_read broker; root memory owns mutation and lifecycle.",
		);
	});

	it("loads stale stop-list skills without promoting them above the owner's handoff", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-handoff-skill-"));
		try {
			const filePath = join(root, "SKILL.md");
			writeFileSync(
				filePath,
				"---\nname: autonomous-execution\ndescription: Old autonomy guidance\n---\nThe stop-list is absolute. Ask before installing packages.",
			);
			const vault = new SkillVaultController({
				getSkills: () => [
					{
						name: "autonomous-execution",
						description: "Old autonomy guidance",
						filePath,
						baseDir: root,
						sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
						disableModelInvocation: false,
					},
				],
			});
			expect(vault.load("autonomous-execution", "model").ok).toBe(true);
			const context = vault.commitSystemPromptSection();
			expect(context).toContain("Owner instructions override conflicting skill/memory approval rules:");
			expect(context).not.toContain("NON-NEGOTIABLE WHILE ACTIVE");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("SkillVaultController exclusion lifecycle", () => {
	it("excludes conflicting skills, evicts active slots, and reflects in state", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-exclude-"));
		try {
			const filePath = createTempSkill(root, "stale-skill", "Stale skill", "Stop-list rules.");
			const skills = [
				{
					name: "stale-skill",
					description: "Stale skill",
					filePath,
					baseDir: root,
					sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
					disableModelInvocation: false,
				},
			];
			const vault = new SkillVaultController({ getSkills: () => skills });

			expect(vault.load("stale-skill", "model").ok).toBe(true);
			expect(vault.status().slots).toHaveLength(1);

			const excludeResult = vault.exclude("stale-skill", "Conflicts with owner instruction to proceed autonomously");
			expect(excludeResult.ok).toBe(true);
			expect(vault.isExcluded("stale-skill")).toBe(true);
			expect(vault.status().slots).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("purges excluded skills from available list, search, and snapshot", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-exclude-discovery-"));
		try {
			const file1 = createTempSkill(root, "skill-a", "Skill A", "Body A");
			const file2 = createTempSkill(root, "skill-b", "Skill B", "Body B");
			const skills = [
				{
					name: "skill-a",
					description: "Skill A",
					filePath: file1,
					baseDir: root,
					sourceInfo: createSyntheticSourceInfo(file1, { source: "test" }),
					disableModelInvocation: false,
				},
				{
					name: "skill-b",
					description: "Skill B",
					filePath: file2,
					baseDir: root,
					sourceInfo: createSyntheticSourceInfo(file2, { source: "test" }),
					disableModelInvocation: false,
				},
			];
			const vault = new SkillVaultController({ getSkills: () => skills });

			vault.exclude("skill-a", "Conflict with owner prompt");
			expect(vault.isExcluded("skill-a")).toBe(true);
			expect(vault.isExcluded("skill-b")).toBe(false);
			expect(vault.search("skill").candidates.map((c) => c.name)).toEqual(["skill-b"]);
			expect(vault.getSkillsSnapshot().map((s) => s.name)).toEqual(["skill-b"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses load and read of excluded skills even after file rewrite and root rescan", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-exclude-refusal-"));
		try {
			const filePath = createTempSkill(root, "dangerous-skill", "Stale rules", "Always ask for confirmation.");
			let rescanCalled = false;
			const skills = [
				{
					name: "dangerous-skill",
					description: "Stale rules",
					filePath,
					baseDir: root,
					sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
					disableModelInvocation: false,
				},
			];
			const refresh = () => {
				rescanCalled = true;
			};
			const vault = new SkillVaultController({
				getSkills: () => skills,
				refreshSkills: refresh,
			});

			vault.exclude("dangerous-skill", "Conflict with owner full-auto mandate");

			// load is refused
			const loadResult = vault.load("dangerous-skill", "model");
			expect(loadResult).toMatchObject({
				ok: false,
				reason: "excluded",
			});
			expect((loadResult as { ok: false; message: string }).message).toContain(
				"Conflict with owner full-auto mandate",
			);

			// read is refused
			const readResult = vault.read("dangerous-skill", "model");
			expect(readResult).toMatchObject({
				ok: false,
				reason: "excluded",
			});

			// Rewrite file on disk
			writeFileSync(filePath, "---\nname: dangerous-skill\ndescription: Rewritten\n---\nNew body without asking.");

			// Rescan happens, but load and read still reject because exclusion is session-wide
			refresh();
			expect(rescanCalled).toBe(true);
			const loadAgain = vault.load("dangerous-skill", "model");
			expect(loadAgain.ok).toBe(false);
			expect((loadAgain as { ok: false; reason: string }).reason).toBe("excluded");
			expect(vault.read("dangerous-skill", "model").ok).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects batch load atomically when one skill is excluded", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-batch-exclude-"));
		try {
			const fileSafe = createTempSkill(root, "safe-skill", "Safe", "Safe guidance");
			const fileBad = createTempSkill(root, "bad-skill", "Bad", "Bad guidance");
			const skills = [
				{
					name: "safe-skill",
					description: "Safe",
					filePath: fileSafe,
					baseDir: root,
					sourceInfo: createSyntheticSourceInfo(fileSafe, { source: "test" }),
					disableModelInvocation: false,
				},
				{
					name: "bad-skill",
					description: "Bad",
					filePath: fileBad,
					baseDir: root,
					sourceInfo: createSyntheticSourceInfo(fileBad, { source: "test" }),
					disableModelInvocation: false,
				},
			];
			const vault = new SkillVaultController({ getSkills: () => skills });
			vault.exclude("bad-skill", "Conflicts with instructions");

			const batchResult = vault.loadMany(["safe-skill", "bad-skill"], "model");
			expect(batchResult.ok).toBe(false);
			expect((batchResult as { ok: false; reason: string }).reason).toBe("excluded");

			// Atomicity: safe-skill was NOT loaded
			expect(vault.status().slots).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("SessionManager persistence, branch navigation, and fork isolation", () => {
	it("preserves exclusions across branch navigation and isolates new forks", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-persistence-branch-"));
		try {
			const sm = SessionManager.inMemory(root);
			const prior = sm.appendCustomEntry("review-baseline", {});
			const vault = new SkillVaultController({
				getSkills: () => [],
				getSessionManager: () => sm,
			});

			vault.exclude("stale-skill", "Conflicts with the task handoff");
			expect(vault.isExcluded("stale-skill")).toBe(true);

			const leaf = sm.getLeafId();
			expect(leaf).toBeTruthy();

			// Fork the session at the current leaf
			const fork = sm.createBranchedSessionManager(leaf!);
			const forkVault = new SkillVaultController({
				getSkills: () => [],
				getSessionManager: () => fork,
			});

			// Navigate the original session's branch to prior
			sm.branch(prior);

			// Original session MUST still have the exclusion active (session-wide, not branch-restricted)
			expect(vault.isExcluded("stale-skill")).toBe(true);

			// New fork MUST NOT inherit exclusions from the parent session
			expect(forkVault.isExcluded("stale-skill")).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("session switch clears active slots and exclusions", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-session-switch-"));
		try {
			const sm1 = SessionManager.inMemory(root);
			const sm2 = SessionManager.inMemory(root);

			let currentSm = sm1;
			const vault = new SkillVaultController({
				getSkills: () => [],
				getSessionManager: () => currentSm,
			});

			vault.exclude("session1-skill", "Conflict in session 1");
			expect(vault.isExcluded("session1-skill")).toBe(true);

			// Switch to fresh session 2 via existing getSessionManager closure
			currentSm = sm2;
			expect(vault.isExcluded("session1-skill")).toBe(false);
			expect(vault.getExclusions()).toHaveLength(0);

			// Switch back to session 1 restores session 1 exclusions
			currentSm = sm1;
			expect(vault.isExcluded("session1-skill")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("enforces validation, bounds, and idempotence", () => {
		// Name validation
		expect(isValidSkillName("valid-name")).toBe(true);
		expect(isValidSkillName("")).toBe(false);
		expect(isValidSkillName("   ")).toBe(false);
		expect(isValidSkillName("bad\x00name")).toBe(false);
		expect(isValidSkillName("bad\nname")).toBe(false);

		// Reason bounding
		const largeReason = "x".repeat(10_000);
		const bounded = boundReasonInBytes(largeReason, 512);
		expect(Buffer.byteLength(bounded, "utf-8")).toBeLessThanOrEqual(512);

		// Payload decoding
		const malformed = {
			version: 1,
			sessionId: "test-sess",
			exclusions: [
				{ name: "valid", reason: "ok", excludedAt: "2026-09-12", sessionId: "test-sess" },
				{ name: "valid", reason: "duplicate", excludedAt: "2026-09-12", sessionId: "test-sess" },
				{ name: "bad\x01name", reason: "ctrl", excludedAt: "2026-09-12", sessionId: "test-sess" },
			],
		};
		const decoded = decodeSessionSkillPolicyPayload(malformed, "test-sess");
		expect(decoded).toBeDefined();
		expect(decoded?.exclusions).toHaveLength(1);
		expect(decoded?.exclusions[0]?.name).toBe("valid");

		// Idempotence
		const root = mkdtempSync(join(tmpdir(), "pi-idempotence-"));
		try {
			const sm = SessionManager.inMemory(root);
			const vault = new SkillVaultController({
				getSkills: () => [],
				getSessionManager: () => sm,
			});
			const res1 = vault.exclude("repeated-skill", "Same reason");
			expect(res1.ok).toBe(true);
			const entryCountAfterFirst = sm.getEntryCount();

			const res2 = vault.exclude("repeated-skill", "Same reason");
			expect(res2.ok).toBe(true);
			if (res2.ok) {
				expect(res2.alreadyExcluded).toBe(true);
			}
			// No-op: did not append duplicate entry to session manager
			expect(sm.getEntryCount()).toBe(entryCountAfterFirst);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("ephemeral fallback obeys identical MAX_SESSION_SKILL_EXCLUSIONS ceiling", () => {
		const vault = new SkillVaultController({ getSkills: () => [] });
		for (let i = 0; i < MAX_SESSION_SKILL_EXCLUSIONS; i++) {
			expect(vault.exclude(`skill-${i}`, "Reason").ok).toBe(true);
		}
		expect(vault.getExclusions()).toHaveLength(MAX_SESSION_SKILL_EXCLUSIONS);

		// 65th exclusion on ephemeral fallback must be rejected
		const res65 = vault.exclude("skill-64", "Reason 65");
		expect(res65.ok).toBe(false);
		if (!res65.ok) {
			expect(res65.reason).toBe("persistence_failed");
			expect(res65.message).toContain("Maximum session skill exclusions");
		}
		expect(vault.getExclusions()).toHaveLength(MAX_SESSION_SKILL_EXCLUSIONS);

		// appendSessionSkillExclusion directly throws when 65th exclusion is attempted
		const mockPort = {
			getSessionId: () => "sess-test",
			getEntryCount: () => 0,
			getEntriesSince: () => [],
			appendCustomEntry: () => "id",
		};
		const existing64 = Array.from({ length: MAX_SESSION_SKILL_EXCLUSIONS }, (_, i) => ({
			name: `skill-${i}`,
			reason: "reason",
			excludedAt: new Date().toISOString(),
			sessionId: "sess-test",
		}));
		expect(() => appendSessionSkillExclusion(mockPort, existing64, { name: "skill-65", reason: "overflow" })).toThrow(
			/Maximum session skill exclusions/,
		);
	});
});

describe("self-evolution eligibility gate", () => {
	it("respects explicit autoLearn settings: explicit applyHighConfidence:false wins", () => {
		// Explicit false wins over full mode preset
		expect(checkSkillEvolutionEligibility("full", { enabled: true, applyHighConfidence: false })).toEqual({
			eligible: false,
			reason: "applyHighConfidence is disabled in settings",
		});

		// Explicit enabled: false wins
		expect(checkSkillEvolutionEligibility("full", { enabled: false, applyHighConfidence: true })).toEqual({
			eligible: false,
			reason: "autoLearn is disabled in settings",
		});

		// Autonomy mode off rejects regardless of settings
		expect(checkSkillEvolutionEligibility("off", { enabled: true, applyHighConfidence: true })).toEqual({
			eligible: false,
			reason: "autonomy mode is off; skill evolution requires owner approval",
		});

		// Full mode with default preset permits
		expect(checkSkillEvolutionEligibility("full")).toEqual({
			eligible: true,
			reason: "permitted by autonomy mode full and autoLearn settings",
		});
	});
});

describe("compaction, fork host context projection, and edge grants authority", () => {
	it("emits cleared record when empty fresh vault encounters copied transcript with old active_skill_context", async () => {
		const vault = new SkillVaultController({ getSkills: () => [] });
		const controller = createMockController(vault);

		// Copied history from a parent session containing an old active skill context
		const copiedHistory: AgentMessage[] = [
			{
				role: "custom",
				customType: ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE,
				content: "ACTIVE SKILL old-skill\nBASE /tmp\nOld instructions",
				display: false,
				timestamp: 1,
			},
			{ role: "user", content: "Do work", timestamp: 2 },
		];

		const plan = await controller.plan(copiedHistory, 0);
		const skillContextMsg = plan.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === ACTIVE_SKILL_CONTEXT_CUSTOM_TYPE,
		);
		expect(skillContextMsg).toBeDefined();
		expect((skillContextMsg as { content: string })?.content).toContain("ACTIVE SKILL CONTEXT: none");
	});

	it("projects durable host authority (edge grants) and survives compaction", async () => {
		const vault = new SkillVaultController({ getSkills: () => [] });
		let grants: EdgeGrantView[] = [
			{
				class: "git.publish",
				source: "instructions",
				quote: "deploy to staging branch",
				grantedAt: "2026-09-12T00:00:00.000Z",
			},
		];
		const controller = createMockController(vault, {
			getEdgeGrants: () => grants,
		});

		const beforeCompaction: AgentMessage[] = [
			{ role: "user", content: "Deploy to staging", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "Proceeding with git push." }],
				api: "messages",
				provider: "test-provider",
				model: "test-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 2,
			},
		];

		const plan1 = await controller.plan(beforeCompaction, 0);
		const authorityMsg1 = plan1.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE,
		);
		expect(authorityMsg1).toBeDefined();
		expect((authorityMsg1 as { content: string })?.content).toContain("git.publish");
		expect((authorityMsg1 as { content: string })?.content).toContain('quote: "deploy to staging branch"');

		// After compaction, previous conversation turns are replaced by a summary
		const afterCompaction: AgentMessage[] = [
			{ role: "user", content: "Conversation summary: deploy approved.", timestamp: 3 },
		];

		// Plan after compaction STILL receives host projection of edge grants
		const plan2 = await controller.plan(afterCompaction, 0);
		const authorityMsg2 = plan2.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE,
		);
		expect(authorityMsg2).toBeDefined();
		expect((authorityMsg2 as { content: string })?.content).toContain("git.publish");
		expect((authorityMsg2 as { content: string })?.content).toContain('quote: "deploy to staging branch"');

		// Revoke the grant -> negative control verifies projection updates to cleared text
		grants = [];
		const plan3 = await controller.plan(afterCompaction, 0);
		const authorityMsg3 = plan3.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE,
		);
		expect(authorityMsg3).toBeDefined();
		expect((authorityMsg3 as { content: string })?.content).toContain(AUTHORITY_CONTEXT_CLEARED_TEXT);
	});

	it("preserves trailing release conditions in authority projection and avoids truncated authority", async () => {
		const condition = "ONLY after exact committed candidate passes GitHub CI. Never publish production.";
		const longQuote = `I authorize pushing staging changes. ${"Additional context. ".repeat(14)}${condition}`;
		const vault = new SkillVaultController({ getSkills: () => [] });
		const controller = createMockController(vault, {
			getEdgeGrants: () => [
				{
					class: "git.publish",
					source: "instructions",
					quote: longQuote,
					grantedAt: "2026-09-12T00:00:00.000Z",
				},
			],
		});

		const plan = await controller.plan([{ role: "user", content: "Check status", timestamp: 1 }], 0);
		const authorityMsg = plan.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE,
		);
		expect(authorityMsg).toBeDefined();
		const content = (authorityMsg as { content: string })?.content;
		expect(content).toContain(condition);
		expect(content).toContain("respect explicit conditions and scope");
		expect(content).not.toContain("do not ask permission for these granted operations");

		// Negative control: exceptional quote exceeding capacity does not truncate to misleading prefix
		const massiveQuote = "Condition ".repeat(200); // 2000 chars > 1000 MAX_AUTHORITY_GRANT_FIELD_CHARS
		const massiveContext = formatAuthorityContext([
			{
				class: "git.publish",
				source: "instructions",
				quote: massiveQuote,
				messageEntryId: "entry-123",
				grantedAt: "2026-09-12T00:00:00.000Z",
			},
		]);
		expect(massiveContext).toContain("quote exceeds context projection capacity");
		expect(massiveContext).toContain("inspect durable entry entry-123");
		expect(massiveContext).not.toContain("...");
	});

	it("persists real edge grants on SessionManager branch and replays across compaction", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-edge-grants-branch-"));
		try {
			const sm = SessionManager.inMemory(root);
			const sessionEdgeDeps: SessionEdgeDeps = {
				getBranch: () => sm.getBranch(),
				getSettingsAllow: () => [],
				appendCustomEntry: (customType, data) => sm.appendCustomEntry(customType, data),
				getCwd: () => root,
				isChildSession: () => false,
				getConfirmation: () => undefined,
			};

			expect(sessionEdgeGrants(sessionEdgeDeps)).toHaveLength(0);

			const condition = "ONLY after exact committed candidate passes GitHub CI. Never publish production.";
			recordEdgeGrant(sessionEdgeDeps, "git.publish", "instructions", {
				quote: `Push staging. ${condition}`,
				messageEntryId: "user-turn-1",
			});

			const grantsAfterRecord = sessionEdgeGrants(sessionEdgeDeps);
			expect(grantsAfterRecord).toHaveLength(1);
			expect(grantsAfterRecord[0]?.class).toBe("git.publish");
			expect(grantsAfterRecord[0]?.source).toBe("instructions");
			expect(grantsAfterRecord[0]?.quote).toContain(condition);
			expect(grantsAfterRecord[0]?.messageEntryId).toBe("user-turn-1");

			// Simulate compaction: custom entries on the branch remain active
			sm.appendMessage({ role: "user", content: "Compaction summary: work approved.", timestamp: Date.now() });
			const grantsAfterCompaction = sessionEdgeGrants(sessionEdgeDeps);
			expect(grantsAfterCompaction).toHaveLength(1);
			expect(grantsAfterCompaction[0]?.quote).toContain(condition);

			// Revocation
			const revoked = recordEdgeRevoke(sessionEdgeDeps, "git.publish");
			expect(revoked).toBe(true);
			expect(sessionEdgeGrants(sessionEdgeDeps)).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("distinguishing full inventory for repair from model eligibility", () => {
	it("allows repair of excluded skills via full inventory without restoring model eligibility", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-full-inventory-repair-"));
		try {
			const filePath = createTempSkill(root, "blocked-skill", "Old description", "Old body with prompt.");
			const fullSkills = [
				{
					name: "blocked-skill",
					description: "Old description",
					filePath,
					baseDir: root,
					sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
					disableModelInvocation: false,
				},
			];
			const vault = new SkillVaultController({
				getSkills: () => fullSkills,
				getFullSkills: () => fullSkills,
			});

			vault.exclude("blocked-skill", "Conflicts with autonomy");
			expect(vault.isExcluded("blocked-skill")).toBe(true);
			// Excluded from model discovery
			expect(vault.search("").candidates).toHaveLength(0);

			// Repair succeeds using full inventory and expected version from inspect
			const inspected = vault.inspect("blocked-skill");
			expect(inspected.ok).toBe(true);
			const repairResult = vault.repairSkill({
				name: "blocked-skill",
				body: "New body executing autonomously.",
				expectedVersion: (inspected as { version: string }).version,
				description: "Updated description",
			});
			expect(repairResult.ok).toBe(true);

			// File updated on disk
			expect(readFileSync(filePath, "utf-8")).toContain("New body executing autonomously.");

			// Skill remains excluded in current session
			expect(vault.isExcluded("blocked-skill")).toBe(true);
			expect(vault.search("").candidates).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("skill tool exclude and repair actions with self-evolution gating", () => {
	it("executes exclude action through the skill tool and surfaces evolution eligibility", async () => {
		const settingsManager = SettingsManager.inMemory({
			autonomy: { mode: "full" },
			autoLearn: { enabled: true, applyHighConfidence: true },
		});
		const vault = new SkillVaultController({ getSkills: () => [] });
		const tool = createSkillVaultToolDefinition(vault, {
			getSettingsManager: () => settingsManager,
		});

		const result = await tool.execute(
			"call-1",
			{
				action: "exclude",
				name: "interfering-skill",
				reason: "Owner instructed to skip all user prompts",
			},
			undefined,
			undefined,
			{} as never,
		);

		expect(result.isError).toBeFalsy();
		const text = (result.content[0] as { type: "text"; text: string })?.text;
		expect(text).toContain("skill excluded: interfering-skill");
		expect(text).toContain("Skill evolution: eligible (permitted by autonomy mode full and autoLearn settings)");
		expect(vault.isExcluded("interfering-skill")).toBe(true);
	});

	it("rejects repair when autonomy mode is off or disabled", async () => {
		const settingsManager = SettingsManager.inMemory({
			autonomy: { mode: "off" },
		});
		const root = mkdtempSync(join(tmpdir(), "pi-repair-reject-"));
		try {
			const filePath = createTempSkill(root, "guarded-skill", "Guard", "Old content");
			const vault = new SkillVaultController({
				getSkills: () => [
					{
						name: "guarded-skill",
						description: "Guard",
						filePath,
						baseDir: root,
						sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
						disableModelInvocation: false,
					},
				],
			});
			const tool = createSkillVaultToolDefinition(vault, {
				getSettingsManager: () => settingsManager,
			});

			const result = await tool.execute(
				"call-2",
				{
					action: "repair",
					name: "guarded-skill",
					body: "Repaired content without prompt gates",
				},
				undefined,
				undefined,
				{} as never,
			);

			expect(result.isError).toBe(true);
			const text = (result.content[0] as { type: "text"; text: string })?.text;
			expect(text).toContain("skill repair rejected: skill evolution is not permitted");
			// File on disk was untouched
			expect(readFileSync(filePath, "utf-8")).toContain("Old content");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("permits repair in full autonomy mode, writes to disk, and keeps skill excluded in current session", async () => {
		const settingsManager = SettingsManager.inMemory({
			autonomy: { mode: "full" },
			autoLearn: { enabled: true, applyHighConfidence: true },
		});
		const root = mkdtempSync(join(tmpdir(), "pi-repair-permit-"));
		try {
			const filePath = createTempSkill(root, "evolve-skill", "Old description", "Always ask for confirmation.");
			let skills = [
				{
					name: "evolve-skill",
					description: "Old description",
					filePath,
					baseDir: root,
					sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
					disableModelInvocation: false,
				},
			];
			const vault = new SkillVaultController({
				getSkills: () => skills,
				refreshSkills: () => {
					skills = [
						{
							name: "evolve-skill",
							description: "Updated description",
							filePath,
							baseDir: root,
							sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
							disableModelInvocation: false,
						},
					];
				},
			});

			// Skill was previously excluded
			vault.exclude("evolve-skill", "Conflicts with autonomy");
			expect(vault.isExcluded("evolve-skill")).toBe(true);

			const tool = createSkillVaultToolDefinition(vault, {
				getSettingsManager: () => settingsManager,
			});

			const inspectResult = await tool.execute(
				"call-inspect",
				{ action: "inspect", name: "evolve-skill" },
				undefined,
				undefined,
				{} as never,
			);
			expect(inspectResult.isError).toBeFalsy();
			const versionToken = (inspectResult.details as { action: "inspect"; result: { ok: true; version: string } })
				.result.version;

			const result = await tool.execute(
				"call-3",
				{
					action: "repair",
					name: "evolve-skill",
					description: "Updated description",
					body: "Execute without confirmation when within explicit owner task bounds.",
					expectedVersion: versionToken,
				},
				undefined,
				undefined,
				{} as never,
			);

			expect(result.isError).toBeFalsy();
			const text = (result.content[0] as { type: "text"; text: string })?.text;
			expect(text).toContain("skill repaired: evolve-skill");
			expect(text).toContain("Note: skill remains excluded in this session.");

			// File on disk was updated atomically
			const fileContent = readFileSync(filePath, "utf-8");
			expect(fileContent).toContain("Execute without confirmation when within explicit owner task bounds.");
			expect(fileContent).toContain("Updated description");

			// Skill remains excluded in this session
			expect(vault.isExcluded("evolve-skill")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("displays exclusions in skill status text", async () => {
		const vault = new SkillVaultController({ getSkills: () => [] });
		vault.exclude("slow-skill", "Exceeded speed requirements");
		const tool = createSkillVaultToolDefinition(vault);

		const result = await tool.execute("call-4", { action: "status" }, undefined, undefined, {} as never);
		expect(result.isError).toBeFalsy();
		const text = (result.content[0] as { type: "text"; text: string })?.text;
		expect(text).toContain("skill state: unloaded");
		expect(text).toContain("exclusions (conflict with owner instructions):");
		expect(text).toContain("- slow-skill: Exceeded speed requirements");
	});

	it("detects stale source modifications during repair and allows inspecting excluded source", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-stale-repair-"));
		try {
			const filePath = createTempSkill(root, "concurrent-skill", "Desc", "Original body");
			const skills = [
				{
					name: "concurrent-skill",
					description: "Desc",
					filePath,
					baseDir: root,
					sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
					disableModelInvocation: false,
				},
			];
			const vault = new SkillVaultController({ getSkills: () => skills });
			vault.exclude("concurrent-skill", "Conflicted with instructions");

			// read() refuses excluded skill
			expect(vault.read("concurrent-skill").ok).toBe(false);

			// inspect() allows inspecting source without reactivating and returns version
			const inspected = vault.inspect("concurrent-skill");
			expect(inspected.ok).toBe(true);
			expect(vault.isExcluded("concurrent-skill")).toBe(true);
			if (inspected.ok) {
				expect(inspected.version).toBeDefined();
				// Stale source detection: passing an outdated expectedVersion fails
				const staleRepair = vault.repairSkill({
					name: "concurrent-skill",
					body: "New body",
					expectedVersion: `${inspected.version}-outdated`,
				});
				expect(staleRepair.ok).toBe(false);
				expect((staleRepair as { reason: string }).reason).toBe("stale_source");

				// Fresh repair with matching version succeeds
				const freshRepair = vault.repairSkill({
					name: "concurrent-skill",
					body: "New body",
					expectedVersion: inspected.version,
				});
				expect(freshRepair.ok).toBe(true);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("inspects and repairs skills through the real tool route with concurrent change detection", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-real-tool-repair-"));
		try {
			const filePath = createTempSkill(root, "active-skill", "Desc", "Original Body");
			const skills = [
				{
					name: "active-skill",
					description: "Desc",
					filePath,
					baseDir: root,
					sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
					disableModelInvocation: false,
				},
			];
			const vault = new SkillVaultController({ getSkills: () => skills });
			const settingsManager = SettingsManager.inMemory({
				autonomy: { mode: "full" },
			});
			const tool = createSkillVaultToolDefinition(vault, {
				getSettingsManager: () => settingsManager,
			});

			// 1. Inspect through the real tool route
			const inspectRes = await tool.execute(
				"call-inspect",
				{ action: "inspect", name: "active-skill" },
				undefined,
				undefined,
				{} as never,
			);
			expect(inspectRes.isError).toBeFalsy();
			const inspectText = (inspectRes.content[0] as { type: "text"; text: string })?.text;
			expect(inspectText).toContain("skill: active-skill");
			const details = inspectRes.details as { action: "inspect"; result: { ok: true; version: string } };
			expect(details.result.version).toBeDefined();
			const originalVersion = details.result.version;

			// 2. Simulate concurrent change on disk by updating mtime
			utimesSync(filePath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));

			// 3. Repair with original stale version fails with stale_source
			const staleRepairRes = await tool.execute(
				"call-stale-repair",
				{
					action: "repair",
					name: "active-skill",
					body: "Repaired body content",
					expectedVersion: originalVersion,
				},
				undefined,
				undefined,
				{} as never,
			);
			expect(staleRepairRes.isError).toBeTruthy();
			const staleText = (staleRepairRes.content[0] as { type: "text"; text: string })?.text;
			expect(staleText).toContain("Skill source has changed on disk");
			expect((staleRepairRes.details as { result: { reason: string } }).result.reason).toBe("stale_source");

			// 4. Re-inspect to obtain fresh version
			const reInspectRes = await tool.execute(
				"call-reinspect",
				{ action: "inspect", name: "active-skill" },
				undefined,
				undefined,
				{} as never,
			);
			const freshVersion = (reInspectRes.details as { action: "inspect"; result: { ok: true; version: string } })
				.result.version;

			// 5. Repair with fresh version succeeds and preserves frontmatter
			const freshRepairRes = await tool.execute(
				"call-fresh-repair",
				{
					action: "repair",
					name: "active-skill",
					body: "Repaired body content",
					expectedVersion: freshVersion,
				},
				undefined,
				undefined,
				{} as never,
			);
			expect(freshRepairRes.isError).toBeFalsy();
			const freshText = (freshRepairRes.content[0] as { type: "text"; text: string })?.text;
			expect(freshText).toContain("skill repaired: active-skill");
			expect(freshText).not.toContain("remains excluded");

			const updatedOnDisk = readFileSync(filePath, "utf-8");
			expect(updatedOnDisk).toContain("---");
			expect(updatedOnDisk).toContain("Repaired body content");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("detects stale source when content changed even if timestamp was restored, with unchanged negative control", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-restored-mtime-repair-"));
		try {
			const filePath = createTempSkill(root, "digest-skill", "Desc", "Original Body");
			const originalContent = readFileSync(filePath, "utf-8");
			const skills = [
				{
					name: "digest-skill",
					description: "Desc",
					filePath,
					baseDir: root,
					sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
					disableModelInvocation: false,
				},
			];
			const vault = new SkillVaultController({ getSkills: () => skills });
			const settingsManager = SettingsManager.inMemory({
				autonomy: { mode: "full" },
			});
			const tool = createSkillVaultToolDefinition(vault, {
				getSettingsManager: () => settingsManager,
			});

			// Anchor exact millisecond timestamp before inspect
			const fixedTime = new Date(1700000000000);
			utimesSync(filePath, fixedTime, fixedTime);

			// 1. Inspect to get version token with content digest
			const inspectRes = await tool.execute(
				"call-inspect",
				{ action: "inspect", name: "digest-skill" },
				undefined,
				undefined,
				{} as never,
			);
			expect(inspectRes.isError).toBeFalsy();
			const details = inspectRes.details as { action: "inspect"; result: { ok: true; version: string } };
			const inspectedVersion = details.result.version;
			expect(inspectedVersion).toContain(":");

			const originalStat = statSync(filePath);
			expect(originalStat.mtimeMs).toBe(1700000000000);

			// 2. Modify content on disk, then explicitly restore mtime to the exact original timestamp
			writeFileSync(
				filePath,
				"---\nname: digest-skill\ndescription: Desc\n---\n\nModified content with restored timestamp\n",
			);
			utimesSync(filePath, fixedTime, fixedTime);
			const currentStat = statSync(filePath);
			expect(currentStat.mtimeMs).toBe(originalStat.mtimeMs);

			// 3. Repair with inspectedVersion must fail because content digest changed despite restored mtime
			const tamperedRepairRes = await tool.execute(
				"call-tampered-repair",
				{
					action: "repair",
					name: "digest-skill",
					body: "Repaired body",
					expectedVersion: inspectedVersion,
				},
				undefined,
				undefined,
				{} as never,
			);
			expect(tamperedRepairRes.isError).toBeTruthy();
			expect((tamperedRepairRes.details as { result: { reason: string } }).result.reason).toBe("stale_source");

			// 4. Unchanged negative control: restore original content + timestamp, repair succeeds
			writeFileSync(filePath, originalContent);
			utimesSync(filePath, originalStat.atime, originalStat.mtime);
			const controlRepairRes = await tool.execute(
				"call-control-repair",
				{
					action: "repair",
					name: "digest-skill",
					body: "Successfully repaired body",
					expectedVersion: inspectedVersion,
				},
				undefined,
				undefined,
				{} as never,
			);
			expect(controlRepairRes.isError).toBeFalsy();
			expect((controlRepairRes.details as { result: { ok: boolean } }).result.ok).toBe(true);
			const repairedOnDisk = readFileSync(filePath, "utf-8");
			expect(repairedOnDisk).toContain("Successfully repaired body");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("maintains pure authority projection across discarded previews, new controllers, and revocations", async () => {
		const vault = new SkillVaultController({ getSkills: () => [] });
		let grants: EdgeGrantView[] = [
			{
				class: "git.publish",
				source: "instructions",
				quote: "staging deployment",
				grantedAt: "2026-09-12T00:00:00.000Z",
			},
		];

		const controller1 = createMockController(vault, {
			getEdgeGrants: () => grants,
		});

		const messages: AgentMessage[] = [{ role: "user", content: "status", timestamp: 1 }];

		// 1. Discarded preview: plan() without commit() does not mutate controller state
		const preview1 = await controller1.plan(messages, 0);
		expect(preview1.isCurrent?.()).toBe(true);
		// Discard preview1 without commit

		// 2. Planning again on same controller yields exact same result
		const preview2 = await controller1.plan(messages, 0);
		expect(preview2.isCurrent?.()).toBe(true);
		const authMsg1 = preview2.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE,
		);
		expect((authMsg1 as { content: string })?.content).toContain("staging deployment");

		// 3. New controller instance on the same session state produces identical pure projection
		const controller2 = createMockController(vault, {
			getEdgeGrants: () => grants,
		});
		const preview3 = await controller2.plan(messages, 0);
		const authMsg2 = preview3.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE,
		);
		expect((authMsg2 as { content: string })?.content).toContain("staging deployment");

		// 4. Revocation: grants cleared -> projects cleared text
		grants = [];
		const preview4 = await controller2.plan(messages, 0);
		const authMsg3 = preview4.transientMessages?.find(
			(m) => m.role === "custom" && m.customType === AUTHORITY_CONTEXT_CUSTOM_TYPE,
		);
		expect((authMsg3 as { content: string })?.content).toBe(AUTHORITY_CONTEXT_CLEARED_TEXT);

		// 5. Currency validation: changing grants between plan and commit marks plan stale
		grants = [
			{
				class: "package.install",
				source: "instructions",
				quote: "install approved package",
				grantedAt: "2026-09-12T00:01:00.000Z",
			},
		];
		const planToCommit = await controller2.plan(messages, 0);
		expect(planToCommit.isCurrent?.()).toBe(true);
		expect(planToCommit.prepareCommit?.()).toBe(true);

		// Grants change before commit
		grants = [];
		expect(planToCommit.isCurrent?.()).toBe(false);
		expect(planToCommit.prepareCommit?.()).toBe(false);
		expect(() => planToCommit.commit?.()).toThrow("diverged");
	});

	it("rejects repair with oversized description leaving original file untouched, with small metadata negative control", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-oversized-desc-"));
		try {
			const filePath = createTempSkill(root, "oversized-skill", "Original Desc", "Original body");
			const originalContent = readFileSync(filePath, "utf-8");
			const skills = [
				{
					name: "oversized-skill",
					description: "Original Desc",
					filePath,
					baseDir: root,
					sourceInfo: createSyntheticSourceInfo(filePath, { source: "test" }),
					disableModelInvocation: false,
				},
			];
			const vault = new SkillVaultController({ getSkills: () => skills });

			const inspected = vault.inspect("oversized-skill");
			expect(inspected.ok).toBe(true);
			const version = (inspected as { version: string }).version;

			// Oversized description exceeding MAX_SKILL_DESCRIPTION_LENGTH (1024 chars)
			const oversizedDesc = "A".repeat(1025);
			const failedRepair = vault.repairSkill({
				name: "oversized-skill",
				body: "Attempted new body",
				expectedVersion: version,
				description: oversizedDesc,
			});
			expect(failedRepair.ok).toBe(false);
			expect((failedRepair as { reason: string }).reason).toBe("invalid_body");

			// Crucial assertion: original file on disk is left completely untouched
			const diskContentAfterFailure = readFileSync(filePath, "utf-8");
			expect(diskContentAfterFailure).toBe(originalContent);

			// Small metadata negative control: valid short description succeeds
			const successRepair = vault.repairSkill({
				name: "oversized-skill",
				body: "Repaired valid body",
				expectedVersion: version,
				description: "Short clean description",
			});
			expect(successRepair.ok).toBe(true);
			const diskContentAfterSuccess = readFileSync(filePath, "utf-8");
			expect(diskContentAfterSuccess).toContain("Short clean description");
			expect(diskContentAfterSuccess).toContain("Repaired valid body");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("edge authority, scoped grants, and canonical operation lifecycle", () => {
	it("deriveToolkitScriptScopeKey resolves relative path against supplied cwd and preserves case and argv", () => {
		const scope1 = deriveToolkitScriptScopeKey({
			cwd: "/workspace/proj-a",
			scriptPath: "scripts/deploy.py",
			runner: "uv",
			scriptName: "deploy-service",
			argv: ["--stage", "production"],
		});
		const scope2 = deriveToolkitScriptScopeKey({
			cwd: "/workspace/proj-b",
			scriptPath: "scripts/deploy.py",
			runner: "uv",
			scriptName: "deploy-service",
			argv: ["--stage", "production"],
		});
		// Different execution cwd produces different scope keys even if scriptPath is identical
		expect(scope1).not.toBe(scope2);
		expect(scope1).toMatch(/^toolkit:deploy-service:[0-9a-f]{64}$/);

		// Case sensitivity
		const scopeLower = deriveToolkitScriptScopeKey({
			cwd: "/workspace/proj-a",
			scriptPath: "scripts/deploy.py",
			runner: "uv",
			scriptName: "deploy-service",
			argv: ["--stage", "production"],
		});
		const scopeUpper = deriveToolkitScriptScopeKey({
			cwd: "/workspace/proj-a",
			scriptPath: "scripts/DEPLOY.PY",
			runner: "uv",
			scriptName: "deploy-service",
			argv: ["--stage", "production"],
		});
		expect(scopeLower).not.toBe(scopeUpper);

		// buildToolkitScriptOperation uses deriveToolkitScriptScopeKey
		const op = buildToolkitScriptOperation({
			cwd: "/workspace/proj-a",
			script: { name: "deploy-service", runner: "uv", path: "scripts/deploy.py" },
			args: ["--stage", "production"],
		});
		expect(op.class).toBe("toolkit.script");
		expect(op.scopeKey).toBe(scope1);
		expect(op.operation).toBe("deploy-service --stage production");
	});

	it("rejects malformed scopeKey wholesale in grantRecord and collectEdgeGrants, never broadening", () => {
		// Valid broad grant
		const validBroad = collectEdgeGrants(
			[
				{
					type: "custom",
					customType: EDGE_GRANT_CUSTOM_TYPE,
					data: { version: 1, class: "toolkit.script", source: "operator" },
				},
			],
			[],
		);
		expect(validBroad).toHaveLength(1);
		expect(validBroad[0]?.scopeKey).toBeUndefined();

		// Malformed scope values: number, null, object, empty string, whitespace string, bad version
		const malformedEntries = [
			{ version: 1, class: "toolkit.script", source: "operator", scopeKey: 123 },
			{ version: 1, class: "toolkit.script", source: "operator", scopeKey: null },
			{ version: 1, class: "toolkit.script", source: "operator", scopeKey: {} },
			{ version: 1, class: "toolkit.script", source: "operator", scopeKey: "" },
			{ version: 1, class: "toolkit.script", source: "operator", scopeKey: "   " },
			{ version: 2, class: "toolkit.script", source: "operator", scopeKey: "toolkit:valid:12345" },
		];

		for (const malformedData of malformedEntries) {
			const result = collectEdgeGrants(
				[{ type: "custom", customType: EDGE_GRANT_CUSTOM_TYPE, data: malformedData }],
				[],
			);
			// Must NOT be broadened into a class grant, must be completely rejected
			expect(result).toHaveLength(0);
		}

		// Malformed revoke also rejected wholesale
		const broadGrant = { version: 1, class: "toolkit.script", source: "operator" };
		const malformedRevoke = { version: 1, class: "toolkit.script", scopeKey: "" };
		const afterMalformedRevoke = collectEdgeGrants(
			[
				{ type: "custom", customType: EDGE_GRANT_CUSTOM_TYPE, data: broadGrant },
				{ type: "custom", customType: EDGE_REVOKE_CUSTOM_TYPE, data: malformedRevoke },
			],
			[],
		);
		// Malformed revoke does not remove the broad grant
		expect(afterMalformedRevoke).toHaveLength(1);
	});

	it("classifies multi-edge command crossing both destructive.fs and settings.authority and requires both grants", async () => {
		const cwd = "/workspace/project";
		const taskCwd = "/workspace/project/subtask";
		const agentDir = "/workspace/project/.agent";
		const settingsFile = "/workspace/project/.agent/settings.json";

		const operations = classifyAllEdgeOperations({
			toolName: "bash",
			args: { command: `rm ${settingsFile}` },
			cwd,
			scopeCwd: taskCwd,
			agentDir,
		});

		// Both edges detected
		const classes = operations.map((op) => op.class);
		expect(classes).toContain("destructive.fs");
		expect(classes).toContain("settings.authority");

		// Partial grant: granting only destructive.fs blocks on settings.authority
		const depsPartial: SessionEdgeDeps = {
			getBranch: () => [],
			getSettingsAllow: () => ["destructive.fs"],
			appendCustomEntry: () => {},
			getCwd: () => taskCwd,
			isChildSession: () => true, // Non-interactive fails closed
			getConfirmation: () => undefined,
		};
		const resultPartial = await enforceSessionEdge(
			depsPartial,
			"bash",
			{ command: `rm ${settingsFile}` },
			cwd,
			undefined,
		);
		expect(resultPartial?.block).toBe(true);
		expect(resultPartial?.reason).toContain("settings.authority");

		// Both granted: passes
		const depsBoth: SessionEdgeDeps = {
			getBranch: () => [],
			getSettingsAllow: () => ["destructive.fs", "settings.authority"],
			appendCustomEntry: () => {},
			getCwd: () => taskCwd,
			isChildSession: () => true,
			getConfirmation: () => undefined,
		};
		const resultBoth = await enforceSessionEdge(depsBoth, "bash", { command: `rm ${settingsFile}` }, cwd, undefined);
		expect(resultBoth).toBeUndefined();
	});

	it("resolveToolkitScriptScope resolves exact script, aliases, and rejects ambiguous or unknown requests", () => {
		const scripts = [
			{
				name: "restore-db",
				description: "Restore database",
				runner: "powershell" as const,
				path: "scripts/restore.ps1",
				aliases: ["reset-db"],
			},
			{ name: "backup-db", description: "Backup database", runner: "bash" as const, path: "scripts/backup.sh" },
			{
				name: "backup-all",
				description: "Backup all databases",
				runner: "bash" as const,
				path: "scripts/backup_all.sh",
			},
		];
		const cwd = "/workspace/project";

		// Exact name
		const exact = resolveToolkitScriptScope("restore-db", ["--quick"], scripts, cwd);
		expect("scopeKey" in exact).toBe(true);
		if ("scopeKey" in exact) {
			const expectedKey = deriveToolkitScriptScopeKey({
				cwd,
				scriptPath: "scripts/restore.ps1",
				runner: "powershell",
				scriptName: "restore-db",
				argv: ["--quick"],
			});
			expect(exact.scopeKey).toBe(expectedKey);
		}

		// Alias
		const alias = resolveToolkitScriptScope("reset-db", [], scripts, cwd);
		expect("scopeKey" in alias).toBe(true);

		// Unknown
		const unknown = resolveToolkitScriptScope("nonexistent-script", [], scripts, cwd);
		expect("error" in unknown).toBe(true);
		if ("error" in unknown) {
			expect(unknown.error).toContain("unknown");
		}

		// Empty/whitespace
		const empty = resolveToolkitScriptScope("   ", [], scripts, cwd);
		expect("error" in empty).toBe(true);
		if ("error" in empty) {
			expect(empty.error).toContain("non-empty");
		}
	});

	it("supports multiple scoped grants, scoped revocation, and broad class override", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-scoped-grants-"));
		try {
			const sm = SessionManager.inMemory(root);
			const deps: SessionEdgeDeps = {
				getBranch: () => sm.getBranch(),
				getSettingsAllow: () => [],
				appendCustomEntry: (customType, data) => sm.appendCustomEntry(customType, data),
				getCwd: () => root,
				isChildSession: () => false,
				getConfirmation: () => undefined,
			};

			const scope1 = "toolkit:restore-db:1111111111111111111111111111111111111111111111111111111111111111";
			const scope2 = "toolkit:deploy-db:2222222222222222222222222222222222222222222222222222222222222222";

			recordEdgeGrant(deps, "toolkit.script", "operator", { scopeKey: scope1 });
			recordEdgeGrant(deps, "toolkit.script", "operator", { scopeKey: scope2 });

			let grants = sessionEdgeGrants(deps);
			expect(grants).toHaveLength(2);

			const op1: EdgeOperation = {
				class: "toolkit.script",
				operation: "restore-db",
				reason: "test",
				scopeKey: scope1,
			};
			const op2: EdgeOperation = {
				class: "toolkit.script",
				operation: "deploy-db",
				reason: "test",
				scopeKey: scope2,
			};
			const op3: EdgeOperation = {
				class: "toolkit.script",
				operation: "other-db",
				reason: "test",
				scopeKey: "toolkit:other:333",
			};

			expect(isEdgeOperationGranted(op1, grants)).toBe(true);
			expect(isEdgeOperationGranted(op2, grants)).toBe(true);
			expect(isEdgeOperationGranted(op3, grants)).toBe(false);

			// Scoped revoke removes only op1
			recordEdgeRevoke(deps, "toolkit.script", scope1);
			grants = sessionEdgeGrants(deps);
			expect(grants).toHaveLength(1);
			expect(isEdgeOperationGranted(op1, grants)).toBe(false);
			expect(isEdgeOperationGranted(op2, grants)).toBe(true);

			// Broad grant covers any scopeKey
			recordEdgeGrant(deps, "toolkit.script", "operator");
			grants = sessionEdgeGrants(deps);
			expect(isEdgeOperationGranted(op1, grants)).toBe(true);
			expect(isEdgeOperationGranted(op2, grants)).toBe(true);
			expect(isEdgeOperationGranted(op3, grants)).toBe(true);

			// Broad revoke removes all grants for the class
			recordEdgeRevoke(deps, "toolkit.script");
			grants = sessionEdgeGrants(deps);
			expect(grants).toHaveLength(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("worker edge boundary enforces parent grants and fails closed without interactive confirmation leakage", async () => {
		const cwd = "/workspace/project";
		const parentScopeKey = "toolkit:restore-db:abc123def456";
		const ungrantedOp: EdgeOperation = {
			class: "toolkit.script",
			operation: "drop-db",
			reason: "dangerous",
			scopeKey: "toolkit:drop-db:999999",
		};

		// Worker deps are child session: isChildSession() === true
		let confirmationCalled = false;
		const workerDeps: SessionEdgeDeps = {
			getBranch: () => [],
			getSettingsAllow: () => [],
			appendCustomEntry: () => {},
			getCwd: () => cwd,
			isChildSession: () => true, // Worker is a child session!
			getConfirmation: () => async () => {
				confirmationCalled = true;
				return "allow-once";
			},
		};

		const grantEntry: CustomEntry<EdgeGrantRecord> = {
			id: "entry-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			type: "custom",
			customType: EDGE_GRANT_CUSTOM_TYPE,
			data: {
				version: 1,
				class: "toolkit.script",
				source: "operator",
				scopeKey: parentScopeKey,
				grantedAt: new Date().toISOString(),
			},
		};

		// Granted scoped operation in worker passes without confirmation
		const grantedResult = await enforceSessionEdgeOperation(
			{
				...workerDeps,
				getBranch: () => [grantEntry],
			},
			{ class: "toolkit.script", operation: "restore-db", reason: "deploy", scopeKey: parentScopeKey },
			"run_toolkit_script",
		);
		expect(grantedResult.authorized).toBe(true);
		expect(confirmationCalled).toBe(false);

		// Ungranted operation in worker fails closed immediately; handler is NEVER called
		const ungrantedResult = await enforceSessionEdgeOperation(workerDeps, ungrantedOp, "run_toolkit_script");
		expect(ungrantedResult.authorized).toBe(false);
		expect(confirmationCalled).toBe(false);
		expect(ungrantedResult.reason).toContain("needs the operator");
	});

	it("classifies direct argv run_process commands literally without reparsing arguments as shell", async () => {
		const cwd = "/workspace/project";

		// 1. Literal git push in run_process is classified as git.publish
		const gitOps = classifyAllEdgeOperations({
			toolName: "run_process",
			args: { executable: "git", args: ["push", "origin", "main"] },
			cwd,
			scopeCwd: cwd,
		});
		expect(gitOps).toHaveLength(1);
		expect(gitOps[0]?.class).toBe("git.publish");
		expect(gitOps[0]?.operation).toBe("git push origin main");

		// 2. Executable with directory path /usr/bin/git is recognized
		const pathGitOps = classifyAllEdgeOperations({
			toolName: "run_process",
			args: { executable: "/usr/bin/git", args: ["push", "origin", "main"] },
			cwd,
			scopeCwd: cwd,
		});
		expect(pathGitOps).toHaveLength(1);
		expect(pathGitOps[0]?.class).toBe("git.publish");

		// 3. printf argument containing dangerous shell text is NEVER reparsed as shell
		const printfOps = classifyAllEdgeOperations({
			toolName: "run_process",
			args: { executable: "printf", args: ["git push origin main && npm publish"] },
			cwd,
			scopeCwd: cwd,
		});
		expect(printfOps).toHaveLength(0);

		// 4. Session edge enforcement on run_process
		const depsDenied: SessionEdgeDeps = {
			getBranch: () => [],
			getSettingsAllow: () => [],
			appendCustomEntry: () => {},
			getCwd: () => cwd,
			isChildSession: () => true,
			getConfirmation: () => undefined,
		};
		const blocked = await enforceSessionEdge(
			depsDenied,
			"run_process",
			{ executable: "git", args: ["push", "origin", "main"] },
			cwd,
			undefined,
		);
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("git.publish");

		// 5. Granted git.publish allows run_process
		const depsGranted: SessionEdgeDeps = {
			...depsDenied,
			getSettingsAllow: () => ["git.publish"],
		};
		const allowed = await enforceSessionEdge(
			depsGranted,
			"run_process",
			{ executable: "git", args: ["push", "origin", "main"] },
			cwd,
			undefined,
		);
		expect(allowed).toBeUndefined();

		// 6. Safe printf with embedded shell syntax is allowed without grants
		const printfAllowed = await enforceSessionEdge(
			depsDenied,
			"run_process",
			{ executable: "printf", args: ["git push origin main && npm publish"] },
			cwd,
			undefined,
		);
		expect(printfAllowed).toBeUndefined();
	});
});
