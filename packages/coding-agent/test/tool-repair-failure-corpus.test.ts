import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Agent,
	type AgentEvent,
	createToolFailureResult,
	type ToolFailureMemoryRecord,
} from "@caupulican/pi-agent-core";
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

	function createSession(options?: { logging?: boolean }) {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		return new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: "", tools: [] },
			}),
			sessionManager: SessionManager.inMemory(tempDir),
			settingsManager: SettingsManager.inMemory(
				options?.logging === false ? { toolRepair: { logging: false } } : undefined,
			),
			cwd: tempDir,
			agentDir,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
		});
	}

	async function waitForFile(path: string): Promise<void> {
		for (let attempt = 0; attempt < 50; attempt++) {
			if (existsSync(path)) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}

	it("writes only bounced sanitized shapes to the failure corpus", async () => {
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
			await session.flushToolRecoveryLogsForTests();
		} finally {
			await session.disposeAndWait();
		}

		const corpusPath = join(agentDir, "state", "failure-corpus.jsonl");
		await waitForFile(corpusPath);
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

	it("does not enqueue or write recovery logs when logging is disabled", async () => {
		const session = createSession({ logging: false });
		try {
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
			await session.flushToolRecoveryLogsForTests();
		} finally {
			await session.disposeAndWait();
		}

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(existsSync(join(agentDir, "state", "tool-recovery-events.jsonl"))).toBe(false);
		expect(existsSync(join(agentDir, "state", "failure-corpus.jsonl"))).toBe(false);
		expect(session.getSessionStats().toolArgumentValidation.bounced).toBe(0);
	});

	it("records finalized execution failures from the session event boundary", async () => {
		const session = createSession();
		const failure: ToolFailureMemoryRecord = {
			version: 1,
			failureKey: "grep:opaque",
			tool: "grep",
			operation: "[bounded]",
			occurrence: 1,
			state: "failed",
			phase: "timeout",
			failureCode: "timeout",
			diagnostic: "ripgrep timed out after 300000ms",
			correction: "Narrow the search and retry once only if still required.",
		};
		const event: AgentEvent = {
			type: "tool_execution_end",
			toolCallId: "grep-call",
			toolName: "grep",
			result: createToolFailureResult(failure),
			isError: true,
		};
		try {
			await (session as unknown as { _handleAgentEvent(event: AgentEvent): Promise<void> })._handleAgentEvent(event);
			await session.flushToolRecoveryLogsForTests();
		} finally {
			await session.disposeAndWait();
		}

		const corpusPath = join(agentDir, "state", "failure-corpus.jsonl");
		await waitForFile(corpusPath);
		const corpus = JSON.parse(readFileSync(corpusPath, "utf-8").trim()) as unknown;
		expect(corpus).toMatchObject({
			kind: "tool_execution",
			provider: model.provider,
			modelId: model.id,
			tool: "grep",
			phase: "timeout",
			failureCode: "timeout",
		});
	});
});
