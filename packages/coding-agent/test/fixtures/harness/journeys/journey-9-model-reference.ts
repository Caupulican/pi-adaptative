import "../builtin-install.ts";
import { expect } from "vitest";
import { ModelRegistry } from "../../../../src/core/model-registry.ts";
import type { AgentMessage } from "../../../../src/kernel/index.ts";
import { calls, createBarrier, HARNESS_API, HARNESS_PROVIDER, text } from "../scripted-provider.ts";
import { type HarnessWorld, SCRIPTED_TRACKS, withDeadline } from "../session-fixture.ts";
import {
	carriesTask,
	handoffBlocks,
	J9_ROOT_JUDGMENTS,
	J9_ROOT_REPLY,
	J9_SETTINGS,
	recordedOutcome,
	workerReport,
} from "./journey-9-shared.ts";
import { latestBatchResults } from "./shared.ts";

const SOL = "gpt-6.2-sol";
const OTHER_SOL = "gpt-6.1-sol";
const UNAVAILABLE_SOL = "gpt-unavailable-sol";
const solFavorite = { provider: HARNESS_PROVIDER, modelId: SOL };
const otherSolFavorite = { provider: HARNESS_PROVIDER, modelId: OTHER_SOL };
const unavailableSolFavorite = { provider: "unavailable-harness-account", modelId: SOL };

function delegateReceipt(messages: readonly AgentMessage[], toolCallId: string) {
	const result = messages.findLast((message) => message.role === "toolResult" && message.toolCallId === toolCallId);
	if (result?.role !== "toolResult") throw new Error(`Missing delegate receipt for ${toolCallId}`);
	return result;
}

