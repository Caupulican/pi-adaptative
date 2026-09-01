import type { AgentTool } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import {
	type ForegroundLifecycleAgentDependency,
	ForegroundLifecycleController,
	PROVIDER_TRANSPORT_TELEMETRY_CUSTOM_TYPE,
} from "../src/core/foreground-lifecycle-controller.ts";
import type { ModelRouterController } from "../src/core/model-router-controller.ts";
import { createHarness } from "./test-harness.ts";

const parameters = Type.Object({ value: Type.String() });

function lifecycleTool(
	name: string,
	calls: string[],
	executionMode: "parallel" | "sequential" = "parallel",
): AgentTool<typeof parameters> {
	return {
		name,
		label: name,
		description: `Test tool ${name}`,
		parameters,
		executionMode,
		execute: async (_toolCallId, args) => {
			calls.push(`${name}:${args.value}`);
			return { content: [{ type: "text", text: `${name} result` }], details: {} };
		},
	};
}

function requestSnapshot() {
	return {
		requestId: "repair-request",
		reason: "initial" as const,
		api: "anthropic-messages",
		provider: "faux",
		modelId: "faux-1",
		effectiveConfigFingerprint: "config-fingerprint",
		systemFingerprint: "system-fingerprint",
		toolsFingerprint: "tools-fingerprint",
		historyFingerprint: "history-fingerprint",
		messageEntryIds: [],
	};
}

function resultEntries(harness: ReturnType<typeof createHarness>) {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "message" && entry.message.role === "toolResult");
}

