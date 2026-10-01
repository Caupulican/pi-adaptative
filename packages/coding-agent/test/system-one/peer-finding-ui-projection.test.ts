import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session-contracts.ts";
import type { ForegroundRouteSnapshot } from "../../src/core/model-router-controller.ts";
import { DecisionStageLog } from "../../src/core/operator-projection/decision-stage-log.ts";
import type { OperatorProjection } from "../../src/core/operator-projection/types.ts";
import type { SemanticVerificationObligationView } from "../../src/core/system-one/verification-obligations.ts";
import {
	type AgentsOverlaySnapshot,
	buildWorkPanelModel,
} from "../../src/modes/interactive/components/agents-overlay.ts";
import { buildDecisionGraphModel } from "../../src/modes/interactive/components/decision-graph-model.ts";
import {
	renderDecisionDiagram,
	renderDecisionList,
} from "../../src/modes/interactive/components/decision-graph-render.ts";
import {
	buildOperatorPovSegments,
	OperatorPovBarComponent,
	type OperatorPovSource,
} from "../../src/modes/interactive/components/operator-pov-bar.ts";
import {
	handleInteractiveEvent,
	type InteractiveEventHost,
} from "../../src/modes/interactive/interactive-event-controller.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { buildWorkbenchSections } from "../../src/modes/interactive/workbench-controller.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const NOW = Date.parse("2026-09-30T21:40:00.000Z");

function obligation(id: string, reason = `Finding ${id} needs a direct recheck.`): SemanticVerificationObligationView {
	return {
		id,
		source: "peer_review",
		reason,
		receiverId: "root-lane",
		candidateKind: "repository",
		candidateId: "candidate-current",
		scope: "/work/GrimDex",
		sequence: 1,
		status: "active",
	};
}

function graphInput(peerFindings: readonly SemanticVerificationObligationView[]) {
	const projection: OperatorProjection = {
		schema_version: "1.0",
		objective_id: "goal-grimdex",
		has_goal: true,
		title: "Continue GrimDex planning",
		phase: "plan",
		phase_index: 1,
		phase_count: 6,
		current_action: "Reviewing current evidence",
		why: "The work remains in planning",
		next_action: null,
		health: "normal",
		control: { owner: "system_one", state: "observing", reasonCode: "goal_active" },
		active_actors: [{ id: "root", kind: "root", label: "Root" }],
		adaptation: null,
		proof: { satisfied: 0, total: 0, failing: 0, pending: 0 },
		context: null,
	};
	const stages = new DecisionStageLog();
	stages.observe(projection, NOW);
	return {
		projection,
		stageLog: stages.view(NOW),
		health: {
			state: "unknown" as const,
			unresolvedDoubts: [
				{
					programId: "system-one:claim_delivery",
					question: "evidence_sufficient",
					text: "evidence_sufficient: unclear",
					label: "Claim delivery",
					evaluationId: "evaluation-1",
					at: NOW,
				},
			],
		},
		evaluations: [],
		route: {
			rootModel: "openai/gpt-5.6",
			activeModel: "openai/gpt-5.6",
			source: "direct" as const,
			tier: null,
			risk: null,
			reasonCode: null,
			switched: false,
		},
		lanes: [],
		plan: [],
		checks: [{ text: "unit tests passed", status: "pending" as const }],
		peerFindings: peerFindings.map(({ id, reason, scope }) => ({ id, reason, scope })),
		receipts: { actions: 0, fileEffects: 0, failures: 0 },
		backgroundTools: [],
		nowMs: NOW,
	};
}

function povSource(getPeerFindingCount: () => number): OperatorPovSource {
	return {
		getProjection: (): OperatorProjection => ({
			schema_version: "1.0",
			objective_id: "goal-grimdex",
			has_goal: true,
			title: "Continue GrimDex planning",
			phase: "plan",
			phase_index: 1,
			phase_count: 6,
			current_action: "Reviewing evidence",
			why: "Planning",
			next_action: null,
			health: "normal",
			control: { owner: "system_one", state: "observing", reasonCode: "goal_active" },
			active_actors: [{ id: "root", kind: "root", label: "Root" }],
			adaptation: null,
			proof: { satisfied: 0, total: 0, failing: 0, pending: 0 },
			context: null,
		}),
		getRouteSnapshot: (): ForegroundRouteSnapshot => ({
			rootModel: "openai/gpt-5.6",
			activeModel: "openai/gpt-5.6",
			source: "direct",
			tier: null,
			risk: null,
			reasonCode: null,
			switched: false,
		}),
		getSemanticPlaneHealth: () => ({ state: "unknown" }),
		getCostSummary: () => ({ currentCost: 0, subagentCost: 0, subagentReports: 0 }),
		getPeerFindingCount,
	};
}

