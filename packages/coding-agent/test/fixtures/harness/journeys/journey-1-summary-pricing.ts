import { join } from "node:path";
import { expect } from "vitest";
import { ModelRegistry } from "../../../../src/core/model-registry.ts";
import { HARNESS_API, HARNESS_PROVIDER, text } from "../scripted-provider.ts";
import { type HarnessWorld, SCRIPTED_TRACKS, withDeadline } from "../session-fixture.ts";
import { icmContinuousStore } from "./shared.ts";

/** A real custom model with omitted prices cannot run a paid summary; the normal chat remains usable. */
export async function runSummaryPricingJourney(world: HarnessWorld, finishQuiet: () => void): Promise<void> {
	const provider = "h12-unpriced";
	const modelId = "summary";
	const reference = `${provider}/${modelId}`;
	const agentDir = `${world.agentDir}-icm-unpriced`;
	const warning = `The ICM chat's summary model ${reference} has no declared price: configure its input, output and cache prices, including explicit zero prices if applicable.`;
	const warningMark = world.warnings.length;
	const requestMark = world.provider.requests.length;
	world.io.mkdirSync(agentDir, { recursive: true });
	const modelsPath = join(agentDir, "models.json");
	const rootModel = world.provider.model("root");
	world.io.writeFileSync(
		modelsPath,
		JSON.stringify({
			providers: {
				[HARNESS_PROVIDER]: {
					api: HARNESS_API,
					baseUrl: rootModel.baseUrl,
					apiKey: "harness-fixture-key",
					models: SCRIPTED_TRACKS.map((id) => {
						const model = world.provider.model(id);
						return {
							id,
							name: model.name,
							reasoning: model.reasoning,
							thinkingLevelMap: model.thinkingLevelMap,
							input: model.input,
							contextWindow: model.contextWindow,
							maxTokens: model.maxTokens,
							cost: model.cost,
						};
					}),
				},
				[provider]: {
					api: HARNESS_API,
					baseUrl: "https://h12.invalid",
					apiKey: "h12-fixture-key",
					models: [
						{
							id: modelId,
							name: "H12 unpriced summary",
							reasoning: true,
							input: ["text"],
							contextWindow: 32_768,
							maxTokens: 4096,
						},
					],
				},
			},
		}),
	);
	const registry = ModelRegistry.create(world.authStorage, modelsPath);
	let owner: Awaited<ReturnType<HarnessWorld["createRootSession"]>> | undefined;
	try {
		expect(registry.getError()).toBeUndefined();
		const model = registry.find(provider, modelId);
		expect(model?.costDefaulted, "omitted custom rates are distinguished from explicit zero").toBe(true);
		owner = await world.createRootSession("root", {
			agentDir,
			modelRegistry: registry,
			sessionManager: world.createSessionManager(agentDir),
			settings: {
				memorySystem: "icm",
				contextPolicy: { memory: { history: { summaryModel: reference, allowExternalSummaryEgress: true } } },
			},
		});
		world.provider.enqueue("root", text("h12-unpriced-owner", "The conversation remains available."));
		world.systemOne.enterPhase("h12-unpriced", {});
		await withDeadline(world.trace, "H12 owner turn", owner.session.prompt(`Remember ${"u".repeat(600)}`));
		finishQuiet();
		const store = icmContinuousStore(agentDir);
		await withDeadline(
			world.trace,
			"H12 unpriced summary blocked",
			world.io.waitForMutation(() => {
				const rows = world.guard.peekSqlite(
					store.queueDatabase,
					"SELECT level, ordinal, status, reason FROM work WHERE level=0 AND ordinal=0",
				);
				return rows?.some((row) => row.status === "blocked" && row.reason === warning) === true;
			}),
			60_000,
		);
		expect(
			world.provider.requests.slice(requestMark).filter((request) => request.model.provider === provider),
			"no physical request goes to an unpriced summary model",
		).toEqual([]);
		expect(owner.session.messages.at(-1)?.role).toBe("assistant");
		const exact = [warning, `Continuous-chat compaction 0+1 failed: ${warning}`];
		await withDeadline(
			world.trace,
			"H12 warnings delivered",
			world.whenWarnings(warningMark, (seen) => exact.every((message) => seen.includes(message))),
		);
		for (const message of exact) {
			const matches = world.warnings.slice(warningMark).filter((entry) => entry === message);
			expect(matches).toHaveLength(1);
			world.warnings.splice(world.warnings.indexOf(message, warningMark), 1);
		}
		world.trace.mark("root", "icm.summary-unpriced");
	} finally {
		if (owner) expect(await world.disposeSessionInBody(owner.session)).toBeUndefined();
	}
}
