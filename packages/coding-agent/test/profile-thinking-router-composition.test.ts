import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Api, Model } from "@caupulican/pi-ai";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RouteDecision } from "../src/core/autonomy/contracts.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

type RoutedTurnPrivateAccess = {
	_runAgentPrompt: (messages: AgentMessage | AgentMessage[]) => Promise<void>;
	_runAgentPromptWithModelRouter: (
		messages: AgentMessage | AgentMessage[],
		routedModel: Model<Api>,
		routeDecision: RouteDecision | undefined,
		persistDecision?: boolean,
	) => Promise<void>;
};

/**
 * Composition (R1 follow-up): the active resource profile sets the SESSION-level thinking via
 * setThinkingLevel (agent.state.thinkingLevel) — see createAgentSession's startup resolution and
 * _reapplyActiveProfileModelSettings. A routed turn's per-tier thinking
 * (modelRouter.cheapThinking/mediumThinking/etc, see _runAgentPromptWithModelRouter) overrides that
 * level for the ONE routed turn only and restores it in the `finally` afterward. Both mechanisms
 * read/write the exact same agent.state.thinkingLevel property, so this proves they compose
 * instead of fighting: the profile-set level survives a routed turn's temporary override.
 */
describe("profile-set session thinking composes with per-tier router thinking", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-profile-router-thinking-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(join(agentDir, "profiles"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ activeResourceProfile: "p" }), "utf-8");
		writeFileSync(
			join(agentDir, "profiles", "p.json"),
			JSON.stringify({ name: "p", thinking: "high", resources: {} }),
			"utf-8",
		);
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("restores the profile-set session thinking level after a routed turn's per-tier override", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();

		const cheapModel = getModel("anthropic", "claude-haiku-4-5")!;
		const expensiveModel = getModel("anthropic", "claude-sonnet-4-5")!;

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: expensiveModel,
			isExplicitModel: true,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});

		// The active profile's thinking applied at startup (no explicit --thinking flag).
		expect(session.thinkingLevel).toBe("high");

		// A per-tier override configured for the cheap route only.
		settingsManager.setModelRouterSettings({ cheapThinking: "low" });

		let thinkingDuringRoutedTurn: string | undefined;
		// Stub the actual model call — the routed-turn swap around it is what's under test.
		(session as unknown as RoutedTurnPrivateAccess)._runAgentPrompt = async () => {
			thinkingDuringRoutedTurn = session.thinkingLevel;
		};

		const route: RouteDecision = {
			tier: "cheap",
			risk: "read-only",
			confidence: 0.9,
			reasonCode: "explain",
			reasons: [],
		};

		await (session as unknown as RoutedTurnPrivateAccess)._runAgentPromptWithModelRouter(
			[],
			cheapModel,
			route,
			false,
		);

		// The per-tier override wins for the duration of the routed turn...
		expect(thinkingDuringRoutedTurn).toBe("low");
		// ...and the profile-set session level is restored afterward.
		expect(session.thinkingLevel).toBe("high");

		session.dispose();
	});
});
