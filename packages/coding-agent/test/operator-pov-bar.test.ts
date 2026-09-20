import { beforeAll, describe, expect, it } from "vitest";
import type { ForegroundRouteSnapshot } from "../src/core/model-router-controller.ts";
import type { OperatorProjection } from "../src/core/operator-projection/types.ts";
import {
	type SemanticPlaneHealth,
	SemanticPlaneHealthRecorder,
	semanticPlaneHealthLabel,
} from "../src/core/system-one/semantic-plane-health.ts";
import {
	buildOperatorPovSegments,
	formatRouteValue,
	layoutOperatorPovSegments,
	OperatorPovBarComponent,
	type OperatorPovSource,
} from "../src/modes/interactive/components/operator-pov-bar.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

function projection(overrides: Partial<OperatorProjection> = {}): OperatorProjection {
	return {
		schema_version: "1.0",
		objective_id: "obj",
		title: "fixture",
		phase: "build",
		phase_index: 3,
		phase_count: 6,
		current_action: "Simplifying settings",
		why: "settings",
		next_action: "verify 5 open criteria",
		health: "normal",
		control: { owner: "system_one", state: "executing", reasonCode: "worker_in_flight" },
		active_actors: [{ id: "root", kind: "root", label: "Root orchestrator" }],
		adaptation: null,
		proof: { satisfied: 0, total: 5, failing: 0, pending: 5 },
		context: { percent: 11.6 },
		...overrides,
	};
}

function route(overrides: Partial<ForegroundRouteSnapshot> = {}): ForegroundRouteSnapshot {
	return {
		rootModel: "openai/gpt-5.6",
		activeModel: "openai/gpt-5.6",
		source: "direct",
		tier: null,
		risk: null,
		reasonCode: null,
		switched: false,
		...overrides,
	};
}

function source(overrides: {
	projection?: Partial<OperatorProjection>;
	route?: Partial<ForegroundRouteSnapshot>;
	health?: SemanticPlaneHealth;
	cost?: { currentCost: number; subagentCost: number; subagentReports: number };
}): OperatorPovSource {
	return {
		getProjection: () => projection(overrides.projection),
		getRouteSnapshot: () => route(overrides.route),
		getSemanticPlaneHealth: () => overrides.health ?? { state: "unknown" },
		getCostSummary: () => overrides.cost ?? { currentCost: 0.083, subagentCost: 0, subagentReports: 0 },
	};
}

function renderPlain(src: OperatorPovSource, width: number): string {
	return stripAnsi(new OperatorPovBarComponent(src).render(width)[0]);
}

