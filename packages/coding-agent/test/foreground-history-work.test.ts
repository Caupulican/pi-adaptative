import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, AssistantMessageEventStream, type Context, createEmptyUsage, type Model } from "@caupulican/pi-ai";
import { observeHistoryWork, providerMessagePrefix } from "@caupulican/pi-ai/history-work";
import { expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ContextPipeline } from "../src/core/context-pipeline.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ownerSessionStorageRoots } from "../src/core/orchestration/session-bundle-lifecycle.ts";
import { ProviderRequestContextController } from "../src/core/provider-request-context-controller.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { AgentContext, AgentLoopConfig } from "../src/kernel/loop-config.ts";
import { createVersionedMessageHistory, immutableHistoryMessage } from "../src/kernel/message-revision.ts";
import { convertToLlm } from "../src/kernel/messages.ts";
import { startPlannedAgentProviderRequestWithId } from "../src/kernel/provider-request-planner.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";
import { createToolFailureContextMemory } from "../src/kernel/tool-failure-memory.ts";

const model: Model<Api> = {
	id: "foreground",
	name: "Foreground fixture",
	api: "openai-responses",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	input: ["text"],
	reasoning: false,
	contextWindow: 100_000,
	maxTokens: 1_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

it.each([100, 1_000, 10_000])("keeps the foreground plan on the accepted prefix across %i rows", async (rows) => {
	const directory = mkdtempSync(join(tmpdir(), "pi-foreground-history-"));
	let pipeline: ContextPipeline | undefined;
	try {
		const sessionManager = SessionManager.inMemory(ownerSessionStorageRoots(directory), directory);
		const settings = SettingsManager.inMemory({ contextGc: { enabled: true } });
		const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
		const contextPipeline = new ContextPipeline({
			getTurnIndex: () => 1,
			getSessionManager: () => sessionManager,
			getSettingsManager: () => settings,
			getModelRegistry: () => registry,
			getModel: () => model,
			getAgentDir: () => directory,
			getCwd: () => directory,
			getActiveToolNames: () => [],
			isDisposed: () => false,
			getMemoryManager: () => ({ getContextMarkers: () => [] }),
			addSpawnedUsage: () => undefined,
			runIsolatedCompletion: async () => {
				throw new Error("The foreground fixture does not run a curation model.");
			},
		});
		pipeline = contextPipeline;
		const controller = new ProviderRequestContextController({
			runContextAudit: (history) => contextPipeline.runContextAudit(history),
			runPromptPolicyPlanning: (report) => contextPipeline.runPromptPolicyPlanning(report),
			previewContextProjection: (history) => contextPipeline.previewContextProjection(history),
			commitContextProjection: (projection) => contextPipeline.commitContextProjection(projection),
			applyContextGc: (history, write, frozen) => contextPipeline.applyContextGc(history, write, frozen),
			correlatePromptPolicyWithContextGc: (report) => contextPipeline.correlatePromptPolicyWithContextGc(report),
			runPromptEnforcement: (history, report, sourceMessages, frozenBelow, gcReport) =>
				contextPipeline.runPromptEnforcement(history, report, undefined, { sourceMessages, frozenBelow, gcReport }),
			applyPathAliases: (history) => contextPipeline.applyPathAliases(history),
			getEdgeGrants: () => [],
		});
		const row = (index: number) =>
			immutableHistoryMessage({ role: "user", content: `Foreground row ${index}.`, timestamp: index })!;
		const messages = createVersionedMessageHistory(Array.from({ length: rows }, (_, index) => row(index)));
		messages[1] = immutableHistoryMessage({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "toolCall", id: "read-source", name: "read", arguments: { path: "source.ts" } }],
			usage: createEmptyUsage(),
			stopReason: "toolUse",
			timestamp: 1,
		})!;
		messages[2] = immutableHistoryMessage({
			role: "toolResult",
			toolCallId: "read-source",
			toolName: "read",
			content: [{ type: "text", text: "A small retained tool result." }],
			isError: false,
			timestamp: 2,
		})!;
		const source: AgentContext = { systemPrompt: "Follow the owner.", messages, tools: [] };
		const config: AgentLoopConfig = {
			model,
			providerAccountKey: "foreground-fixture",
			providerMessageProjectionOwner: contextPipeline,
			providerRequestPrefixState: {
				sentPrefixCount: 0,
				sanitizerSentPrefixCount: 0,
				sanitizerMemory: createToolFailureContextMemory(),
			},
			convertToLlm,
			planContext: ({ messages, sentPrefixCount, wire }, signal) =>
				controller.plan(messages, sentPrefixCount, signal, wire),
		};
		const send = async () => {
			let dispatched: Context | undefined;
			const request = await startPlannedAgentProviderRequestWithId(source, config, undefined, (_, context) => {
				dispatched = context;
				const stream = new AssistantMessageEventStream();
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						api: model.api,
						provider: model.provider,
						model: model.id,
						content: [],
						usage: createEmptyUsage(),
						stopReason: "stop",
						timestamp: messages.length,
					},
				});
				return stream;
			});
			await request.stream.result();
			expect(dispatched).toBeDefined();
			return dispatched!;
		};

		const initial = await send();
		messages.push(row(rows));
		const work = observeHistoryWork(messages);
		const accepted = await send();
		expect(accepted.messages).toHaveLength(rows + 1);
		expect(providerMessagePrefix(accepted.messages)).toEqual({ previous: initial.messages, count: rows });
		// The retained tool result still participates in per-turn policy evaluation.
		expect(work.oldRowsRead).toBeLessThanOrEqual(1);
		expect(work.oldBytesRecompressed).toBe(0);
		expect(work.coldPayloadLoads).toBe(0);
		expect(work.projectedRows).toBe(1);
		expect(work.providerRowsConverted).toBe(1);
		expect(work.copiedRows).toBeLessThanOrEqual(rows);
		expect(work.fallbacks.size).toBe(0);
	} finally {
		try {
			pipeline?.cleanupToolArtifactStoreOnDispose();
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	}
});
