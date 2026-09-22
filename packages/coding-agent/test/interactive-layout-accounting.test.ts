import { Container } from "@caupulican/pi-tui";
import { beforeAll, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { DecisionStageLog } from "../src/core/operator-projection/decision-stage-log.ts";
import { ActiveToolCallRegistry } from "../src/modes/interactive/components/active-tool-call-registry.ts";
import { ActivityLaneComponent } from "../src/modes/interactive/components/activity-lane.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { type InteractiveLayoutHost, mountInteractiveLayout } from "../src/modes/interactive/interactive-layout.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import type { WorkbenchController } from "../src/modes/interactive/workbench-controller.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

it("counts one invocation once while foreground and background handoff observations overlap", () => {
	const lane = new ActivityLaneComponent(theme, () => {});
	const settings = {
		getWorkbenchSettings: () => ({ rows: "half", collapsed: false, inspector: "shown", previews: 24, mouse: "off" }),
	};
	const registry = new ActiveToolCallRegistry(() => host.workbench?.refreshExecution());
	const host = {
		hasHumanAudience: true,
		ui: { terminal: { rows: 30 }, requestRender() {}, addChild() {}, addInputListener: () => () => {} },
		session: {
			settingsManager: settings,
			sessionManager: { getSessionName: () => "fixture", getCwd: () => "/fixture" },
			// The layout reads the session's live projection; the fixture supplies a minimal one.
			operatorProjection: {
				getProjection: () => ({
					schema_version: "1.0",
					objective_id: "fixture",
					title: "fixture",
					phase: "understand",
					phase_index: 1,
					phase_count: 6,
					current_action: "Ready for operator instructions",
					why: "Standing by",
					next_action: null,
					health: "normal",
					control: { owner: "root", state: "deciding", reasonCode: "no_objective" },
					active_actors: [{ id: "root", kind: "root", label: "Root orchestrator" }],
					adaptation: null,
					proof: { satisfied: 0, total: 0, failing: 0, pending: 0 },
					context: null,
				}),
				subscribe: () => () => {},
				onStageChange: () => () => {},
				getVisibleEvents: () => [],
				getStageLog: () => new DecisionStageLog().view(0),
			},
			getTaskStepsStateSnapshot: () => undefined,
			getGoalStateSnapshot: () => undefined,
			getVerificationObligations: () => [],
			getSemanticEvaluations: () => [],
			onSemanticEvaluation: () => () => {},
			getLaneRecords: () => [],
			getForegroundRouteSnapshot: () => ({
				rootModel: "fixture/model",
				activeModel: "fixture/model",
				source: "direct",
				tier: null,
				risk: null,
				reasonCode: null,
				switched: false,
			}),
			getSemanticPlaneHealth: () => ({ state: "unbound" }),
			getSessionWorkState: () => ({
				phase: "idle" as const,
				busy: false,
				label: "Ready",
				sessionId: "fixture",
			}),
			getCostSummary: () => ({ currentCost: 0, subagentCost: 0, subagentReports: 0 }),
		},
		headerContainer: new Container(),
		chatContainer: new Container(),
		editorContainer: new Container(),
		pendingMessagesContainer: new Container(),
		statusContainer: new Container(),
		widgetContainerAbove: new Container(),
		widgetContainerBelow: new Container(),
		footer: { setCompact() {}, setOperatorFooter() {}, render: () => [], invalidate() {} },
		footerDataProvider: { getGitBranch: () => null },
		activityLane: lane,
		keybindings: new KeybindingsManager(),
		settingsManager: settings,
		extensionUiHost: { renderWidgets() {} },
		activeToolCalls: registry,
		workbench: undefined as WorkbenchController | undefined,
	};
	mountInteractiveLayout(host as unknown as InteractiveLayoutHost);
	const workbench = host.workbench!;
	try {
		registry.register("call", {} as ToolExecutionComponent);
		expect(stripAnsi(workbench.view.render(120).join("\n"))).toContain("In flight: 1");
		lane.reconcileByPrefix("background-tool:", [
			{ id: "background-tool:one", toolCallId: "call", kind: "tool", label: "Bash" },
		]);
		workbench.refreshExecution();
		let rendered = stripAnsi(workbench.view.render(120).join("\n"));
		expect(rendered).toContain("Background: 1");
		expect(rendered).not.toContain("In flight:");
		registry.register("other", {} as ToolExecutionComponent);
		registry.finish("call");
		rendered = stripAnsi(workbench.view.render(120).join("\n"));
		expect(rendered).toContain("Background: 1");
		expect(rendered).toContain("In flight: 1");
	} finally {
		workbench.dispose();
		lane.dispose();
	}
});