describe("mandatory peer finding UI projection", () => {
	beforeAll(() => initTheme("dark"));

	it("projects a live bounded peer-finding summary and inspector section", () => {
		let peerFindings: SemanticVerificationObligationView[] = [
			obligation("peer-1", "Recheck the parser boundary."),
			obligation("peer-2", "Verify the fallback path."),
			obligation("peer-3", "Confirm the retry limit."),
			obligation("peer-4", "Inspect the cancellation case."),
		];
		const project = () =>
			buildWorkPanelModel({ laneRecords: [], items: [], peerFindings } satisfies AgentsOverlaySnapshot, NOW);

		const populated = project();
		expect(populated.summary).toContain("4 peer findings");
		expect(populated.rows?.filter((row) => row.section === "Peer findings")).toEqual([
			expect.objectContaining({ status: "blocked", label: "Recheck the parser boundary.", meta: ["peer-1"] }),
			expect.objectContaining({ status: "blocked", label: "Verify the fallback path.", meta: ["peer-2"] }),
			expect.objectContaining({ status: "blocked", label: "Confirm the retry limit.", meta: ["peer-3"] }),
			expect.objectContaining({ status: "info", label: "+1 more", meta: ["4 total"] }),
		]);
		expect(populated.notices).toEqual([]);

		peerFindings = [obligation("peer-1", "Recheck the parser boundary.")];
		const one = project();
		expect(one.summary).toContain("1 peer finding");
		expect(one.rows?.filter((row) => row.section === "Peer findings")).toHaveLength(1);

		peerFindings = [];
		const empty = project();
		expect(empty.summary).toContain("0 peer findings");
		expect(empty.rows?.some((row) => row.section === "Peer findings")).toBe(false);
	});

	it("keeps peer findings distinct from deterministic checks and advisory doubts in both graph views", () => {
		const findings = [obligation("peer-1"), obligation("peer-2")];
		const model = buildDecisionGraphModel(graphInput(findings));
		const list = stripAnsi(renderDecisionList(model, 120).rows.join("\n"));
		const diagram = stripAnsi(renderDecisionDiagram(model, 120).rows.join("\n"));

		expect(model.checks).toHaveLength(1);
		expect(model.peerFindings).toHaveLength(2);
		expect(model.unresolvedDoubtCount).toBe(1);
		expect(list).toContain("CHECKS");
		expect(list).toContain("PEER FINDINGS");
		expect(list).toContain("2 mandatory peer findings · 1 doubt");
		expect(diagram).toContain("CHECKS");
		expect(diagram).toContain("PEER FINDINGS 2 active");
		expect(diagram).toContain("not closed · 1 checks · 2 peer findings · 1 unsure");

		const resolved = buildDecisionGraphModel(graphInput([findings[0]!]));
		expect(resolved.peerFindings).toHaveLength(1);
		expect(stripAnsi(renderDecisionList(resolved, 120).rows.join("\n"))).toContain(
			"1 mandatory peer finding · 1 doubt",
		);
		const allResolved = buildDecisionGraphModel(graphInput([]));
		expect(allResolved.peerFindings).toHaveLength(0);
		expect(stripAnsi(renderDecisionDiagram(allResolved, 120).rows.join("\n"))).not.toContain("PEER FINDINGS");
	});

	it("shows a live peer count in the POV bar without merging it into the System One doubt count", () => {
		let active = 2;
		const source = povSource(() => active);
		const bar = new OperatorPovBarComponent(source);
		const segment = () => buildOperatorPovSegments(source).find((item) => item.id === "peer-findings");
		expect(segment()).toMatchObject({ label: "PEER", value: "2 active" });
		expect(stripAnsi(bar.render(240)[0]!)).toContain("PEER 2 active");
		active = 1;
		expect(stripAnsi(bar.render(240)[0]!)).toContain("PEER 1 active");
		active = 0;
		expect(stripAnsi(bar.render(240)[0]!)).toContain("PEER 0 active");
	});

	it("keeps mandatory findings in their own Workbench section as counts change", () => {
		const deterministic = [{ id: "test-failure", command: "vitest run test/failing.test.ts" }];
		const sections = (peerFindings: readonly SemanticVerificationObligationView[]) =>
			buildWorkbenchSections(
				{
					laneRecords: [],
					items: [],
					verification: deterministic,
					peerFindings,
				} satisfies AgentsOverlaySnapshot,
				NOW,
			);
		const both = sections([obligation("peer-1"), obligation("peer-2")]);
		expect(both.find((section) => section.title === "Checks")?.meta).toBe("1 failing");
		expect(both.find((section) => section.title === "Peer findings")?.meta).toBe("2 active");
		const oneLeft = sections([obligation("peer-1")]);
		expect(oneLeft.find((section) => section.title === "Peer findings")?.meta).toBe("1 active");
		const noneLeft = sections([]);
		expect(noneLeft.some((section) => section.title === "Peer findings")).toBe(false);
		expect(noneLeft.find((section) => section.title === "Checks")?.meta).toBe("1 failing");
	});

	it("refreshes the Workbench projection after peer tool resolution without adding a chat line", async () => {
		const refreshActivityLane = vi.fn();
		const addMessageToChat = vi.fn();
		const host = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
			refreshActivityLane,
			addMessageToChat,
			updateTerminalTitle: vi.fn(),
			activeToolCalls: { getActive: () => undefined },
		} as unknown as InteractiveEventHost;
		const peerResolve: AgentSessionEvent = {
			type: "tool_execution_end",
			toolName: "peer",
			toolCallId: "peer-resolve",
			isError: false,
			result: { content: [], details: { action: "resolve" } },
		};
		await handleInteractiveEvent(host, peerResolve);
		expect(refreshActivityLane).toHaveBeenCalledOnce();
		expect(addMessageToChat).not.toHaveBeenCalled();

		refreshActivityLane.mockClear();
		await handleInteractiveEvent(host, { ...peerResolve, toolName: "read" });
		expect(refreshActivityLane).not.toHaveBeenCalled();

		await handleInteractiveEvent(host, { type: "session_info_changed", name: undefined });
		expect(refreshActivityLane).toHaveBeenCalledOnce();
		expect(addMessageToChat).not.toHaveBeenCalled();
	});
});
