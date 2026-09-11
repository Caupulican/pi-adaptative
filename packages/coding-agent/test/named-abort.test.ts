/**
 * Every abort carries a name. `AgentSession.abort(reason)` and `Agent.abort(reason)` both require a
 * short label, and that label reaches the persisted assistant message, so a transcript says who
 * stopped the turn: an operator interrupt, compaction, a reflection, a dispose or a superseded
 * submission are distinguishable in the session file rather than all reading "Operation aborted".
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function waitForAssistantStart(activeSession: AgentSession): Promise<void> {
	return new Promise((resolve) => {
		let unsubscribe = () => {};
		unsubscribe = activeSession.subscribe((event) => {
			if (event.type !== "message_start" || event.message.role !== "assistant") return;
			unsubscribe();
			resolve();
		});
	});
}

describe("named aborts", () => {
	let session: AgentSession | undefined;
	let sessionManager: SessionManager;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-named-abort-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	/** A session whose provider stream stalls until the run is aborted. */
	function createStallingSession(): AgentSession {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					const checkAbort = () => {
						if (options?.signal?.aborted) {
							stream.push({
								type: "error",
								reason: "aborted",
								error: {
									...createAssistantMessage(""),
									stopReason: "aborted",
									errorMessage: "Operation aborted",
								},
							});
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
				});
				return stream;
			},
		});
		sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}

	it("persists the operator's interrupt by name in the aborted assistant message", async () => {
		const activeSession = createStallingSession();
		const assistantStarted = waitForAssistantStart(activeSession);
		const prompt = activeSession.prompt("a question the operator interrupts");
		await assistantStarted;

		await activeSession.abort("user interrupt");
		await prompt.catch(() => {});

		const aborted = sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant")
			.map((entry) => (entry.type === "message" ? entry.message : undefined))
			.filter((message) => message !== undefined)
			.filter((message) => "stopReason" in message && message.stopReason === "aborted");

		expect(aborted.length).toBeGreaterThan(0);
		for (const message of aborted) {
			expect("errorMessage" in message ? message.errorMessage : undefined).toBe(
				"Operation aborted (user interrupt)",
			);
		}
	});
});
