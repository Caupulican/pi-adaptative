import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import {
	DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE,
	DEFAULT_WORKER_DELEGATION_ENABLED,
	SettingsManager,
} from "../src/core/settings-manager.ts";
import { AUTONOMY_MODES, AutoLearnController } from "../src/modes/interactive/auto-learn-controller.ts";

/**
 * Self-adaptation (native reflection + learningPolicy) is on by default for a
 * fresh session in every autonomy mode (the preset lattice must stay monotonic — increasing autonomy
 * from "off" must never silently lose the self-adaptation loop), without dragging
 * autonomy.mode/delegation/goal-autonomy along, and every kill switch still disables it.
 */
describe("self-adaptation defaults on", () => {
	let tempDir: string;
	let originalNativeReflectionEnv: string | undefined;

	// dirTag isolates each session's on-disk settings under its own subdirectory of tempDir, so
	// looping over multiple modes/controllers in one test never has one call's persisted settings
	// (e.g. a kill-switch override) bleed into the next call's "fresh session" read.
	const newController = async (dirTag = "default") => {
		const dir = join(tempDir, dirTag);
		const dirAgentDir = join(dir, "agent");
		mkdirSync(dirAgentDir, { recursive: true });
		const settingsManager = SettingsManager.create(dir, dirAgentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dirAgentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dirAgentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});
		const controller = new AutoLearnController({
			getSession: () => session,
			resolveSelfModificationSource: () => undefined,
			ui: {
				showStatus: () => {},
				footerDataProvider: { setExtensionStatus: () => {} },
				invalidateFooter: () => {},
				requestRender: () => {},
			},
		});
		return { controller, settingsManager, session };
	};

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-learning-defaults-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		originalNativeReflectionEnv = process.env.PI_NATIVE_REFLECTION;
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		if (originalNativeReflectionEnv === undefined) delete process.env.PI_NATIVE_REFLECTION;
		else process.env.PI_NATIVE_REFLECTION = originalNativeReflectionEnv;
	});

	it("a fresh SettingsManager resolves learningPolicy.enabled to true", () => {
		expect(SettingsManager.inMemory().getLearningPolicySettings().enabled).toBe(true);
	});

	it("a fresh session's native reflection gate is on by default, with autonomy.mode left at 'off'", async () => {
		const { controller, settingsManager, session } = await newController();
		expect(settingsManager.getAutonomySettings().mode).toBe("off");
		expect(controller.getEffectiveAutoLearnSettings().enabled).toBe(true);
		expect(controller.isNativeReflectionEnabled()).toBe(true);
		session.dispose();
	});

	it("every autonomy mode defaults self-adaptation on (monotonic lattice), and kill switches still win in each", async () => {
		for (const mode of AUTONOMY_MODES) {
			const { controller, settingsManager, session } = await newController(mode);
			settingsManager.setAutonomySettings({ mode });

			// Increasing autonomy from "off" must never silently disable the self-adaptation loop.
			expect(controller.getEffectiveAutoLearnSettings().enabled).toBe(true);
			expect(controller.isNativeReflectionEnabled()).toBe(true);

			// The explicit kill switch still wins regardless of which mode is active.
			settingsManager.setAutoLearnSettings({ enabled: false });
			expect(controller.getEffectiveAutoLearnSettings().enabled).toBe(false);
			expect(controller.isNativeReflectionEnabled()).toBe(false);

			session.dispose();
		}
	});

	it("PI_NATIVE_REFLECTION=0 disables native reflection even though the default is on", async () => {
		const { controller, session } = await newController();
		process.env.PI_NATIVE_REFLECTION = "0";
		expect(controller.isNativeReflectionEnabled()).toBe(false);
		session.dispose();
	});

	it("explicit learningPolicy.enabled=false overrides the new default", () => {
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setLearningPolicySettings({ enabled: false });
		expect(settingsManager.getLearningPolicySettings().enabled).toBe(false);
	});

	it("explicit AutoLearnSettings.enabled=false overrides the preset default", async () => {
		const { controller, settingsManager, session } = await newController();
		settingsManager.setAutoLearnSettings({ enabled: false });
		expect(controller.getEffectiveAutoLearnSettings().enabled).toBe(false);
		expect(controller.isNativeReflectionEnabled()).toBe(false);
		session.dispose();
	});

	it("does not drag delegation or goal-autonomy defaults along with the flip", async () => {
		const { settingsManager, session } = await newController();
		expect(settingsManager.getAutonomySettings().mode).toBe("off");
		expect(settingsManager.getAutonomySettings().goalAutoContinue).toBe(DEFAULT_AUTONOMY_GOAL_AUTO_CONTINUE);
		expect(settingsManager.getWorkerDelegationSettings().enabled).toBe(DEFAULT_WORKER_DELEGATION_ENABLED);
		session.dispose();
	});
});
