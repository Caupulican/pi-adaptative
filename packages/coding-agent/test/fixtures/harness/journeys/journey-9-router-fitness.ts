import "../builtin-install.ts";
import { expect } from "vitest";
import { stateFile } from "../../../../src/core/agent-paths.ts";
import { ModelAdaptationStore } from "../../../../src/core/models/adaptation-store.ts";
import { FitnessStore } from "../../../../src/core/models/fitness-store.ts";
import type { ModelFitnessReport } from "../../../../src/core/research/model-fitness.ts";
import { HARNESS_API, HARNESS_PROVIDER } from "../scripted-provider.ts";
import type { HarnessWorld } from "../session-fixture.ts";

function fitnessReport(succeeded: number): ModelFitnessReport {
	const lane = {
		succeeded,
		total: 1,
		outcomes: [succeeded === 1 ? "ok" : "failed"],
		meanMs: 10,
	};
	return { trials: 1, research: lane, worker: lane, search: lane, toolCall: lane, digest: lane, totalCostUsd: 0 };
}

/** The owner's route preview reads one host snapshot for the candidates and the chosen model. */
export async function runJourney9RouterFitnessPhase(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-router-fitness`;
	const a = `${HARNESS_PROVIDER}/worker-a`;
	const b = `${HARNESS_PROVIDER}/worker-b`;
	const { session } = await world.createRootSession("root", {
		agentDir,
		settings: {
			modelFavorites: ["worker-a", "worker-b"].map((modelId) => ({ provider: HARNESS_PROVIDER, modelId })),
			modelRouter: { enabled: true, selectionMode: "auto", fitnessGate: true },
		},
	});
	const writer = FitnessStore.forAgentDir(agentDir, { readOnly: false });
	const evidenceFile = stateFile(agentDir, "model-fitness.json");
	writer.save("other-provider/worker-a", fitnessReport(1));
	writer.save(a, fitnessReport(0));
	writer.save(b, fitnessReport(1));

	const expectSingleEvidenceRead = (before: number) => {
		const reads = world.io.operations
			.slice(before)
			.filter((operation) => operation.kind === "read" && operation.path === evidenceFile);
		expect(reads, "all route preview candidates and its summary use the same host snapshot").toHaveLength(1);
	};
	const prompt = "What is the retry limit?";
	const preview = () => {
		const before = world.io.operations.length;
		const result = session.previewRoute(prompt);
		expectSingleEvidenceRead(before);
		return result;
	};

	expect(preview()).toMatchObject({ chosenModel: b, selection: "auto", fitness: "fit" });
	if (world.systemOne.enabled) {
		const flash = { kind: "choice", choice: "flash_light", confidence: 0.97 } as const;
		const flashDeep = { kind: "choice", choice: "flash_deep", confidence: 0.97 } as const;
		const strong = { kind: "choice", choice: "strong_medium", confidence: 0.97 } as const;
		const lightweight = { kind: "noul", probability: 0.97 } as const;
		world.systemOne.enterPhase("j9-router-fitness-preview", {
			route_choice: flash,
			route_choice_set_1: flash,
			route_choice_set_2: flash,
			route_choice_set_3: flash,
			route_choice_set_4: flashDeep,
			route_choice_set_5: flashDeep,
			route_choice_set_6: strong,
			lightweight_0: lightweight,
			lightweight_1: lightweight,
		});
		const before = world.io.operations.length;
		const live = await session.previewRouteLive(prompt);
		expectSingleEvidenceRead(before);
		expect(live).toMatchObject({ chosenModel: b, selection: "system_one", fitness: "fit" });
	}
	writer.save(a, fitnessReport(1));
	writer.save(b, fitnessReport(0));
	expect(preview()).toMatchObject({ chosenModel: a, selection: "auto", fitness: "fit" });
	if (world.systemOne.enabled) await verifyExpertRespectsEvidenceTier(world);
	await verifyExpensiveFallbackHonorsToolProbe(world);
}

async function verifyExpertRespectsEvidenceTier(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-router-expert-evidence`;
	const models = ["worker-a", "worker-b", "worker-c"];
	// Only the known-unfit candidate can run flash_light at its exact low effort.
	world.setModelReasoning("worker-c", true);
	try {
		const { session } = await world.createRootSession("root", {
			agentDir,
			settings: {
				modelFavorites: models.map((modelId) => ({ provider: HARNESS_PROVIDER, modelId })),
				modelRouter: { enabled: true, selectionMode: "auto", fitnessGate: false },
			},
		});
		const writer = FitnessStore.forAgentDir(agentDir, { readOnly: false });
		for (const id of models) writer.save(`${HARNESS_PROVIDER}/${id}`, fitnessReport(id === "worker-c" ? 0 : 1));
		const flash = { kind: "choice", choice: "flash_light", confidence: 0.97 } as const;
		const flashDeep = { kind: "choice", choice: "flash_deep", confidence: 0.97 } as const;
		const strong = { kind: "choice", choice: "strong_medium", confidence: 0.97 } as const;
		const lightweight = { kind: "noul", probability: 0.97 } as const;
		const current = { kind: "noul", probability: 0.02 } as const;
		world.systemOne.enterPhase("j9-router-expert-evidence", {
			route_choice: flash,
			route_choice_set_1: flash,
			route_choice_set_2: flash,
			route_choice_set_3: flash,
			route_choice_set_4: flashDeep,
			route_choice_set_5: flashDeep,
			route_choice_set_6: strong,
			lightweight_0: lightweight,
			lightweight_1: lightweight,
			lightweight_2: lightweight,
			superseded_0: current,
			superseded_1: current,
		});
		const live = await session.previewRouteLive("What is the retry limit?");
		expect(live).toMatchObject({ selection: "system_one", fitness: "fit" });
		expect([`${HARNESS_PROVIDER}/worker-a`, `${HARNESS_PROVIDER}/worker-b`]).toContain(live.chosenModel);
	} finally {
		world.setModelReasoning("worker-c", false);
	}
}

async function verifyExpensiveFallbackHonorsToolProbe(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-router-no-tool-path`;
	const provider = "j9-local-router";
	const modelId = "j9-local-no-tool-path";
	const expensiveModel = `${provider}/${modelId}`;
	const baseUrl = "http://127.0.0.1:7707/v1";
	const credential = world.authStorage.get(HARNESS_PROVIDER);
	if (credential?.type !== "api_key") throw new Error("The scripted provider credential is missing");
	world.modelRegistry.registerProvider(provider, {
		api: HARNESS_API,
		apiKey: credential.key,
		baseUrl,
		models: [{ ...world.provider.model("worker-a"), id: modelId, baseUrl }],
	});
	try {
		ModelAdaptationStore.forAgentDir(agentDir).setToolProbe(expensiveModel, {
			version: 1,
			status: "none",
			probedAt: new Date().toISOString(),
		});
		const { session } = await world.createRootSession("root", {
			agentDir,
			additionalRouterModels: [{ provider, modelId }],
			settings: {
				modelFavorites: [{ provider, modelId }],
				modelRouter: { enabled: true, selectionMode: "manual", expensiveModel, fitnessGate: false },
			},
		});
		const preview = session.previewRoute("Add a unit test for the retry limit.");
		expect(preview).toMatchObject({
			baselineTier: "medium",
			skipReason: "expensive model has no working tool-call path",
		});
		expect(preview.chosenModel).toBeUndefined();
	} finally {
		world.modelRegistry.unregisterProvider(provider);
	}
}
