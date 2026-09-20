import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@caupulican/pi-agent-core";
import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { RouteDecision } from "../src/core/autonomy/contracts.ts";
import {
	buildWorkerCapabilityRequest,
	ExpertAdmissionPolicy,
	ExpertCatalog,
	type ExpertFeatureVector,
	ExpertRankingPolicy,
	type ScoredExpertCandidate,
	type WorkerCapabilityRequest,
} from "../src/core/expert-routing/index.ts";
import type { ExpertSelectionService } from "../src/core/expert-routing/service.ts";
import { selectAutoTierModel } from "../src/core/model-router/auto-selection.ts";
import {
	formatRouterPoolSummary,
	resolveRouterCandidatePool,
	routerPoolModelRefs,
} from "../src/core/model-router/candidate-pool.ts";
import { formatRoutePreview } from "../src/core/model-router/route-preview.ts";
import { formatModelRouterStatus } from "../src/core/model-router/status.ts";
import { ModelRouterController, type ModelRouterControllerDeps } from "../src/core/model-router-controller.ts";
import { FitnessStore } from "../src/core/models/fitness-store.ts";
import type { ModelFitnessReport } from "../src/core/research/model-fitness.ts";

type TestModel = Model<Api>;

function model(provider: string, id: string, overrides: Partial<TestModel> = {}): TestModel {
	return {
		id,
		name: id,
		provider,
		api: "messages",
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
		...overrides,
	} as TestModel;
}

// Subscription-backed models are deliberately pricier so cost alone would rank them last.
const subCheap = model("sub-provider", "sub-mini", { cost: { input: 3, output: 3, cacheRead: 0, cacheWrite: 0 } });
const subBig = model("sub-provider", "sub-max", { cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } });
const apiCheap = model("api-provider", "api-mini", { cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } });
const apiBig = model("api-provider", "api-max", { cost: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } });
const outsider = model("api-provider", "outsider", { cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } });
const ALL = [subCheap, subBig, apiCheap, apiBig, outsider];

const isSubscription = (m: TestModel): boolean => m.provider === "sub-provider";

function fitnessReport(overrides: Partial<ModelFitnessReport> = {}): ModelFitnessReport {
	const lane = { succeeded: 3, total: 3, outcomes: [], meanMs: 10 };
	return {
		trials: 3,
		research: { ...lane },
		worker: { ...lane },
		search: { ...lane },
		toolCall: { ...lane },
		digest: { ...lane },
		judge: {
			parsed: 3,
			planningElevated: 3,
			planningTotal: 3,
			trivialCheap: 3,
			trivialTotal: 3,
			total: 3,
			outcomes: [],
			meanMs: 0,
		},
		totalCostUsd: 0,
		...overrides,
	};
}

type RouterSettings = ReturnType<
	ModelRouterControllerDeps["getSettingsManager"]
>["getModelRouterSettings"] extends () => infer R
	? R
	: never;

function settings(overrides: Partial<RouterSettings> = {}): RouterSettings {
	return {
		enabled: true,
		selectionMode: "manual",
		poolPreference: "subscription-first",
		judgeEnabled: false,
		fitnessGate: false,
		...overrides,
	};
}

interface ControllerFixture {
	controller: ModelRouterController;
	agentDir: string;
	expertSelect: ReturnType<typeof vi.fn>;
	isolatedCompletion: ReturnType<typeof vi.fn>;
	setSettings(next: Partial<RouterSettings>): void;
	setPool(models: TestModel[] | undefined): void;
}