/** Exercise the root's documented model field through the SDK, real delegate tool, and worker provider. */
export async function runJourney9ModelReferencePhase(world: HarnessWorld): Promise<void> {
	const registry = ModelRegistry.inMemory(world.authStorage);
	const credential = world.authStorage.get(HARNESS_PROVIDER);
	if (credential?.type !== "api_key") throw new Error("The scripted provider credential is missing");
	registry.registerProvider(HARNESS_PROVIDER, {
		api: HARNESS_API,
		apiKey: credential.key,
		baseUrl: world.provider.model("root").baseUrl,
		models: [...SCRIPTED_TRACKS, SOL, OTHER_SOL].map((id) => world.provider.model(id)),
	});

	const scenarios = [
		{ name: "favorite", reference: "sol", favorites: [solFavorite], modelId: SOL },
		{
			name: "ambiguous",
			reference: "sol",
			favorites: [solFavorite, otherSolFavorite],
			reason: "ambiguous",
		},
		{
			name: "ambiguous-across-accounts",
			reference: SOL,
			favorites: [solFavorite, unavailableSolFavorite],
			reason: "ambiguous",
		},
		{
			name: "unavailable",
			reference: UNAVAILABLE_SOL,
			favorites: [{ provider: HARNESS_PROVIDER, modelId: UNAVAILABLE_SOL }],
			reason: "unavailable",
		},
		{
			name: "qualified",
			reference: `${HARNESS_PROVIDER}/${OTHER_SOL}`,
			favorites: [solFavorite, otherSolFavorite],
			modelId: OTHER_SOL,
		},
		{ name: "versioned", reference: "Sol 6.2", favorites: [solFavorite, otherSolFavorite], modelId: SOL },
	] as const;

	for (const scenario of scenarios) {
		const prefix = `j9-model-reference-${scenario.name}`;
		const prompt = scenario.name === "favorite" ? "send one sol agent" : `Send one ${scenario.reference} agent.`;
		const instructions = `${prefix}: Read src/limits.ts and report MAX_RETRIES.`;
		const callId = `${prefix}-call`;
		const modelId = "modelId" in scenario ? scenario.modelId : undefined;
		const modelRef = modelId ? `${HARNESS_PROVIDER}/${modelId}` : undefined;
		const refusal = "reason" in scenario ? `Worker model reference is ${scenario.reason}.` : "";
		const workerGate = createBarrier();
		const handoff = createBarrier();
		const { session } = await world.createRootSession("root", {
			modelRegistry: registry,
			additionalRouterModels: [SOL, OTHER_SOL].map((modelId) => ({ provider: HARNESS_PROVIDER, modelId })),
			settings: {
				...J9_SETTINGS,
				modelFavorites: [...scenario.favorites],
				modelRouter: { fitnessGate: false },
			},
		});
		const before = world.provider.requests.length;
		world.systemOne.enterPhase(prefix, J9_ROOT_JUDGMENTS);
		world.provider.enqueue(
			"root",
			{
				...calls(prefix, [
					{
						id: callId,
						name: "delegate",
						arguments: { action: "start", model: scenario.reference, instructions, readOnly: true },
					},
				]),
				check: (request) => {
					expect(JSON.stringify(request.context.messages)).toContain(prompt);
					if (scenario.name === "favorite") {
						expect(request.context.tools?.find((tool) => tool.name === "delegate")?.description).toContain(
							'{"action":"start","model":"sol","instructions":"<worker brief>"}',
						);
					}
				},
			},
			{
				...text(`${prefix}-receipt`, J9_ROOT_REPLY),
				check: (request) => {
					const receipt = delegateReceipt(request.context.messages, callId);
					expect(receipt.isError, JSON.stringify(receipt)).toBe(modelId === undefined);
					if (refusal) {
						const content = JSON.stringify(receipt.content);
						expect(content).toContain(refusal);
						for (const { provider, modelId } of scenario.favorites)
							expect(content).toContain(`${provider}/${modelId}`);
					} else expect(receipt.details).toMatchObject({ modelRef, agentId: expect.any(String) });
				},
			},
		);
		if (modelId) {
			world.provider.enqueue("root", {
				...text(`${prefix}-handoff`, J9_ROOT_REPLY),
				maxRequests: 4,
				until: (request) => {
					if (!handoffBlocks(request).some((block) => block.outcome.includes("Outcome: succeeded"))) return false;
					handoff.release();
					return true;
				},
			});
			world.provider.enqueueTrack(
				prefix,
				modelId,
				carriesTask(instructions),
				{
					...calls(`${prefix}-read`, [
						{ id: `${prefix}-read-call`, name: "read", arguments: { path: "src/limits.ts" } },
					]),
					check: (request) => expect(request.model).toMatchObject({ provider: HARNESS_PROVIDER, id: modelId }),
					gate: workerGate.promise,
				},
				{
					...workerReport(`${prefix}-report`, { status: "completed", summary: "MAX_RETRIES is 3." }),
					check: (request) => {
						const read = latestBatchResults(request).find((result) => result.toolName === "read");
						expect(read).toMatchObject({ isError: false, text: expect.stringContaining("MAX_RETRIES = 3") });
					},
				},
			);
		}
		try {
			await withDeadline(world.trace, `${prefix} root turn`, session.prompt(prompt));
			const receipt = delegateReceipt(session.messages, callId);
			expect(receipt.isError, JSON.stringify(receipt)).toBe(modelId === undefined);
			workerGate.release();
			if (modelId) await withDeadline(world.trace, `${prefix} worker handoff`, handoff.promise);
			await withDeadline(world.trace, `${prefix} root idle`, session.waitForForegroundIdle());

			const snapshot = session.backgroundLanes.getTaskRuntimeSnapshot();
			const attempts = Object.values(snapshot?.attempts ?? {});
			const workerRequests = world.provider.requests.slice(before).filter((request) => request.model.id !== "root");
			if (modelId) {
				expect(attempts, "one worker starts for one explicit model").toHaveLength(1);
				const attempt = attempts[0]!;
				expect(attempt.dispatch.executionContract?.worker.modelBinding).toMatchObject({
					provider: HARNESS_PROVIDER,
					modelId,
				});
				expect(recordedOutcome(session, attempt.dispatch.taskId).attempts.map((entry) => entry.modelRef)).toEqual([
					modelRef,
				]);
				expect(workerRequests.map((request) => `${request.model.provider}/${request.model.id}`)).toEqual([
					modelRef,
					modelRef,
				]);
			} else {
				expect(receipt.details).toMatchObject({
					piToolFailureMemory: {
						diagnostic: expect.stringContaining(refusal),
					},
				});
				expect(attempts, "a refused model never creates a worker attempt").toHaveLength(0);
				expect(workerRequests, "a refused model never reaches a worker provider").toHaveLength(0);
			}
		} finally {
			workerGate.release();
			expect(await world.disposeSessionInBody(session)).toBeUndefined();
		}
	}
}