describe("foreground lifecycle controller", () => {
	it("persists the request snapshot before provider-visible assistant/tool lifecycle entries", async () => {
		const calls: string[] = [];
		const alpha = lifecycleTool("alpha", calls);
		const beta = lifecycleTool("beta", calls);
		const harness = createHarness({
			responses: [
				{
					toolCalls: [
						{ id: "call-a", name: "alpha", args: { value: "a" } },
						{ id: "call-b", name: "beta", args: { value: "b" } },
					],
				},
				"done",
			],
			baseToolsOverride: { alpha, beta },
		});
		try {
			harness.session.setActiveToolsByName(["alpha", "beta"]);
			await harness.session.prompt("run both read-only tools");
			const entries = harness.sessionManager.getBranch();
			const snapshotIndex = entries.findIndex((entry) => entry.type === "request_snapshot");
			const assistantIndex = entries.findIndex(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some((block) => block.type === "toolCall"),
			);
			const startEntries = entries.filter((entry) => entry.type === "foreground_tool_start");
			const terminalEntries = entries.filter((entry) => entry.type === "foreground_tool_terminal");
			expect(snapshotIndex).toBeGreaterThanOrEqual(0);
			expect(assistantIndex).toBeGreaterThan(snapshotIndex);
			expect(startEntries.map((entry) => entry.type)).toHaveLength(2);
			expect(startEntries.map((entry) => entry.callId)).toEqual(["call-a", "call-b"]);
			expect(terminalEntries).toHaveLength(2);
			expect(calls).toEqual(expect.arrayContaining(["alpha:a", "beta:b"]));

			const firstResultIndex = entries.findIndex(
				(entry) => entry.type === "message" && entry.message.role === "toolResult",
			);
			expect(firstResultIndex).toBeGreaterThan(assistantIndex);
			expect(
				entries
					.slice(assistantIndex + 1, firstResultIndex)
					.filter((entry) => entry.type === "foreground_tool_start"),
			).toHaveLength(2);
		} finally {
			await harness.cleanup();
		}
	});

	it("distinguishes same-length provider history without persisting its raw content", async () => {
		const sessionManager = SessionManager.inMemory();
		const agent: ForegroundLifecycleAgentDependency & {
			onProviderRequestSnapshot?: (...args: never[]) => Promise<void>;
		} = {
			state: { messages: [] },
			resetSanitizerPrefixHorizon: () => {},
		};
		const controller = new ForegroundLifecycleController({
			agent,
			sessionManager,
			modelRouter: { commitSessionBufferPrefix: () => new Map() } as ModelRouterController,
			emitWarning: () => {},
		});
		controller.install();
		for (const [requestId, content] of [
			["same-length-a", "alpha"],
			["same-length-b", "bravo"],
		] as const) {
			await agent.onProviderRequestSnapshot?.(
				{
					requestId,
					model: { api: "faux", provider: "faux", id: "faux-1" },
					reasoning: "off",
					maxTokens: 128,
					attempt: 0,
					context: {
						systemPrompt: "",
						tools: [],
						messages: [{ role: "user", content, timestamp: 1 }],
					},
				} as never,
				undefined,
			);
		}
		const snapshots = sessionManager.getEntries().filter((entry) => entry.type === "request_snapshot");
		expect(snapshots).toHaveLength(2);
		expect(snapshots[0]!.historyFingerprint).not.toBe(snapshots[1]!.historyFingerprint);
		expect(JSON.stringify(snapshots)).not.toContain("alpha");
		expect(JSON.stringify(snapshots)).not.toContain("bravo");
	});

	it("correlates a completed assistant message's provider_transport diagnostic to the request that produced it", async () => {
		const sessionManager = SessionManager.inMemory();
		const agent: ForegroundLifecycleAgentDependency & {
			onProviderRequestSnapshot?: (...args: never[]) => Promise<void>;
		} = {
			state: { messages: [] },
			resetSanitizerPrefixHorizon: () => {},
		};
		const controller = new ForegroundLifecycleController({
			agent,
			sessionManager,
			modelRouter: { commitSessionBufferPrefix: () => new Map() } as ModelRouterController,
			emitWarning: () => {},
		});
		controller.install();
		await agent.onProviderRequestSnapshot?.(
			{
				requestId: "req-transport-1",
				model: { api: "faux", provider: "faux", id: "faux-1" },
				reasoning: "off",
				maxTokens: 128,
				attempt: 0,
				context: { systemPrompt: "", tools: [], messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			} as never,
			undefined,
		);

		const message = {
			...fauxAssistantMessage("ok"),
			diagnostics: [
				{
					type: "provider_transport",
					timestamp: Date.now(),
					details: { transport: "websocket", deltaEngaged: true },
				},
			],
		};
		controller.recordTransportTelemetry(message);

		const telemetry = sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === PROVIDER_TRANSPORT_TELEMETRY_CUSTOM_TYPE);
		expect(telemetry).toHaveLength(1);
		expect(telemetry[0]).toMatchObject({
			data: { requestId: "req-transport-1", transport: "websocket", deltaEngaged: true },
		});
	});

	it("writes one telemetry entry per provider_transport diagnostic and ignores unrelated ones", () => {
		const sessionManager = SessionManager.inMemory();
		const agent: ForegroundLifecycleAgentDependency & {
			onProviderRequestSnapshot?: (...args: never[]) => Promise<void>;
		} = {
			state: { messages: [] },
			resetSanitizerPrefixHorizon: () => {},
		};
		const controller = new ForegroundLifecycleController({
			agent,
			sessionManager,
			modelRouter: { commitSessionBufferPrefix: () => new Map() } as ModelRouterController,
			emitWarning: () => {},
		});
		controller.install();

		const message = {
			...fauxAssistantMessage("ok"),
			diagnostics: [
				{ type: "provider_transport_failure", timestamp: 1, error: { message: "boom" } },
				{
					type: "provider_transport",
					timestamp: 2,
					details: { transport: "websocket", deltaEngaged: false },
				},
				{
					type: "provider_transport",
					timestamp: 3,
					details: { transport: "sse", deltaEngaged: false, fallbackFromWebsocket: true },
				},
			],
		};
		controller.recordTransportTelemetry(message);

		const telemetry = sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === PROVIDER_TRANSPORT_TELEMETRY_CUSTOM_TYPE);
		expect(telemetry).toHaveLength(2);
	});

	it("does nothing for a message with no provider_transport diagnostic", () => {
		const sessionManager = SessionManager.inMemory();
		const agent: ForegroundLifecycleAgentDependency & {
			onProviderRequestSnapshot?: (...args: never[]) => Promise<void>;
		} = {
			state: { messages: [] },
			resetSanitizerPrefixHorizon: () => {},
		};
		const controller = new ForegroundLifecycleController({
			agent,
			sessionManager,
			modelRouter: { commitSessionBufferPrefix: () => new Map() } as ModelRouterController,
			emitWarning: () => {},
		});
		controller.install();

		controller.recordTransportTelemetry(fauxAssistantMessage("ok"));

		expect(
			sessionManager
				.getEntries()
				.filter(
					(entry) => entry.type === "custom" && entry.customType === PROVIDER_TRANSPORT_TELEMETRY_CUSTOM_TYPE,
				),
		).toHaveLength(0);
	});

	it("never throws when the session log write fails -- a failed diagnostic must never fail the request it observes", () => {
		const sessionManager = SessionManager.inMemory();
		vi.spyOn(sessionManager, "appendCustomEntry").mockImplementation(() => {
			throw new Error("disk full");
		});
		const agent: ForegroundLifecycleAgentDependency & {
			onProviderRequestSnapshot?: (...args: never[]) => Promise<void>;
		} = {
			state: { messages: [] },
			resetSanitizerPrefixHorizon: () => {},
		};
		const controller = new ForegroundLifecycleController({
			agent,
			sessionManager,
			modelRouter: { commitSessionBufferPrefix: () => new Map() } as ModelRouterController,
			emitWarning: () => {},
		});
		controller.install();

		const message = {
			...fauxAssistantMessage("ok"),
			diagnostics: [
				{ type: "provider_transport", timestamp: 1, details: { transport: "sse", deltaEngaged: false } },
			],
		};
		expect(() => controller.recordTransportTelemetry(message)).not.toThrow();
	});

	it("does not write a terminal for an immediate tool result with no durable start", async () => {
		const harness = createHarness({
			responses: [{ toolCalls: [{ id: "missing-call", name: "missing-tool", args: { value: "x" } }] }, "done"],
		});
		try {
			await harness.session.prompt("try the unavailable tool");
			expect(resultEntries(harness)).toHaveLength(1);
			expect(
				harness.sessionManager.getBranch().filter((entry) => entry.type === "foreground_tool_start"),
			).toHaveLength(0);
			expect(
				harness.sessionManager.getBranch().filter((entry) => entry.type === "foreground_tool_terminal"),
			).toHaveLength(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("repairs not-started and unknown-outcome records idempotently", async () => {
		const notStarted = SessionManager.inMemory();
		notStarted.appendRequestSnapshot(requestSnapshot());
		notStarted.appendMessage(
			fauxAssistantMessage([fauxToolCall("repair-not-started", {}, { id: "repair-not-started" })], {
				stopReason: "toolUse",
			}),
		);
		const notStartedHarness = createHarness({ sessionManager: notStarted });
		try {
			expect(resultEntries(notStartedHarness)).toHaveLength(1);
			expect(notStarted.getBranch().filter((entry) => entry.type === "foreground_tool_terminal")).toHaveLength(0);
			await notStartedHarness.session.reload();
			expect(resultEntries(notStartedHarness)).toHaveLength(1);
		} finally {
			await notStartedHarness.cleanup();
		}

		const unknown = SessionManager.inMemory();
		unknown.appendRequestSnapshot(requestSnapshot());
		const assistantEntryId = unknown.appendMessage(
			fauxAssistantMessage([fauxToolCall("repair-unknown", {}, { id: "repair-unknown" })], {
				stopReason: "toolUse",
			}),
		);
		unknown.appendForegroundToolStart("repair-request", assistantEntryId, "repair-unknown", "repair-unknown");
		const unknownHarness = createHarness({ sessionManager: unknown });
		try {
			expect(resultEntries(unknownHarness)).toHaveLength(1);
			expect(unknown.getBranch().filter((entry) => entry.type === "foreground_tool_terminal")).toHaveLength(1);
			await unknownHarness.session.reload();
			expect(resultEntries(unknownHarness)).toHaveLength(1);
			expect(unknown.getBranch().filter((entry) => entry.type === "foreground_tool_terminal")).toHaveLength(1);
		} finally {
			await unknownHarness.cleanup();
		}
	});

	it("matches reused provider call ids to the currently pending composite identity", async () => {
		const calls: string[] = [];
		const tool = lifecycleTool("alpha", calls);
		const harness = createHarness({
			responses: [{ toolCalls: [{ id: "reused-call", name: "alpha", args: { value: "x" } }] }, "done"],
			baseToolsOverride: { alpha: tool },
		});
		try {
			harness.session.setActiveToolsByName(["alpha"]);
			await harness.session.prompt("first run");
			await harness.session.prompt("second run");
			const branch = harness.sessionManager.getBranch();
			expect(calls).toHaveLength(2);
			expect(branch.filter((entry) => entry.type === "foreground_tool_start")).toHaveLength(2);
			expect(branch.filter((entry) => entry.type === "foreground_tool_terminal")).toHaveLength(2);
		} finally {
			await harness.cleanup();
		}
	});

	it("does not rebuild the complete lifecycle index for each canonical tool result", async () => {
		const calls: string[] = [];
		const harness = createHarness({
			responses: [{ toolCalls: [{ id: "bounded-call", name: "alpha", args: { value: "x" } }] }, "done"],
			baseToolsOverride: { alpha: lifecycleTool("alpha", calls) },
		});
		try {
			harness.session.setActiveToolsByName(["alpha"]);
			let lifecycleIndexCalls = 0;
			const original = harness.sessionManager.getSessionLifecycleIndex.bind(harness.sessionManager);
			harness.sessionManager.getSessionLifecycleIndex = (...args) => {
				lifecycleIndexCalls += 1;
				return original(...args);
			};
			await harness.session.prompt("bounded lifecycle lookup");
			expect(calls).toHaveLength(1);
			expect(lifecycleIndexCalls).toBe(0);
		} finally {
			await harness.cleanup();
		}
	});

	it("normalizes a legacy errored result before terminal publication", () => {
		const terminals: Array<{ errorKind?: string }> = [];
		const sessionManager = {
			appendForegroundToolTerminal: (...args: unknown[]) => terminals.push(args[5] as { errorKind?: string }),
		} as never;
		const controller = new ForegroundLifecycleController({
			agent: { state: { messages: [] }, resetSanitizerPrefixHorizon: () => {} },
			sessionManager,
			modelRouter: {} as ModelRouterController,
			emitWarning: () => {},
		});
		const identity = {
			requestId: "legacy-request",
			assistantMessageEntryId: "assistant-entry",
			callId: "legacy-call",
			toolName: "legacy-tool",
		};
		const key = [identity.requestId, identity.assistantMessageEntryId, identity.callId, identity.toolName].join(
			"\u0000",
		);
		const internals = controller as unknown as {
			startedTools: Map<string, typeof identity>;
			pendingToolsByCall: Map<string, Set<string>>;
		};
		internals.startedTools.set(key, identity);
		internals.pendingToolsByCall.set(`${identity.callId}\u0000${identity.toolName}`, new Set([key]));
		controller.onMessagePersisted(
			{
				role: "toolResult",
				toolCallId: identity.callId,
				toolName: identity.toolName,
				content: [{ type: "text", text: "legacy failure" }],
				isError: true,
				timestamp: Date.now(),
			},
			"result-entry",
		);
		expect(terminals).toEqual([{ resultMessageEntryId: "result-entry", errorKind: "tool_failure" }]);
	});

	it("caps lifecycle ancestry walks on metadata-heavy branches", async () => {
		const sessionManager = SessionManager.inMemory();
		for (let index = 0; index < 10_000; index += 1) sessionManager.appendCustomEntry("metadata", { index });
		let entryLookups = 0;
		const originalGetEntry = sessionManager.getEntry.bind(sessionManager);
		sessionManager.getEntry = (id) => {
			entryLookups += 1;
			return originalGetEntry(id);
		};
		const agent: ForegroundLifecycleAgentDependency & {
			onProviderRequestSnapshot?: (...args: never[]) => Promise<void>;
		} = {
			state: { messages: [] },
			resetSanitizerPrefixHorizon: () => {},
		};
		const controller = new ForegroundLifecycleController({
			agent,
			sessionManager,
			modelRouter: { commitSessionBufferPrefix: () => new Map() } as ModelRouterController,
			emitWarning: () => {},
		});
		controller.install();
		await agent.onProviderRequestSnapshot?.(
			{
				requestId: "bounded-request",
				model: { api: "faux", provider: "faux", id: "faux-1" },
				reasoning: "off",
				maxTokens: 128,
				attempt: 1,
				context: { systemPrompt: "", tools: [], messages: [] },
			} as never,
			undefined,
		);
		expect(entryLookups).toBeLessThanOrEqual(8192);
	});
});
