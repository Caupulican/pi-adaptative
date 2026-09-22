#!/usr/bin/env node
/**
 * Live measurement of System One's model allocation (H-MoE) on this machine's real models: the
 * owner's authed pool, the host's measured speeds, the capability cards. Each case names what a
 * wrong choice looks like; a case that routes wrong fails the probe. The picks, confidences and the
 * flash category are printed so the choice can be read, not only scored.
 * Needs a TypeSafe key, provider auth and network; a report, not part of `npm run check`.
 *
 * usage: node --conditions=pi-source scripts/system-one-route-probe.mjs
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../packages/coding-agent/src/config.ts";
import { AuthStorage } from "../packages/coding-agent/src/core/auth-storage.ts";
import { ExpertAdmissionPolicy } from "../packages/coding-agent/src/core/expert-routing/admission.ts";
import { ExpertCapacityService } from "../packages/coding-agent/src/core/expert-routing/capacity.ts";
import { ExpertCatalog } from "../packages/coding-agent/src/core/expert-routing/catalog.ts";
import { ExpertFeatureBuilder } from "../packages/coding-agent/src/core/expert-routing/features.ts";
import { ExpertRankingPolicy } from "../packages/coding-agent/src/core/expert-routing/ranking.ts";
import { buildWorkerCapabilityRequest } from "../packages/coding-agent/src/core/expert-routing/request-builder.ts";
import { ExpertSelectionService } from "../packages/coding-agent/src/core/expert-routing/service.ts";
import { ModelRegistry } from "../packages/coding-agent/src/core/model-registry.ts";
import { ModelAdaptationStore } from "../packages/coding-agent/src/core/models/adaptation-store.ts";
import { FitnessStore } from "../packages/coding-agent/src/core/models/fitness-store.ts";
import { liveSystemOneController } from "./system-one-live.mjs";

const agentDir = getAgentDir();
const registry = ModelRegistry.create(AuthStorage.create(join(homedir(), ".pi", "agent", "auth.json")));
const fitnessStore = FitnessStore.forAgentDir(agentDir);
const adaptationStore = ModelAdaptationStore.forAgentDir(agentDir);
const controller = liveSystemOneController("system-one-route-probe");
const service = new ExpertSelectionService(
	new ExpertCatalog({ modelRegistry: registry, fitnessStore, adaptationStore }),
	new ExpertAdmissionPolicy(),
	new ExpertFeatureBuilder({ fitnessStore, adaptationStore }),
	new ExpertRankingPolicy(),
	new ExpertCapacityService(),
	undefined,
	() => controller,
);
const pool = registry.getAvailable().map((model) => `${model.provider}/${model.id}`);
const HIGH = new Set(["high", "xhigh", "max", "ultra"]);
const LOW = new Set(["off", "minimal", "low"]);

const CASES = [
	{
		prompt: "Here is a screenshot of the broken settings layout; fix the CSS so the labels line up.",
		tier: "medium",
		image: true,
		wrong: (card) => (!card.image ? "picked a model that cannot read the screenshot" : undefined),
	},
	{
		prompt: "Rename the variable `cfg` to `config` in src/app.ts.",
		tier: "cheap",
		wrong: (card, thinking) =>
			HIGH.has(thinking) && !card.flash ? "spent a strong model at high thinking on a one-line rename" : undefined,
	},
	{
		prompt:
			"Redesign the worker scheduler so a running worker can be preempted without deadlocks; analyze the lock ordering across the delegation controller, the dispatch scheduler and the write reservations, then propose the change.",
		tier: "expensive",
		wrong: (card, thinking) =>
			LOW.has(thinking) || !card.reasoning ? "gave a deep concurrency design no real reasoning" : undefined,
	},
];

let wrong = 0;
for (const testCase of CASES) {
	const request = buildWorkerCapabilityRequest({
		objectiveId: "probe",
		taskId: `probe-${testCase.tier}`,
		workClass: testCase.tier === "cheap" ? "retrieve" : "implement",
		consequence: testCase.tier === "expensive" ? "critical" : testCase.tier === "cheap" ? "low" : "medium",
		decisionSignals: { suggestedTier: testCase.tier },
		metadata: { prompt: testCase.prompt },
		preferSubscription: true,
		allowedModelRefs: pool,
		...(testCase.image ? { requiredCapabilities: ["image_input"] } : {}),
	});
	const started = Date.now();
	const selection = await service.select(request, { requestText: testCase.prompt });
	service.release(selection);
	const pick = selection.primary;
	const model = registry.find(pick.provider, pick.model_id);
	const card = {
		image: model?.input.includes("image") === true,
		reasoning: model?.reasoning === true,
		flash: selection.decidedBy?.reasons?.[0]?.includes("(flash)") === true,
	};
	const problem = testCase.wrong(card, pick.thinking_level);
	if (problem) wrong += 1;
	console.log(
		`${problem ? "WRONG" : "ok   "} ${testCase.prompt.slice(0, 70)}\n      -> ${pick.provider}/${pick.model_id} @ ${pick.thinking_level} · decided by ${selection.decidedBy?.kind} ${selection.decidedBy?.confidence ?? ""} · ${Date.now() - started} ms\n      ${(selection.decidedBy?.reasons ?? []).join(" | ")}${problem ? `\n      ${problem}` : ""}`,
	);
}
console.log(`${wrong} wrong of ${CASES.length}; pool ${pool.length} models`);
process.exit(wrong > 0 ? 1 : 0);
