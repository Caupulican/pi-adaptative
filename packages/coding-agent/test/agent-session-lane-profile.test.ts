import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@caupulican/pi-agent-core";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProfilesDir } from "../src/config.ts";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SUBAGENT_CORE_SYSTEM_PROMPT } from "../src/core/autonomy/subagent-prompt.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const RESEARCH_JSON = '{"findings":[{"summary":"profile-shipped finding","confidence":0.9}]}';

describe("profile-shipped lanes", () => {
	let tempDir: string;
	let agentDir: string;
	let faux: FauxProviderRegistration;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-lane-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		faux = registerFauxProvider({
			models: [
				{ id: "session-model", contextWindow: 200_000 },
				{ id: "scout-model", contextWindow: 200_000 },
			],
		});
		faux.setResponses([]);
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		faux.unregister();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	function writeProfile(name: string, definition: Record<string, unknown>): void {
		const profilesDir = getProfilesDir(agentDir);
		mkdirSync(profilesDir, { recursive: true });
		writeFileSync(join(profilesDir, `${name}.json`), JSON.stringify(definition));
	}

	async function newSession(settings: Partial<Settings>): Promise<AgentSession> {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		for (const [key, value] of Object.entries(settings)) {
			// Apply test settings through the manager's typed setters where they exist.
			if (key === "researchLane") settingsManager.setResearchLaneSettings(value as never);
			else if (key === "workerDelegation") settingsManager.setWorkerDelegationSettings(value as never);
			else if (key === "autonomy") settingsManager.setAutonomySettings(value as never);
		}
		const sessionModel = faux.getModel("session-model");
		if (!sessionModel) throw new Error("faux session model missing");

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(sessionModel.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(sessionModel.provider, {
			baseUrl: sessionModel.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});

		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: { model: sessionModel, systemPrompt: "test", tools: [] },
			convertToLlm,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager,
			resourceLoader: createTestResourceLoader(),
			cwd: tempDir,
			agentDir,
			modelRegistry,
		});
		return session;
	}

	function seedGoal(activeSession: AgentSession): void {
		let state = createGoalState({ goalId: "g1", userGoal: "Ship it", now: "T0" });
		state = applyGoalEvent(state, { type: "add_requirement", id: "req-1", text: "Find evidence", now: "T0" });
		appendGoalStateSnapshot(activeSession.sessionManager, state);
	}

	it("obeys the shipped profile's model, soul, thinking, and tool grants", async () => {
		const sessionModel = faux.getModel("session-model");
		writeProfile("scout", {
			model: `${sessionModel?.provider}/scout-model`,
			thinking: "low",
			soul: "You are in SCOUT mode.",
			resources: { tools: { allow: ["read", "grep"] } },
		});
		const activeSession = await newSession({ researchLane: { enabled: true, profile: "scout" } });
		seedGoal(activeSession);

		let seenModelId: string | undefined;
		let seenSystemPrompt: string | undefined;
		let seenReasoning: unknown;
		faux.setResponses([
			(context, options, _state, model) => {
				seenModelId = model.id;
				seenSystemPrompt = context.systemPrompt;
				seenReasoning = (options as { reasoning?: unknown } | undefined)?.reasoning;
				return fauxAssistantMessage(RESEARCH_JSON);
			},
		]);

		const outcome = await activeSession.runResearchLaneOnce();

		expect(outcome.started).toBe(true);
		expect(outcome.record?.status).toBe("succeeded");
		expect(seenModelId).toBe("scout-model");
		expect(seenSystemPrompt?.startsWith(SUBAGENT_CORE_SYSTEM_PROMPT)).toBe(true);
		expect(seenSystemPrompt).toContain("SCOUT mode");
		expect(seenReasoning).toBe("low");
		expect(outcome.result?.gateOutcome.outcome).toBe("allow");
	});

	it("skips visibly when the shipped profile's model cannot resolve", async () => {
		writeProfile("broken", { model: "nowhere/no-such-model", resources: {} });
		const activeSession = await newSession({ researchLane: { enabled: true, profile: "broken" } });
		seedGoal(activeSession);

		const outcome = await activeSession.runResearchLaneOnce();
		expect(outcome.started).toBe(false);
		expect(outcome.skipReason).toBe("no_lane_profile_model");
	});

	it("skips visibly when the configured lane profile does not exist", async () => {
		const activeSession = await newSession({ researchLane: { enabled: true, profile: "ghost" } });
		seedGoal(activeSession);

		const outcome = await activeSession.runResearchLaneOnce();
		expect(outcome.started).toBe(false);
		expect(outcome.skipReason).toBe("lane_profile_not_found");
	});

	it("lets a delegate-call system prompt replace the worker role prompt but never the core", async () => {
		const activeSession = await newSession({ workerDelegation: { enabled: true } });

		let seenSystemPrompt: string | undefined;
		faux.setResponses([
			(context) => {
				seenSystemPrompt = context.systemPrompt;
				return fauxAssistantMessage('{"summary":"minimal worker done"}');
			},
		]);

		const run = await activeSession.runWorkerDelegationOnce({
			instructions: "Summarize X",
			systemPrompt: "Answer with a single JSON summary field.",
		});

		expect(run.record?.status).toBe("succeeded");
		expect(seenSystemPrompt?.startsWith(SUBAGENT_CORE_SYSTEM_PROMPT)).toBe(true);
		expect(seenSystemPrompt).toContain("Answer with a single JSON summary field.");
		expect(seenSystemPrompt).not.toContain("bounded read-only scout worker");
	});
});