function createController(options: {
	settings?: Partial<RouterSettings>;
	pool?: TestModel[];
	authed?: TestModel[];
	exhausted?: TestModel[];
	expertPick?: TestModel;
	withExpertSelector?: boolean;
}): ControllerFixture {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-router-modes-"));
	let current = settings(options.settings);
	let scoped: TestModel[] | undefined = options.pool;
	const authed = options.authed ?? ALL;
	const exhausted = options.exhausted ?? [];
	const registry = {
		getAll: () => ALL,
		getAvailable: () => ALL.filter((m) => authed.includes(m)),
		hasConfiguredAuth: (m: TestModel) => authed.includes(m),
		find: (provider: string, id: string) => ALL.find((m) => m.provider === provider && m.id === id),
		isUsingSubscription: isSubscription,
	};
	const expertSelect = vi.fn(async (request: WorkerCapabilityRequest) => {
		const pick = options.expertPick ?? subBig;
		return {
			primary: { provider: pick.provider, model_id: pick.id, thinking_level: "off" },
			request,
		};
	});
	const isolatedCompletion = vi.fn(async () => ({}) as never);
	const agent = { state: { model: apiCheap, thinkingLevel: "off", messages: [], tools: [], systemPrompt: "" } };
	const deps: ModelRouterControllerDeps = {
		getAgent: () => agent as unknown as Agent,
		getModel: () => apiCheap,
		getSettingsManager: () =>
			({
				getModelRouterSettings: () => current,
				getModelCapabilitySettings: () => ({ mode: "off" }),
				getToolkitScripts: () => [],
			}) as never,
		getSessionManager: () =>
			({ getEntries: () => [], getSessionId: () => "s", appendCustomEntry: () => "e" }) as never,
		appendSessionMessageBatch: () => [],
		getModelRegistry: () => registry as never,
		isModelExhausted: (m) => exhausted.includes(m),
		getFailoverStatus: () => ({ exhausted: [] }),
		getAgentDir: () => agentDir,
		getReflectionSignal: () => new AbortController().signal,
		getBaseSystemPrompt: () => "",
		runAgentPrompt: async () => {},
		runAgentContinuation: async () => {},
		buildSystemPromptForToolNames: () => "",
		refreshCurrentModelFromRegistry: () => {},
		runIsolatedCompletion: isolatedCompletion,
		addSpawnedUsage: () => undefined,
		emit: () => {},
		emitAutonomyTelemetry: () => {},
		resolveLaneModel: () => undefined,
		resolveCurationModelIfFit: () => undefined,
		getToolProbeVerdict: () => undefined,
		getCandidatePool: () =>
			resolveRouterCandidatePool(
				(scoped ?? []).map((m) => ({ model: m })),
				registry,
			),
		isUsingSubscription: isSubscription,
		...(options.withExpertSelector
			? { expertSelector: { select: expertSelect } as unknown as ExpertSelectionService }
			: {}),
	};
	return {
		controller: new ModelRouterController(deps),
		agentDir,
		expertSelect,
		isolatedCompletion,
		setSettings: (next) => {
			current = { ...current, ...next };
		},
		setPool: (models) => {
			scoped = models;
		},
	};
}

function resolve(
	controller: ModelRouterController,
	prompt: string,
): { decision: RouteDecision; model: TestModel } | undefined {
	return (
		controller as unknown as {
			_resolveModelRouterTurnRoute(p: string): { decision: RouteDecision; model: TestModel } | undefined;
		}
	)._resolveModelRouterTurnRoute(prompt);
}

const RESEARCH_PROMPT = "Explain this code block";
const MODIFY_PROMPT = "Implement the new settings submenu and update the tests";
const EXPENSIVE_PROMPT = "Rewrite the core architecture of the router";

describe("Router candidate pool (F001-030..034)", () => {
	it("F001-031: an uncustomized Models configuration means every authed model", () => {
		const pool = resolveRouterCandidatePool([], { getAvailable: () => [subCheap, apiCheap] });
		expect(pool.customized).toBe(false);
		expect(routerPoolModelRefs(pool)).toEqual(["sub-provider/sub-mini", "api-provider/api-mini"]);
		expect(formatRouterPoolSummary(pool)).toBe("all enabled models (2)");
	});

	it("F001-030: a customized Models configuration is the hard pool", () => {
		const pool = resolveRouterCandidatePool([{ model: subBig }], { getAvailable: () => ALL });
		expect(pool.customized).toBe(true);
		expect(routerPoolModelRefs(pool)).toEqual(["sub-provider/sub-max"]);
		expect(formatRouterPoolSummary(pool)).toBe("1 selected model");
	});
});

