import { Container } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { DecisionStageLog } from "../src/core/operator-projection/decision-stage-log.ts";
import { ActiveToolCallRegistry } from "../src/modes/interactive/components/active-tool-call-registry.ts";
import { ActivityLaneComponent } from "../src/modes/interactive/components/activity-lane.ts";
import {
	type InteractiveLayoutHost,
	mountInteractiveLayout,
	subscribeInteractiveLayout,
} from "../src/modes/interactive/interactive-layout.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import type { WorkbenchController } from "../src/modes/interactive/workbench-controller.ts";

/** A fake session that counts what the layout subscribes to and unsubscribes from. */
function fakeSession(name: string) {
	const counts = { subscribed: 0, unsubscribed: 0 };
	const subscribe = () => {
		counts.subscribed++;
		return () => {
			counts.unsubscribed++;
		};
	};
	const session = {
		sessionManager: { getSessionName: () => name, getCwd: () => "/fixture", getSessionId: () => name },
		operatorProjection: {
			getProjection: () => ({
				schema_version: "1.0",
				objective_id: name,
				title: name,
				phase: "understand",
				phase_index: 1,
				phase_count: 6,
				current_action: "Ready",
				why: "Standing by",
				next_action: null,
				health: "normal",
				control: { owner: "root", state: "deciding", reasonCode: "no_objective" },
				active_actors: [{ id: "root", kind: "root", label: "Root orchestrator" }],
				adaptation: null,
				proof: { satisfied: 0, total: 0, failing: 0, pending: 0 },
				context: null,
			}),
			subscribe,
			onStageChange: subscribe,
			getStageLog: () => new DecisionStageLog().view(0),
			getVisibleEvents: () => [],
		},
		onSemanticEvaluation: subscribe,
		getTaskStepsStateSnapshot: () => undefined,
		getGoalStateSnapshot: () => undefined,
		getVerificationObligations: () => [],
		getSemanticEvaluations: () => [],
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
		getCostSummary: () => ({ currentCost: 0, subagentCost: 0, subagentReports: 0 }),
		peekPathAliasTable: () => undefined,
	};
	return { session, counts };
}

describe("interactive layout session listeners", () => {
	beforeAll(() => initTheme("dark"));

	it("rebinds the four listeners to the new session and disposes the old ones; stop disposes everything", () => {
		const first = fakeSession("first");
		const second = fakeSession("second");
		const settings = {
			getWorkbenchSettings: () => ({
				mouse: "off" as const,
				rows: "half" as const,
				collapsed: false,
				inspector: "shown" as const,
				executionMaximized: false,
				inspectorFraction: 0.3,
				layout: "stacked" as const,
				conversationFraction: 0.5,
				previews: 24,
				graph: "shown" as const,
				graphFraction: 0.32,
				graphView: "diagram" as const,
			}),
			setWorkbenchSetting() {},
			setWorkbenchSettings() {},
		};
		const host = {
			hasHumanAudience: true,
			ui: {
				addChild() {},
				requestRender() {},
				hasOverlay: () => false,
				addInputListener: () => () => {},
				terminal: { rows: 40 },
			},
			session: first.session,
			headerContainer: new Container(),
			chatContainer: new Container(),
			editorContainer: new Container(),
			pendingMessagesContainer: new Container(),
			statusContainer: new Container(),
			widgetContainerAbove: new Container(),
			widgetContainerBelow: new Container(),
			footer: { setCompact() {}, setOperatorFooter() {}, render: () => [], invalidate() {} },
			footerDataProvider: { getGitBranch: () => null },
			activityLane: new ActivityLaneComponent(theme, () => {}),
			keybindings: new KeybindingsManager(),
			settingsManager: settings,
			extensionUiHost: { renderWidgets() {} },
			activeToolCalls: new ActiveToolCallRegistry(() => {}),
			workbench: undefined as WorkbenchController | undefined,
		};
		mountInteractiveLayout(host as unknown as InteractiveLayoutHost);
		expect(first.counts).toEqual({ subscribed: 3, unsubscribed: 0 });
		expect(host.workbench).toBeDefined();
		// The session is swapped (resume / new session): the mode rebinds the layout to it.
		host.session = second.session;
		subscribeInteractiveLayout(host as unknown as InteractiveLayoutHost);
		expect(first.counts).toEqual({ subscribed: 3, unsubscribed: 3 });
		expect(second.counts).toEqual({ subscribed: 3, unsubscribed: 0 });
		const typed = host as unknown as InteractiveLayoutHost;
		typed.disposeOperatorProjection?.();
		expect(second.counts).toEqual({ subscribed: 3, unsubscribed: 3 });
		expect(typed.disposeOperatorProjection).toBeUndefined();
	});
});