describe("Operator POV bar", () => {
	it("F001-001/003/004..011: one `|`-separated row carrying every operator fact", () => {
		const lines = new OperatorPovBarComponent(
			source({
				route: {
					activeModel: "anthropic/claude-sonnet-4-6",
					source: "model_router_hmoe",
					tier: "medium",
					risk: "scoped-write",
					switched: true,
				},
				health: { state: "ok" },
			}),
		).render(240);
		expect(lines).toHaveLength(1);
		const row = stripAnsi(lines[0]);
		expect(row).toBe(
			" WORKING build: Simplifying settings | CONTROL S1 | NEXT verify 5 open criteria | ACTOR root | ROOT gpt-5.6 | ACTIVE claude-sonnet-4-6 | ROUTE medium via model-router/H-MoE | JEV ok | COST $0.083 | PROOF 0/5 | CTX 11.6%",
		);
	});

	it("F001-007: ROOT appears only while routing swapped the model; otherwise one MODEL slot", () => {
		const direct = renderPlain(source({}), 200);
		expect(direct).toContain("MODEL gpt-5.6");
		expect(direct).not.toContain("ROOT ");
		expect(direct).toContain("ROUTE direct");
	});

	it("F001-009: route source is truthful per authority", () => {
		expect(formatRouteValue(route())).toBe("direct");
		expect(formatRouteValue(route({ source: "manual", activeModel: "anthropic/claude-sonnet" }))).toBe(
			"manual:claude-sonnet",
		);
		expect(formatRouteValue(route({ source: "model_router", tier: "cheap", risk: "read-only" }))).toBe(
			"cheap/read-only via model-router",
		);
		expect(formatRouteValue(route({ source: "model_router", tier: "medium", risk: "scoped-write" }))).toBe(
			"medium via model-router",
		);
		expect(formatRouteValue(route({ source: "model_router_hmoe", tier: "medium" }))).toBe(
			"medium via model-router/H-MoE",
		);
		expect(formatRouteValue(route({ source: "model_router_retry", activeModel: "openai/gpt-5.6" }))).toBe(
			"escalated→gpt-5.6 via model-router",
		);
	});

	it("F001-026: no route source ever attributes the selection to Jev", () => {
		for (const src of ["direct", "manual", "model_router", "model_router_hmoe", "model_router_retry"] as const) {
			expect(formatRouteValue(route({ source: src, tier: "medium" })).toLowerCase()).not.toContain("jev");
		}
	});

	it("F001-020..025: Jev labels map from observed health and never render `?`", () => {
		expect(semanticPlaneHealthLabel({ state: "unbound" })).toBe("JEV off");
		expect(semanticPlaneHealthLabel({ state: "unknown" })).toBe("JEV ready");
		expect(semanticPlaneHealthLabel({ state: "evaluating", inFlight: 1 })).toBe("JEV eval");
		expect(semanticPlaneHealthLabel({ state: "ok" })).toBe("JEV ok");
		expect(semanticPlaneHealthLabel({ state: "degraded", lastFailure: "boom" })).toBe("JEV degraded");
		for (const state of ["unbound", "unknown", "evaluating", "ok", "degraded"] as const) {
			expect(renderPlain(source({ health: { state } }), 200)).not.toContain("?");
		}
	});

	it("F001-022: `eval` only while a real evaluation is in flight", () => {
		const recorder = new SemanticPlaneHealthRecorder();
		expect(recorder.getHealth(true).state).toBe("unknown");
		recorder.recordStart();
		expect(recorder.getHealth(true).state).toBe("evaluating");
		recorder.recordSuccess();
		expect(recorder.getHealth(true).state).toBe("ok");
		recorder.recordStart();
		recorder.recordFailure(new Error("plane down"));
		expect(recorder.getHealth(true)).toMatchObject({ state: "degraded", lastFailure: "plane down" });
		expect(recorder.getHealth(false).state).toBe("unbound");
	});

	it("F001-010: cost is the canonical session cost, with spawned cost only when present", () => {
		expect(renderPlain(source({ cost: { currentCost: 0.083, subagentCost: 0, subagentReports: 0 } }), 200)).toContain(
			"COST $0.083 |",
		);
		expect(
			renderPlain(source({ cost: { currentCost: 0.083, subagentCost: 0.021, subagentReports: 2 } }), 200),
		).toContain("COST $0.083 (sub $0.021)");
	});

	it("width priority: CTX, PROOF and a root ACTOR go first; routing, Jev and cost never do", () => {
		const segments = buildOperatorPovSegments(
			source({
				route: {
					activeModel: "anthropic/claude-sonnet-4-6",
					source: "model_router",
					tier: "medium",
					risk: "scoped-write",
					switched: true,
				},
			}),
		);
		const full = layoutOperatorPovSegments(segments, 400, { plain: true });
		expect(full).toContain("CTX 11.6%");
		const narrow = layoutOperatorPovSegments(segments, 133, { plain: true });
		expect(narrow).not.toContain("CTX");
		expect(narrow).not.toContain("PROOF");
		expect(narrow).not.toContain("ACTOR root");
		expect(narrow).toContain("ACTIVE claude-sonnet-4-6");
		expect(narrow).toContain("ROUTE medium via model-router");
		expect(narrow).toContain("JEV ready");
		expect(narrow).toContain("COST $0.083");
		const tight = layoutOperatorPovSegments(segments, 109, { plain: true });
		// ROUTE compacts and WORKING text shortens before any routing/cost truth is cut from the right.
		expect(tight).toContain("ACTIVE claude-sonnet-4-6");
		expect(tight).toContain("ROUTE medium via router");
		expect(tight).toContain("JEV ready");
		expect(tight).toContain("COST $0.083");
		expect(tight).toContain("WORKING build: S");
		expect(stripAnsi(tight).length).toBeLessThanOrEqual(109);
	});

	it("F001-030: CONTROL names who owns the next transition, independently of who executes", () => {
		expect(renderPlain(source({}), 240)).toContain("CONTROL S1");
		expect(
			renderPlain(
				source({ projection: { control: { owner: "root", state: "deciding", reasonCode: "no_objective" } } }),
				240,
			),
		).toContain("CONTROL ROOT");
		// A worker executes while the semantic plane keeps the decision: both facts show at once.
		const withWorker = renderPlain(
			source({
				projection: {
					control: { owner: "system_one", state: "observing", reasonCode: "goal_active" },
					active_actors: [{ id: "w1", kind: "worker", label: "settings" }],
				},
			}),
			240,
		);
		expect(withWorker).toContain("CONTROL S1");
		expect(withWorker).toContain("ACTOR worker settings");
	});

	it("F001-031: an owner question leads with NEEDS INPUT and carries the BLOCK text", () => {
		const row = renderPlain(
			source({
				projection: {
					phase: "blocked",
					health: "blocked",
					why: "choose onboarding behavior",
					current_action: "choose onboarding behavior",
					next_action: null,
					control: {
						owner: "user",
						state: "awaiting_user",
						reasonCode: "clarification_pending",
						clarificationRequestId: "req-1",
						blocker: "choose onboarding behavior",
					},
				},
			}),
			240,
		);
		expect(row).toContain("NEEDS INPUT choose onboarding behavior");
		expect(row).toContain("CONTROL USER");
		expect(row).toContain("BLOCK choose onboarding behavior");
		expect(row).not.toContain("BLOCKED ");
	});

	it("F001-032: CONTROL survives every width; CTX, PROOF, ROOT, root ACTOR, BLOCK and NEXT drop in order", () => {
		const segments = buildOperatorPovSegments(
			source({
				projection: {
					control: {
						owner: "user",
						state: "awaiting_user",
						reasonCode: "clarification_pending",
						blocker: "choose onboarding behavior",
					},
				},
				route: {
					activeModel: "anthropic/claude-sonnet-4-6",
					source: "model_router",
					tier: "medium",
					risk: "scoped-write",
					switched: true,
				},
			}),
		);
		const order = ["CTX", "PROOF", "ROOT ", "ACTOR root", "BLOCK", "NEXT"];
		let previous = 400;
		const dropped: string[] = [];
		for (let width = 400; width >= 60; width -= 1) {
			const row = layoutOperatorPovSegments(segments, width, { plain: true });
			for (const marker of order) {
				if (!dropped.includes(marker) && !row.includes(marker)) dropped.push(marker);
			}
			previous = width;
		}
		expect(previous).toBe(60);
		expect(dropped).toEqual(order);
		const tight = layoutOperatorPovSegments(segments, 115, { plain: true });
		expect(tight).toContain("CONTROL USER");
		expect(tight).toContain("ACTIVE claude-sonnet-4-6");
		expect(tight).toContain("JEV ready");
		expect(tight).toContain("COST $0.083");
		expect(tight).not.toContain("?");
	});

	it("FIELD-002: a cancelled evaluation leaves the plane where it was, never degraded", () => {
		const recorder = new SemanticPlaneHealthRecorder();
		recorder.recordStart();
		recorder.recordCancelled();
		expect(recorder.getHealth(true).state).toBe("unknown");
		recorder.recordStart();
		recorder.recordSuccess();
		recorder.recordStart();
		recorder.recordCancelled();
		expect(recorder.getHealth(true).state).toBe("ok");
		expect(semanticPlaneHealthLabel(recorder.getHealth(true))).toBe("JEV ok");
	});

	it("keeps a worker actor longer than a root actor", () => {
		const segments = buildOperatorPovSegments(
			source({
				projection: { active_actors: [{ id: "w1", kind: "worker", label: "Implement settings" }] },
			}),
		);
		const narrow = layoutOperatorPovSegments(segments, 143, { plain: true });
		expect(narrow).toContain("ACTOR worker Implement settings");
	});
});
