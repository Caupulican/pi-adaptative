import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	type AssistantMessage,
	AssistantMessageEventStream,
	createEmptyUsage,
	dispatchGuardedProviderRequest,
	type Model,
} from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { ForegroundLifecycleAdapter } from "../src/core/foreground-lifecycle-adapter.ts";
import { Agent } from "../src/kernel/agent.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

const model: Model<Api> = {
	id: "dispatch-lifecycle-fixture",
	name: "Dispatch lifecycle fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe.each([false, true])("durable dispatch lifecycle, text protocol=%s", (textProtocol) => {
	it.each(["snapshot", "downstream", "healthy"] as const)(
		"retains one request/assistant/terminal pairing after %s",
		async (stage) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-dispatch-lifecycle-"));
			try {
				const agentDir = join(directory, "agent");
				const manager = SessionManager.create(directory, agentDir, join(directory, "sessions"));
				let current = true;
				let committed = false;
				let commits = 0;
				let physical = 0;
				let observedRequestId: string | undefined;
				const agent = new Agent({
					initialState: {
						model,
						systemPrompt: "Follow the owner.",
						tools: textProtocol
							? [
									{
										name: "lookup",
										label: "Lookup",
										description: "Read a path.",
										parameters: Type.Object({ path: Type.String() }),
										execute: async () => ({ content: [], details: undefined }),
									},
								]
							: [],
					},
					textToolCallProtocol: textProtocol,
					planContext: async ({ messages }) => ({
						messages,
						isCurrent: () => !committed,
						isDispatchCurrent: () => current,
						commit: () => {
							committed = true;
							commits++;
						},
					}),
					streamFn: async (requestModel, _context, options) => {
						await Promise.resolve();
						if (stage === "downstream") current = false;
						return dispatchGuardedProviderRequest(requestModel, options, () => {
							physical++;
							const response: AssistantMessage = {
								role: "assistant",
								api: model.api,
								provider: model.provider,
								model: model.id,
								content: [{ type: "text", text: "Finished." }],
								usage: createEmptyUsage(),
								stopReason: "stop",
								timestamp: 1,
							};
							const stream = new AssistantMessageEventStream();
							stream.push({ type: "done", reason: "stop", message: response });
							return stream;
						});
					},
				});
				const lifecycle = new ForegroundLifecycleAdapter(agent, manager, {
					commitSessionBuffer: () => new Map(),
					commitSessionBufferPrefix: () => new Map(),
				});
				lifecycle.install();
				const snapshot = agent.onProviderRequestSnapshot!;
				agent.onProviderRequestSnapshot = async (context, signal) => {
					await snapshot(context, signal);
					observedRequestId = context.requestId;
					await Promise.resolve();
					if (stage === "snapshot") current = false;
				};
				agent.subscribe((event) => {
					if (
						event.type === "message_end" &&
						(event.message.role === "user" || event.message.role === "assistant")
					)
						lifecycle.appendMessage(event.message, event.origin);
				});
				await agent.prompt("Read the task.");
				expect(commits).toBe(1);
				expect(physical).toBe(stage === "healthy" ? 1 : 0);
				const file = manager.getSessionFile()!;
				expect(readFileSync(file, "utf8")).toContain(observedRequestId);
				const reopened = SessionManager.openReadOnly(file, agentDir);
				const entries = reopened.getEntries();
				const requests = entries.filter((entry) => entry.type === "request_snapshot");
				const terminals = entries.filter((entry) => entry.type === "provider_request_terminal");
				const assistants = entries.filter(
					(entry) => entry.type === "message" && entry.message.role === "assistant",
				);
				expect(requests).toHaveLength(1);
				expect(terminals).toHaveLength(1);
				expect(assistants).toHaveLength(1);
				expect(terminals[0]).toMatchObject({
					requestId: observedRequestId,
					outcome: stage === "healthy" ? "completed" : "error",
					assistantMessageEntryId: assistants[0]!.id,
				});
				expect(requests[0]!.requestId).toBe(observedRequestId);
				expect(reopened.inspectSessionLifecycle()).toMatchObject({ balanced: true, refusalReasons: [] });
				expect(agent.state.isStreaming).toBe(false);
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	);
});