describe("Deterministic auto selection (F001-041, F001-050..055)", () => {
	const deps = (overrides: Partial<Parameters<typeof selectAutoTierModel>[2]> = {}) => ({
		isSubscription,
		hasConfiguredAuth: () => true,
		isExhausted: () => false,
		toolProbeVerdict: () => undefined,
		fitness: () => ({ fit: true, probed: false }) as const,
		fitnessGate: false,
		preference: "subscription-first" as const,
		...overrides,
	});

	it("F001-051/053: subscription-first ranks an adequate subscription model over a cheaper metered one", () => {
		const result = selectAutoTierModel("cheap", [apiCheap, subCheap, apiBig, subBig], deps());
		expect(result.chosen?.ref).toBe("sub-provider/sub-mini");
		expect(result.subscriptionPreferred).toBe(true);
		expect(result.subscriptionEligible).toBe(2);
		expect(result.eligible).toBe(4);
		expect(result.reason).toContain("subscription-preferred");
	});

	it("F001-052/053: an inadequate subscription model loses to an adequate metered one (gate is hard)", () => {
		const result = selectAutoTierModel("cheap", [apiCheap, subCheap], {
			...deps(),
			fitnessGate: true,
			fitness: (_surface, m) =>
				m === subCheap
					? { fit: false, reason: "lane_failed", lane: "research", succeeded: 0, total: 3 }
					: { fit: true, probed: true },
		});
		expect(result.chosen?.ref).toBe("api-provider/api-mini");
		expect(result.subscriptionPreferred).toBe(false);
		expect(result.candidates.find((c) => c.ref === "sub-provider/sub-mini")?.rejectReasons).toEqual(["fitness_gate"]);
	});

	it("hard admission: auth, quota and a missing tool path reject before any preference", () => {
		const local = model("ollama", "local-x");
		const result = selectAutoTierModel("medium", [subCheap, apiCheap, local], {
			...deps(),
			hasConfiguredAuth: (m) => m !== subCheap,
			isExhausted: (m) => m === apiCheap,
			toolProbeVerdict: (m) => (m === local ? "none" : undefined),
		});
		expect(result.chosen).toBeUndefined();
		expect(result.reason).toContain("no admitted candidate");
		expect(result.reason).toContain("auth_missing");
		expect(result.reason).toContain("quota_exhausted");
		expect(result.reason).toContain("no_tool_path");
	});

	it("balanced preference keeps the evidence ranking alone", () => {
		const result = selectAutoTierModel("cheap", [apiCheap, subCheap], deps({ preference: "balanced" }));
		expect(result.chosen?.ref).toBe("api-provider/api-mini");
		expect(result.subscriptionPreferred).toBe(false);
	});

	it("evidence outranks cost inside a class: a probed-fit model beats an unprobed one", () => {
		const result = selectAutoTierModel("cheap", [apiCheap, apiBig], {
			...deps({ preference: "balanced" }),
			fitness: (_surface, m) => ({ fit: true, probed: m === apiBig }),
		});
		expect(result.chosen?.ref).toBe("api-provider/api-max");
	});
});

describe("Router selection modes (F001-040..044)", () => {
	it("F001-040/044: MANUAL keeps exact pin behavior and an unset tier stays unset", () => {
		const fixture = createController({ settings: { cheapModel: "api-provider/api-mini" } });
		const routed = resolve(fixture.controller, RESEARCH_PROMPT);
		expect(routed?.model).toBe(apiCheap);
		expect(routed?.decision.selection).toBe("manual");
		expect(resolve(fixture.controller, MODIFY_PROMPT)).toBeUndefined();
		expect(fixture.controller.isTierAutoSelected("expensive")).toBe(false);
	});

	it("F001-041: AUTO selects the exact model from the pool, ignoring pins", () => {
		const fixture = createController({
			settings: { selectionMode: "auto", cheapModel: "api-provider/api-mini" },
		});
		const routed = resolve(fixture.controller, RESEARCH_PROMPT);
		expect(routed?.decision.selection).toBe("auto");
		expect(routed?.model).toBe(subCheap);
		expect(routed?.decision.reasons.at(-1)).toContain("Auto-selected sub-provider/sub-mini");
	});

	it("F001-042/043: HYBRID lets a manual pin win and auto-selects unpinned tiers", () => {
		const fixture = createController({
			settings: { selectionMode: "hybrid", cheapModel: "api-provider/api-mini" },
		});
		const cheap = resolve(fixture.controller, RESEARCH_PROMPT);
		expect(cheap?.model).toBe(apiCheap);
		expect(cheap?.decision.selection).toBe("manual");
		const medium = resolve(fixture.controller, MODIFY_PROMPT);
		expect(medium?.decision.tier).toBe("medium");
		expect(medium?.decision.selection).toBe("auto");
		expect(medium?.model).toBe(subCheap);
		const expensive = resolve(fixture.controller, EXPENSIVE_PROMPT);
		expect(expensive?.decision.tier).toBe("expensive");
		expect(expensive?.decision.selection).toBe("auto");
		expect(expensive?.model).toBe(subBig);
	});

	it("F001-034/055: an automatic route can never leave a customized pool, even for a cheaper outsider", () => {
		const fixture = createController({ settings: { selectionMode: "auto" }, pool: [apiBig] });
		const routed = resolve(fixture.controller, RESEARCH_PROMPT);
		expect(routed?.model).toBe(apiBig);
		expect(routed?.decision.selection).toBe("auto");
	});

	it("F001-054: a manual pin to a metered model overrides subscription preference", () => {
		const fixture = createController({
			settings: { selectionMode: "hybrid", expensiveModel: "api-provider/api-max" },
		});
		const routed = resolve(fixture.controller, EXPENSIVE_PROMPT);
		expect(routed?.model).toBe(apiBig);
		expect(routed?.decision.selection).toBe("manual");
	});

	it("AUTO with an empty eligible set on medium falls back to the expensive tier, then skips truthfully", () => {
		const fixture = createController({ settings: { selectionMode: "auto" }, pool: [subCheap], authed: [] });
		expect(resolve(fixture.controller, RESEARCH_PROMPT)).toBeUndefined();
		const status = fixture.controller.getStatus();
		expect(status).toContain("cheap tier auto-selection: no admitted candidate (auth_missing)");
	});
});

