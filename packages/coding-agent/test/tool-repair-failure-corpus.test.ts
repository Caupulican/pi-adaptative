import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

describe("tool repair failure corpus", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-tool-repair-corpus-"));
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession() {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		return new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: "", tools: [] },
			}),
			sessionManager: SessionManager.inMemory(tempDir),
			settingsManager: SettingsManager.inMemory(),
			cwd: tempDir,
			agentDir,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
		});
	}

	it("writes only bounced sanitized shapes to the failure corpus", () => {
		const session = createSession();
		try {
			session.agent.onToolArgumentValidation?.({
				outcome: "clean",
				provider: model.provider,
				model: model.id,
				tool: "count",
				failureModes: [],
				repairsApplied: [],
				taught: "none",
				executionOutcome: "succeeded",
			});
			session.agent.onToolArgumentValidation?.({
				outcome: "repaired",
				provider: model.provider,
				model: model.id,
				tool: "count",
				failureModes: ["numberFromString"],
				repairsApplied: ["numberFromString"],
				taught: "note",
				executionOutcome: "succeeded",
				failureShape: [{ path: "count", expectedType: "number", receivedType: "string" }],
			});
			session.agent.onToolArgumentValidation?.({
				outcome: "bounced",
				provider: model.provider,
				model: model.id,
				tool: "count",
				failureModes: ["other"],
				repairsApplied: [],
				taught: "none",
				executionOutcome: "not_run",
				failureShape: [{ path: "count", expectedType: "number", receivedType: "object" }],
			});
		} finally {
			session.dispose();
		}

		const corpusPath = join(agentDir, "state", "failure-corpus.jsonl");
		expect(existsSync(corpusPath)).toBe(true);
		const lines = readFileSync(corpusPath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const record = JSON.parse(lines[0]!) as {
			kind: string;
			tool: string;
			shape: Array<{ path: string; expectedType: string; receivedType: string }>;
		};
		expect(record).toMatchObject({
			kind: "tool_validation",
			provider: model.provider,
			modelId: model.id,
			tool: "count",
			failureModes: ["other"],
			shape: [{ path: "count", expectedType: "number", receivedType: "object" }],
		});
		expect(JSON.stringify(record)).not.toContain("secret-value");
	});
});
