import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * F6: strict UAC narrows the loaded skill/prompt/extension surface silently. /context must surface a
 * "N withheld by the active resource profile" observation for each kind — the analog of the
 * withheld-AGENTS.md warning — so a lean profile's effect is visible, not a mystery absence.
 */
describe("profile-denied resources surface in /context", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-denied-resources-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		const skillDir = join(agentDir, "skills", "hidden-skill");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: hidden-skill\ndescription: x\n---\nBody.\n", "utf-8");
		const promptsDir = join(agentDir, "prompts");
		mkdirSync(promptsDir, { recursive: true });
		writeFileSync(join(promptsDir, "hidden-prompt.md"), "---\ndescription: y\n---\nPrompt body.\n", "utf-8");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	const newSession = async (settingsManager: SettingsManager) => {
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
		return session;
	};

	it("reports skills and prompts withheld by a lean profile that grants neither kind", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.addInlineResourceProfileDefinitions({ lean: { tools: { allow: ["read"] } } });
		settingsManager.setRuntimeResourceProfiles(["lean"]);
		const session = await newSession(settingsManager);

		const observations = session.getContextCompositionReport().observations;
		expect(observations.some((line) => /\bskill\(s\) withheld by the active resource profile/.test(line))).toBe(true);
		expect(observations.some((line) => /\bprompt\(s\) withheld by the active resource profile/.test(line))).toBe(
			true,
		);

		session.dispose();
	});

	it("reports nothing withheld when no resource profile is active", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const session = await newSession(settingsManager);

		const observations = session.getContextCompositionReport().observations;
		expect(observations.some((line) => line.includes("withheld by the active resource profile"))).toBe(false);

		session.dispose();
	});
});