describe("H-MoE bounded to the pool (F001-033, F001-056, F001-092)", () => {
	it("MANUAL never consults the expert selector; a pin is authoritative", async () => {
		const fixture = createController({
			settings: { cheapModel: "api-provider/api-mini" },
			withExpertSelector: true,
		});
		const routed = await fixture.controller.resolveTurnRouteJudged(RESEARCH_PROMPT);
		expect(routed?.model).toBe(apiCheap);
		expect(routed?.decision.selection).toBe("manual");
		expect(fixture.expertSelect).not.toHaveBeenCalled();
	});

	it("AUTO passes the pool allowlist and subscription preference and records H-MoE provenance", async () => {
		const fixture = createController({
			settings: { selectionMode: "auto" },
			pool: [subCheap, subBig],
			withExpertSelector: true,
			expertPick: subBig,
		});
		const routed = await fixture.controller.resolveTurnRouteJudged(RESEARCH_PROMPT);
		expect(fixture.expertSelect).toHaveBeenCalledTimes(1);
		const request = fixture.expertSelect.mock.calls[0]?.[0] as WorkerCapabilityRequest;
		expect(request.allowed_model_refs).toEqual(["sub-provider/sub-mini", "sub-provider/sub-max"]);
		expect(request.prefer_subscription).toBe(true);
		expect(routed?.model).toBe(subBig);
		expect(routed?.decision.selection).toBe("hmoe");
	});

	it("an expert pick outside the pool is rejected and the deterministic pool choice stands", async () => {
		const fixture = createController({
			settings: { selectionMode: "auto" },
			pool: [apiBig],
			withExpertSelector: true,
			expertPick: outsider,
		});
		const routed = await fixture.controller.resolveTurnRouteJudged(RESEARCH_PROMPT);
		expect(routed?.model).toBe(apiBig);
		expect(routed?.decision.selection).toBe("auto");
	});

	it("catalog generation and admission both enforce allowed_model_refs; ranking orders subscription first", async () => {
		const catalog = new ExpertCatalog({
			modelRegistry: {
				getAll: () => ALL,
				hasConfiguredAuth: () => true,
				isUsingSubscription: isSubscription,
			} as never,
		});
		const request = buildWorkerCapabilityRequest({
			objectiveId: "o",
			taskId: "t",
			workClass: "retrieve",
			allowedModelRefs: ["api-provider/api-max"],
			preferSubscription: true,
		});
		const candidates = await catalog.materializeCandidates(request);
		expect(new Set(candidates.map((c) => `${c.descriptor.provider}/${c.descriptor.model_id}`))).toEqual(
			new Set(["api-provider/api-max"]),
		);
		const admission = new ExpertAdmissionPolicy();
		const outsideCandidate = (
			await catalog.materializeCandidates({ ...request, allowed_model_refs: undefined })
		).find((c) => c.descriptor.model_id === "outsider");
		expect(outsideCandidate).toBeDefined();
		expect(admission.evaluate(request, outsideCandidate!).reasonCodes).toContain("model_not_in_pool");

		const vector = (score: number, subscriptionPreferred: number): ExpertFeatureVector =>
			({ totalScore: score, subscriptionPreferred }) as ExpertFeatureVector;
		const metered = (await catalog.materializeCandidates({ ...request, allowed_model_refs: undefined })).find(
			(c) => c.descriptor.model_id === "api-max",
		)!;
		const sub = (await catalog.materializeCandidates({ ...request, allowed_model_refs: undefined })).find(
			(c) => c.descriptor.model_id === "sub-max",
		)!;
		expect(sub.state.subscriptionBacked).toBe(true);
		expect(metered.state.subscriptionBacked).toBe(false);
		const scored: ScoredExpertCandidate[] = [
			{ candidate: metered, features: vector(0.9, 0) },
			{ candidate: sub, features: vector(0.6, 1) },
		];
		const plan = new ExpertRankingPolicy().select({ ...request, allowed_model_refs: undefined }, scored, "single");
		expect(plan.primary.model_id).toBe("sub-max");
		const balanced = new ExpertRankingPolicy().select(
			{ ...request, allowed_model_refs: undefined, prefer_subscription: false },
			scored,
			"single",
		);
		expect(balanced.primary.model_id).toBe("api-max");
	});
});

