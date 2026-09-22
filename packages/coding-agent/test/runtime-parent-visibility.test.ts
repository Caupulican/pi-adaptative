import { Container, type Loader, type TUI } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ActivityLaneComponent } from "../src/modes/interactive/components/activity-lane.ts";
import {
	handleInteractiveEvent,
	type InteractiveEventHost,
} from "../src/modes/interactive/interactive-event-controller.ts";
import { RuntimeStatusController } from "../src/modes/interactive/runtime-status-controller.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("parent indicator visibility", () => {
	beforeAll(() => initTheme("dark"));
	it("keeps parent activity until the submission lease settles after agent_end", async () => {
		const lane = new ActivityLaneComponent(theme, () => {});
		const activity = { sessionId: "session", epoch: 1, busy: true };
		lane.syncForegroundActivity(activity);
		const host = {
			isInitialized: true,
			footer: { invalidate() {} },
			ui: { requestRender() {}, terminal: { setProgress() {} } },
			session: {
				getForegroundActivity: () => activity,
				getSessionWorkState: () => ({
					phase: "llm_streaming" as const,
					busy: activity.busy,
					label: "Streaming response",
					epoch: activity.epoch,
					sessionId: activity.sessionId,
				}),
				sessionManager: { getCwd: () => "/fixture" },
			},
			activityLane: lane,
			settingsManager: { getShowTerminalProgress: () => false },
			defaultEditor: {},
			workingVisible: true,
			getWorkingLoaderMessage: () => "Working...",
			clearActiveToolCalls() {},
			refreshActivityLane() {},
			isNativeReflectionEnabled: () => false,
			maybeStartAutoLearn: () => false,
			maybeStartAutonomyReview: () => false,
			checkShutdownRequested: async () => {},
		} as unknown as InteractiveEventHost;
		try {
			await handleInteractiveEvent(host, { type: "agent_start" });
			await handleInteractiveEvent(host, { type: "agent_end", messages: [], willRetry: false });
			expect(lane.getItems().find((item) => item.id === "runtime:turn")?.status).toBe("active");
			lane.syncForegroundActivity({ ...activity, busy: false });
			expect(lane.getItems().some((item) => item.id === "runtime:turn")).toBe(false);
		} finally {
			lane.dispose();
		}
	});
	it("keeps the parent clock across renderer switches and exposes background work while hidden", () => {
		let now = 1000;
		const lane = new ActivityLaneComponent(
			theme,
			() => {},
			2000,
			() => now,
		);
		const controller = new RuntimeStatusController({
			ui: { requestRender() {} } as unknown as TUI,
			statusContainer: new Container(),
			activityLane: lane,
			hasHumanAudience: true,
			isStreaming: () => true,
			isThinkingHidden: () => false,
		});
		controller.createWorkingLoader = () => ({ stop: vi.fn() }) as unknown as Loader;
		lane.start({ id: "runtime:turn", kind: "runtime", label: "Working..." });
		lane.start({ id: "background-tool:1", kind: "tool", label: "Background test" });
		const origin = lane.getItems().find((item) => item.id === "runtime:turn")?.startedAt;
		try {
			for (let i = 0; i < 3; i++) {
				now += 1000;
				controller.setWorkingVisible(false);
				expect(lane.getItems().find((item) => item.id === "runtime:turn")?.startedAt).toBe(origin);
				expect(stripAnsi(lane.render(120).join("\n"))).toContain("Background");
				controller.setWorkingVisible(true);
				controller.setWorkingIndicator({ frames: [] });
				controller.setWorkingIndicator();
				expect(lane.getItems().find((item) => item.id === "runtime:turn")?.startedAt).toBe(origin);
			}
			controller.stopWorkingLoader();
			expect(lane.getItems().find((item) => item.id === "runtime:turn")?.startedAt).toBe(origin);
		} finally {
			lane.dispose();
		}
	});
});
