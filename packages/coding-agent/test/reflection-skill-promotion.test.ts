import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SKILL_OVERLAP_CONSOLIDATION_REASON_CODE } from "../src/core/reflection-controller.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * R7 memory-to-behavior: a reflection that emits a `promote_skill` write compiles the recurring
 * procedure into a loadable SKILL.md under the agent's skills directory.
 */
describe("reflection skill promotion (R7)", () => {
	let tempDir: string;
	let agentDir: string;
	let previousEnvAgentDir: string | undefined;

	const reply = (jsonBody: string): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text: `\`\`\`json\n${jsonBody}\n\`\`\`` }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-promote-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		// The skill_audit overlap check resolves the skills-universe agent dir via ENV_AGENT_DIR /
		// getAgentDir() (config.ts) rather than the session's configured `agentDir` — in production the
		// two are always the same path (main.ts derives both from getAgentDir()), but a test with an
		// isolated agentDir must pin the env var too, or the audit silently reads the real machine's
		// ~/.pi/agent/skills instead of the fixture below.
		previousEnvAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		if (previousEnvAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previousEnvAgentDir;
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("writes a SKILL.md when reflection promotes a recurring workflow", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		// Legacy direct-apply path under test — pin learningPolicy off explicitly now that it defaults on.
		settingsManager.setLearningPolicySettings({ enabled: false });
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});

		(session.agent as unknown as { streamFn: unknown }).streamFn = async () =>
			({
				result: async () =>
					reply(
						JSON.stringify({
							rationale: "recurring release workflow",
							writes: [
								{
									kind: "promote_skill",
									name: "Release Flow",
									description: "How to cut a patch release",
									body: "1. Run the full test suite.\n2. Update the changelog.\n3. Run npm run release:patch.",
								},
							],
						}),
					),
			}) as never;

		await session.runReflectionPass({
			signals: {
				trigger: "complex",
				toolCallCount: 12,
				hadCorrection: false,
				contextHeadroomPct: 90,
				usefulLately: 0,
			},
			recentTurnText: "user: we just cut a release by running tests then release:patch",
			reportId: "t1",
		});

		// The promoted skill was compiled to a loadable SKILL.md (name kebab-cased).
		const skillFile = join(agentDir, "skills", "release-flow", "SKILL.md");
		expect(existsSync(skillFile)).toBe(true);
		const content = readFileSync(skillFile, "utf-8");
		expect(content).toContain("name: release-flow");
		expect(content).toContain("How to cut a patch release");
		expect(content).toContain("npm run release:patch");

		session.dispose();
	});

	/**
	 * Automatic promotion must clear the same skill_audit overlap check the model-invoked
	 * `skillify` tool enforces (tools/skill-audit.ts's runSkillAudit) — a draft that near-duplicates an
	 * existing skill is never blind-written; it routes to a consolidation proposal instead.
	 */
	it("routes an overlapping skill to a consolidation proposal instead of a blind write", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setLearningPolicySettings({ enabled: false });

		// An existing hand-authored skill covering the same release-flow procedure as the draft below.
		// Its name+description keywords overlap the draft's name+description+body keywords well above
		// skill_audit's 0.55 near-duplicate Jaccard threshold (verified ~0.69 for this exact fixture).
		const existingSkillDir = join(agentDir, "skills", "release-workflow");
		mkdirSync(existingSkillDir, { recursive: true });
		writeFileSync(
			join(existingSkillDir, "SKILL.md"),
			[
				"---",
				"name: release-workflow",
				'description: "How to cut a patch release: run the full test suite, update the changelog, then run npm run release:patch"',
				"---",
				"",
				"Existing hand-authored release procedure.",
			].join("\n"),
			"utf-8",
		);

		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});

		(session.agent as unknown as { streamFn: unknown }).streamFn = async () =>
			({
				result: async () =>
					reply(
						JSON.stringify({
							rationale: "recurring release workflow",
							writes: [
								{
									kind: "promote_skill",
									name: "Release Flow",
									description: "How to cut a patch release",
									body: "1. Run the full test suite.\n2. Update the changelog.\n3. Run npm run release:patch.",
								},
							],
						}),
					),
			}) as never;

		await session.runReflectionPass({
			signals: {
				trigger: "complex",
				toolCallCount: 12,
				hadCorrection: false,
				contextHeadroomPct: 90,
				usefulLately: 0,
			},
			recentTurnText: "user: we just cut a release by running tests then release:patch",
			reportId: "t2",
		});

		// No blind write: the overlapping draft never lands as its own SKILL.md.
		const skillFile = join(agentDir, "skills", "release-flow", "SKILL.md");
		expect(existsSync(skillFile)).toBe(false);
		// The existing skill it overlaps with is untouched.
		expect(existsSync(join(existingSkillDir, "SKILL.md"))).toBe(true);

		// The overlap is recorded as a consolidation proposal — observable, gated, never silently
		// dropped — rather than a generic write failure.
		const records = session.getLearningAuditRecords();
		const proposal = records.find((r) => r.reasonCode === SKILL_OVERLAP_CONSOLIDATION_REASON_CODE);
		expect(proposal).toBeDefined();
		expect(proposal?.action).toBe("propose");
		expect(proposal?.summary).toContain("release-workflow");

		session.dispose();
	});
});
