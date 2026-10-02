import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SystemOneController } from "../src/core/system-one/controller.ts";
import type { SemanticVerificationObligationView } from "../src/core/system-one/verification-obligations.ts";
import { tempDir } from "./temp-dir.ts";
import { createTestResourceLoader } from "./utilities.ts";

const sessions: AgentSession[] = [];

afterEach(async () => {
	await Promise.all(sessions.splice(0).map((session) => session.disposeAndWait()));
});

describe("AgentSession semantic verification obligation projection", () => {
	it("projects mandatory System One findings from the verification coordinator", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");
		const obligation: SemanticVerificationObligationView = {
			id: "finding-1",
			source: "postflight",
			reason: "Recheck the current test result.",
			receiverId: "session-1",
			candidateKind: "repository",
			candidateId: "candidate-1",
			scope: "/workspace/project",
			sequence: 1,
			status: "active",
		};
		const systemOneController = {
			verification: { status: () => ({ status: "obligations" as const, obligations: [obligation], receipts: [] }) },
			setEvaluationObserver: () => {},
			setAccountPassStore: () => {},
			setEvaluationIdleListener: () => {},
			setVerificationHost: () => {},
		} as unknown as SystemOneController;
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: "test", tools: [], thinkingLevel: "off" },
			}),
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			cwd: process.cwd(),
			agentDir: tempDir("pi-semantic-obligations-"),
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
			systemOneController,
		});
		sessions.push(session);

		expect(session.getSemanticVerificationObligations()).toEqual([obligation]);
	});
});