describe("Route preview (F001-080..083)", () => {
	it("F001-080/082: the deterministic preview makes no provider call and mutates no router state", () => {
		const fixture = createController({
			settings: { selectionMode: "hybrid", cheapModel: "api-provider/api-max" },
			pool: [subCheap, subBig, apiBig],
			withExpertSelector: true,
		});
		const before = fixture.controller.getStatus();
		const preview = fixture.controller.previewRoute(MODIFY_PROMPT);
		expect(fixture.expertSelect).not.toHaveBeenCalled();
		expect(fixture.isolatedCompletion).not.toHaveBeenCalled();
		expect(fixture.controller.getStatus()).toBe(before);
		expect(fixture.controller.getForegroundRouteSnapshot().source).toBe("direct");
		expect(preview.intent).toBe("modify");
		expect(preview.selectionMode).toBe("hybrid");
		expect(preview.pool).toEqual({ customized: true, count: 3 });
		expect(preview.subscriptionCandidates).toBe(2);
		expect(preview.baselineTier).toBe("medium");
		expect(preview.manualPin).toBeUndefined();
		expect(preview.chosenModel).toBe("sub-provider/sub-mini");
		expect(preview.selection).toBe("auto");
		expect(preview.candidates.length).toBeGreaterThan(0);
		const text = formatRoutePreview(preview);
		expect(text).toContain("Selection mode: HYBRID");
		expect(text).toContain("Pool: 3 selected");
		expect(text).toContain("Subscription candidates: 2");
		expect(text).toContain("Would choose: sub-provider/sub-mini");
		expect(text).toContain("Source: router");
		expect(text).toContain("no provider call was made");
	});

	it("F001-081/083: the live preview runs the judged path on request and reports source/preference/fitness", async () => {
		const fixture = createController({
			settings: { selectionMode: "auto" },
			pool: [subCheap, subBig],
			withExpertSelector: true,
			expertPick: subCheap,
		});
		FitnessStore.forAgentDir(fixture.agentDir).save("sub-provider/sub-mini", fitnessReport());
		const live = await fixture.controller.previewRouteLive(RESEARCH_PROMPT);
		expect(fixture.expertSelect).toHaveBeenCalledTimes(1);
		expect(live.chosenModel).toBe("sub-provider/sub-mini");
		expect(live.selection).toBe("hmoe");
		expect(live.poolPreference).toBe("subscription-first");
		expect(live.fitness).toBe("fit");
		expect(fixture.controller.getForegroundRouteSnapshot().source).toBe("direct");
	});
});

describe("Router status (F001-056, F001-063..065)", () => {
	it("shows mode, pool and preference, and the selection provenance of a decision", () => {
		const status = formatModelRouterStatus(
			{ enabled: true, selectionMode: "auto", poolPreference: "subscription-first" },
			{
				route: {
					tier: "medium",
					risk: "scoped-write",
					confidence: 1,
					reasonCode: "normal_implementation",
					reasons: [],
					selection: "hmoe",
				},
				routedModel: "sub-provider/sub-max",
				outcome: "routed",
			},
			undefined,
			[],
			undefined,
			"modify",
			undefined,
			undefined,
			"3 selected models",
		);
		expect(status).toContain("Selection mode: AUTO");
		expect(status).toContain("Candidate pool: 3 selected models");
		expect(status).toContain("Pool preference: subscription-first");
		expect(status).toContain("selected by H-MoE");
	});
});
