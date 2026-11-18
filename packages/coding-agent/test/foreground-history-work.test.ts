import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type Api,
	AssistantMessageEventStream,
	type Context,
	createEmptyUsage,
	type Message,
	type Model,
} from "@caupulican/pi-ai";
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
	contextWindow: 1_000_000,
	maxTokens: 1_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

it.each([100, 1_000, 10_000])(
	"keeps the foreground plan on the accepted prefix across %i tool results",
	async (results) => {
		const directory = mkdtempSync(join(tmpdir(), "pi-foreground-history-"));
		let pipeline: ContextPipeline | undefined;
		try {
			const sessionManager = SessionManager.inMemory(ownerSessionStorageRoots(directory), directory);
			const settings = SettingsManager.inMemory({
				contextGc: { enabled: true },
				contextPolicy: { enforcement: { enabled: true }, curation: { enabled: true } },
			});
			const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
			let turnIndex = 1;
			const contextPipeline = new ContextPipeline({
				getTurnIndex: () => turnIndex,
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
				runContextAudit: (history, transients) => contextPipeline.runContextAudit(history, transients),
				runPromptPolicyPlanning: (report) => contextPipeline.runPromptPolicyPlanning(report),
				previewContextProjection: (history) => contextPipeline.previewContextProjection(history),
				commitContextProjection: (projection) => contextPipeline.commitContextProjection(projection),
				applyContextGc: (history, write, frozen) => contextPipeline.applyContextGc(history, write, frozen),
				correlatePromptPolicyWithContextGc: (report, shadow) =>
					contextPipeline.correlatePromptPolicyWithContextGc(report, shadow),
				enqueueRelevanceCuration: (history, report) => contextPipeline.enqueueRelevanceCuration(history, report),
				runPromptEnforcement: (history, report, sourceMessages, frozenBelow, gcReport, alignedPolicyHistory) =>
					contextPipeline.runPromptEnforcement(history, report, undefined, {
						sourceMessages,
						alignedPolicyHistory,
						frozenBelow,
						gcReport,
					}),
				applyPathAliases: (history) => contextPipeline.applyPathAliases(history),
				getEdgeGrants: () => [],
			});
			const messages = createVersionedMessageHistory();
			const append = (message: Message) => {
				sessionManager.appendMessage(message);
				messages.push(immutableHistoryMessage(message)!);
			};
			append({ role: "user", content: "Read the source.", timestamp: 0 });
			const appendToolExchange = (index: number) => {
				const toolCallId = `read-source-${index}`;
				append({
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "source.ts" } }],
					usage: createEmptyUsage(),
					stopReason: "toolUse",
					timestamp: 2 * index + 1,
				});
				append({
					role: "toolResult",
					toolCallId,
					toolName: "read",
					content: [{ type: "text", text: "A small retained tool result." }],
					isError: false,
					timestamp: 2 * index + 2,
				});
			};
			for (let index = 0; index < results; index++) appendToolExchange(index);
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
				turnIndex++;
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
			const acceptedRows = messages.length;
			appendToolExchange(results);
			const appendedRows = messages.length - acceptedRows;
			const work = observeHistoryWork(messages);
			const accepted = await send();
			expect(accepted.messages).toHaveLength(acceptedRows + appendedRows);
			expect(providerMessagePrefix(accepted.messages)).toEqual({ previous: initial.messages, count: acceptedRows });
			expect(work.auditSourceRowsVisited).toBe(appendedRows);
			expect(work.auditRowsMaterialized).toBe(0);
			expect(work.auditArtifactRefsChecked).toBe(0);
			expect(work.oldRowsRead).toBeLessThanOrEqual(1);
			expect(work.oldBytesRecompressed).toBe(0);
			expect(work.coldPayloadLoads).toBe(0);
			expect(work.projectedRows).toBe(appendedRows);
			expect(work.providerRowsConverted).toBe(appendedRows);
			expect(work.copiedRows).toBeLessThanOrEqual(acceptedRows);
			expect(work.fallbacks.size).toBe(0);

			// Keep growing both the persisted branch and conversation across subsequent GC grid boundaries.
			for (let next = 1; next <= 3; next++) {
				appendToolExchange(results + next);
				const continued = observeHistoryWork(messages);
				await send();
				expect(continued.auditSourceRowsVisited).toBe(2);
				expect(continued.auditRowsMaterialized).toBe(0);
				expect(continued.auditArtifactRefsChecked).toBe(0);
			}
		} finally {
			try {
				pipeline?.cleanupToolArtifactStoreOnDispose();
			} finally {
				rmSync(directory, { force: true, recursive: true });
			}
		}
	},
);
