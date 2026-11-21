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
import { ProviderRequestRuntimeController } from "../src/core/provider-request-runtime-controller.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { Agent } from "../src/kernel/agent.ts";
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

function fixturePipeline(
	directory: string,
	sessionManager: SessionManager,
	settings: SettingsManager,
	getTurnIndex: () => number,
) {
	const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
	return new ContextPipeline({
		getTurnIndex,
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
}

it("keeps overlapping worker plans scoped and publishes a preview only after a successful response", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-worker-preview-"));
	const session = SessionManager.inMemory(ownerSessionStorageRoots(directory), directory);
	const settings = SettingsManager.inMemory({
		contextGc: { enabled: false },
		contextPolicy: { enforcement: { enabled: true, preserveRecentMessages: 1, minChars: 1 } },
	});
	const pipeline = fixturePipeline(directory, session, settings, () => 10);
	try {
		const text = "example content ".repeat(512);
		const artifactId = pipeline
			.getToolArtifactStore()
			.write({ kind: "tool_output", content: text, createdAtTurn: 1, reproducible: false }).ref.id;
		const messages = createVersionedMessageHistory();
		const append = (row: Message) => messages.push(immutableHistoryMessage(row)!);
		append({ role: "user", content: "Inspect the sample.", timestamp: 1 });
		append({
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "toolCall", name: "read", id: "r", arguments: { path: "sample" } }],
			stopReason: "toolUse",
			usage: createEmptyUsage(),
			timestamp: 2,
		});
		append({
			role: "toolResult",
			toolName: "read",
			toolCallId: "r",
			content: [{ type: "text", text }],
			isError: false,
			details: { artifactId },
			timestamp: 3,
		});
		for (let i = 0; i < 5; i++) append({ role: "user", content: "Continue.", timestamp: i + 4 });
		const plan = (input: typeof messages, sentPrefixCount: number, toolNames: string[], requestModel = model) =>
			pipeline.planWorkerRequest(
				{
					agentId: "worker",
					model: requestModel,
					compactionTriggerTokens: undefined,
					messages: input,
					sentPrefixCount,
					toolNames,
				},
				() => [],
			);
		const tools = ["artifact_retrieve"];
		const other = { ...model, id: "other" };
		const [withTool, withoutTool] = await Promise.all([plan(messages, 0, tools), plan(messages, 0, [], other)]);
		expect(withTool.messages[2]).not.toBe(messages[2]);
		expect(withoutTool.messages[2]).toBe(messages[2]);
		for (const stopReason of ["error", "aborted", "stop"] as const) {
			const config: AgentLoopConfig = {
				model,
				convertToLlm,
				planContext: (request) => plan(request.messages, 0, tools),
			};
			const result = await startPlannedAgentProviderRequestWithId(
				{ systemPrompt: "", messages, tools: [] },
				config,
				undefined,
				() => {
					const stream = new AssistantMessageEventStream();
					const reply = {
						role: "assistant" as const,
						api: model.api,
						provider: model.provider,
						model: model.id,
						content: [],
						stopReason,
						usage: createEmptyUsage(),
						timestamp: 10,
					};
					if (stopReason === "stop") stream.push({ type: "done", reason: stopReason, message: reply });
					else stream.push({ type: "error", reason: stopReason, error: reply });
					return stream;
				},
			);
			await result.stream.result();
			const next = await plan(messages, messages.length, tools);
			if (stopReason === "stop")
				expect(next.messages[2]).toMatchObject({
					content: [{ text: expect.stringContaining("content replaced by prompt-policy") }],
				});
			else expect(next.messages[2]).toBe(messages[2]);
		}
		expect((await plan(messages, messages.length, tools, other)).messages[2]).toBe(messages[2]);
	} finally {
		pipeline.cleanupToolArtifactStoreOnDispose();
		rmSync(directory, { recursive: true, force: true });
	}
});

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
			let turnIndex = 1;
			const contextPipeline = fixturePipeline(directory, sessionManager, settings, () => turnIndex);
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
				runPromptEnforcement: (history, report, context) =>
					contextPipeline.runPromptEnforcement(history, report, undefined, context),
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
				const toolName = index === 0 ? "delegate" : "read";
				const toolCallId = `${toolName}-source-${index}`;
				// Distinct reads keep the unrelated replay deduplicator from collapsing the fixture.
				append({
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [
						{ type: "toolCall", id: toolCallId, name: toolName, arguments: { path: `source-${index}.ts` } },
					],
					usage: createEmptyUsage(),
					stopReason: "toolUse",
					timestamp: 2 * index + 1,
				});
				append({
					role: "toolResult",
					toolCallId,
					toolName,
					content: [
						{
							type: "text",
							text:
								index === 0
									? "Worker report. ".repeat(150)
									: `A small retained tool result for source-${index}.ts.`,
						},
					],
					isError: false,
					timestamp: 2 * index + 2,
				});
			};
			for (let index = 0; index < results; index++) appendToolExchange(index);
			const agent = new Agent();
			new ProviderRequestRuntimeController({
				agent,
				context: controller,
				compaction: { admitProviderRequest: async () => ({ action: "send" }), measureLiveContextTokens: () => 0 },
				parentInputs: sessionManager,
				getSubmissionEpoch: () => undefined,
				admitGoalRequest: () => undefined,
				maxOutputTokens: () => model.maxTokens,
				shouldStopGoalExecutionAfterTurn: () => false,
			}).install();
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
				planContext: agent.planContext,
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
			expect(initial.messages[2]).toMatchObject({
				role: "toolResult",
				content: [{ text: expect.stringContaining("[Context GC packed") }],
			});
			const acceptedRows = messages.length;
			expect(initial.messages).toHaveLength(acceptedRows);
			appendToolExchange(results);
			const appendedRows = messages.length - acceptedRows;
			const work = observeHistoryWork(messages);
			const accepted = await send();
			expect(accepted.messages[2]).toEqual(initial.messages[2]);
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
