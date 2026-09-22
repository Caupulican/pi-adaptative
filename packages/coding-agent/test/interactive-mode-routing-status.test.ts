import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session-contracts.ts";
import { createHumanInputRequest } from "../src/core/human-input.ts";
import { publishHumanInputActivity } from "../src/core/human-input-activity.ts";
import { ActivityLaneComponent } from "../src/modes/interactive/components/activity-lane.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("foreground lease activity adapter", () => {
	beforeAll(() => initTheme("dark"));
	test.each([false, true])("settles preparation without agent events, custom loader=%s", (custom) => {
		let busy = true;
		const lane = new ActivityLaneComponent(theme, () => {});
		const loader = { stop: vi.fn() };
		const host = {
			session: {
				getForegroundActivity: () => ({ sessionId: "s", busy, epoch: busy ? 1 : undefined }),
				getSessionWorkState: () => ({
					phase: busy ? ("llm_streaming" as const) : ("idle" as const),
					busy,
					label: busy ? "Streaming response" : "Ready",
					sessionId: "s",
					epoch: busy ? 1 : undefined,
				}),
				sessionManager: { getCwd: () => "/fixture" },
			},
			workbench: { beginCycle: vi.fn() },
			activityLane: lane,
			workingVisible: true,
			workingIndicatorOptions: custom ? {} : undefined,
			loadingAnimation: undefined as typeof loader | undefined,
			createWorkingLoader: () => loader,
			statusContainer: { addChild: vi.fn() },
			stopWorkingLoader() {
				this.loadingAnimation?.stop();
				this.loadingAnimation = undefined;
			},
		};
		const sync = Reflect.get(InteractiveMode.prototype, "syncForegroundActivity") as (this: typeof host) => void;
		sync.call(host);
		expect(host.workbench.beginCycle).toHaveBeenCalledWith("/fixture", 1);
		expect(lane.getItems().some((item) => item.id === "runtime:turn")).toBe(true);
		if (custom) expect(host.loadingAnimation).toBe(loader);
		else expect(stripAnsi(lane.render(100).join(""))).toContain("Preparing");
		busy = false;
		sync.call(host);
		expect(lane.getItems().some((item) => item.id === "runtime:turn")).toBe(false);
		expect(host.loadingAnimation).toBeUndefined();
		if (custom) expect(loader.stop).toHaveBeenCalledOnce();
		lane.dispose();
	});

	test("ignores callbacks retained from a replaced session generation", async () => {
		const events: Array<(event: { type: "background_tools"; tasks: [] }) => Promise<void>> = [];
		const activities: Array<() => void> = [];
		const session = {
			sessionManager: {},
			subscribe(callback: (typeof events)[number]) {
				events.push(callback);
				return () => {};
			},
			subscribeForegroundActivity(callback: () => void) {
				activities.push(callback);
				return () => {};
			},
		};
		const host = {
			session,
			subscriptionGeneration: 0,
			handleEvent: vi.fn(),
			syncForegroundActivity: vi.fn(),
			unsubscribe: undefined,
			unsubscribeForegroundActivity: undefined,
		};
		const subscribe = Reflect.get(InteractiveMode.prototype, "subscribeToAgent") as (this: typeof host) => void;
		subscribe.call(host);
		subscribe.call(host);
		host.syncForegroundActivity.mockClear();
		await events[0]({ type: "background_tools", tasks: [] });
		activities[0]();
		expect(host.handleEvent).not.toHaveBeenCalled();
		expect(host.syncForegroundActivity).not.toHaveBeenCalled();
		await events[1]({ type: "background_tools", tasks: [] });
		activities[1]();
		expect(host.handleEvent).toHaveBeenCalledOnce();
		expect(host.syncForegroundActivity).toHaveBeenCalledOnce();
	});

	test("projects canonical human-input waiting and settlement without clearing independent work", () => {
		const session = { sessionManager: {}, subscribe: () => () => {}, subscribeForegroundActivity: () => () => {} };
		const lane = new ActivityLaneComponent(theme, () => {});
		lane.syncForegroundActivity({ sessionId: "s", epoch: 1, busy: true });
		lane.start({ id: "tool:q", kind: "tool", label: "Question" });
		const host = {
			session,
			activityLane: lane,
			subscriptionGeneration: 0,
			handleEvent: vi.fn(),
			syncForegroundActivity: vi.fn(),
			unsubscribe: undefined,
			unsubscribeForegroundActivity: undefined,
			unsubscribeHumanInputActivity: undefined as (() => void) | undefined,
		};
		const subscribe = Reflect.get(InteractiveMode.prototype, "subscribeToAgent") as (this: typeof host) => void;
		subscribe.call(host);
		const request = createHumanInputRequest({ source: "tool", toolCallId: "q", questions: [], acceptsImages: false });
		publishHumanInputActivity(session.sessionManager, { phase: "waiting", request });
		expect(stripAnsi(lane.render(100).join(""))).toContain("Awaiting you");
		lane.start({ id: "background-tool:build", kind: "tool", label: "Build" });
		expect(stripAnsi(lane.render(100).join(""))).toMatch(/● Working/);
		publishHumanInputActivity(session.sessionManager, { phase: "settled", request });
		expect(stripAnsi(lane.render(100).join(""))).not.toContain("Awaiting you");
		expect(lane.getItems().some((item) => item.id === "background-tool:build")).toBe(true);
		host.unsubscribeHumanInputActivity?.();
		lane.dispose();
	});
});

/**
 * routing_start/routing_end bracket the
 * gap between the prompt painting and the turn actually starting to stream (see agent-session.ts).
 * These tests drive InteractiveMode.prototype.handleEvent directly against a fake `this`, mirroring
 * the established pattern in interactive-mode-compaction.test.ts, so they don't need a full
 * terminal/theme stack.
 */
describe("InteractiveMode routing_start/routing_end status lane", () => {
	function callHandleEvent(fakeThis: unknown, event: AgentSessionEvent) {
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: AgentSessionEvent,
		) => Promise<void>;
		return handleEvent.call(fakeThis, event);
	}

	test("routing_start reports through the shared activity lane by default", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			session: { isStreaming: false },
			loadingAnimation: undefined as { stop: () => void } | undefined,
			workingVisible: true,
			workingIndicatorOptions: undefined,
			activityLane: { start: vi.fn() },
			createWorkingLoader: vi.fn(() => ({ stop: vi.fn() })),
			statusContainer: { addChild: vi.fn(), clear: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		await callHandleEvent(fakeThis, { type: "routing_start" });

		expect(fakeThis.activityLane.start).toHaveBeenCalledWith({
			id: "runtime:routing",
			kind: "runtime",
			label: "Routing",
		});
		expect(fakeThis.createWorkingLoader).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();
	});

	test("routing_start preserves an extension-provided custom working indicator", async () => {
		const loader = { stop: vi.fn() };
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			session: { isStreaming: false },
			loadingAnimation: undefined as { stop: () => void } | undefined,
			workingVisible: true,
			workingIndicatorOptions: {},
			activityLane: { start: vi.fn() },
			createWorkingLoader: vi.fn(() => loader),
			statusContainer: { addChild: vi.fn(), clear: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		await callHandleEvent(fakeThis, { type: "routing_start" });

		expect(fakeThis.statusContainer.addChild).toHaveBeenCalledWith(loader);
		expect(fakeThis.loadingAnimation).toBe(loader);
		expect(fakeThis.activityLane.start).not.toHaveBeenCalled();
	});

	test("routing_start does not start a second loader when one is already showing (no double-spinner)", async () => {
		const existingLoader = { stop: vi.fn() };
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			session: { isStreaming: false },
			loadingAnimation: existingLoader as { stop: () => void } | undefined,
			workingVisible: true,
			workingIndicatorOptions: undefined,
			activityLane: { start: vi.fn() },
			createWorkingLoader: vi.fn(() => ({ stop: vi.fn() })),
			statusContainer: { addChild: vi.fn(), clear: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		await callHandleEvent(fakeThis, { type: "routing_start" });

		expect(fakeThis.createWorkingLoader).not.toHaveBeenCalled();
		expect(fakeThis.activityLane.start).not.toHaveBeenCalled();
		expect(fakeThis.loadingAnimation).toBe(existingLoader);
	});

	test("routing_start respects workingVisible=false (user has hidden the working indicator)", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			session: { isStreaming: false },
			loadingAnimation: undefined as { stop: () => void } | undefined,
			workingVisible: false,
			workingIndicatorOptions: undefined,
			activityLane: { start: vi.fn() },
			createWorkingLoader: vi.fn(() => ({ stop: vi.fn() })),
			statusContainer: { addChild: vi.fn(), clear: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		await callHandleEvent(fakeThis, { type: "routing_start" });

		expect(fakeThis.createWorkingLoader).not.toHaveBeenCalled();
		expect(fakeThis.activityLane.start).not.toHaveBeenCalled();
		expect(fakeThis.loadingAnimation).toBeUndefined();
	});

	test("routing_end removes the routing lane without blanking an already-streaming turn", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			session: { isStreaming: true },
			loadingAnimation: { stop: vi.fn() },
			activityLane: { remove: vi.fn() },
			stopWorkingLoader: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await callHandleEvent(fakeThis, { type: "routing_end" });

		expect(fakeThis.activityLane.remove).toHaveBeenCalledWith("runtime:routing");
		expect(fakeThis.stopWorkingLoader).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();
	});

	test("routing_end stops a routing-only loader only after the foreground lease settles", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			session: {
				isStreaming: false,
				getForegroundActivity: () => ({ busy: false }),
				getSessionWorkState: () => ({ phase: "idle" as const, busy: false, label: "Ready", sessionId: "s" }),
			},
			loadingAnimation: { stop: vi.fn() },
			activityLane: { remove: vi.fn() },
			stopWorkingLoader: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await callHandleEvent(fakeThis, { type: "routing_end" });

		expect(fakeThis.activityLane.remove).toHaveBeenCalledWith("runtime:routing");
		expect(fakeThis.stopWorkingLoader).toHaveBeenCalledTimes(1);
	});

	test("keeps a busy custom loader through routing, retry, admission, compaction and intermediate agent_end", async () => {
		vi.useFakeTimers();
		const lane = new ActivityLaneComponent(theme, () => {});
		lane.syncForegroundActivity({ sessionId: "s", epoch: 1, busy: true });
		lane.setParentVisible(false);
		const loader = { stop: vi.fn(), setMessage: vi.fn() };
		const host = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			session: {
				isStreaming: false,
				getForegroundActivity: () => ({ sessionId: "s", epoch: 1, busy: true }),
				getSessionWorkState: () => ({
					phase: "llm_streaming" as const,
					busy: true,
					label: "Streaming response",
					sessionId: "s",
					epoch: 1,
				}),
			},
			loadingAnimation: loader as typeof loader | undefined,
			workingVisible: true,
			workingIndicatorOptions: {},
			activityLane: lane,
			settingsManager: { getShowTerminalProgress: () => false },
			defaultEditor: { onEscape: () => {} },
			statusContainer: { clear: vi.fn() },
			stopWorkingLoader() {
				this.loadingAnimation?.stop();
				this.loadingAnimation = undefined;
			},
			getWorkingLoaderMessage: () => "Working...",
			refreshActivityLane: () => {},
			isNativeReflectionEnabled: () => false,
			maybeStartAutoLearn: () => false,
			maybeStartAutonomyReview: () => false,
			clearActiveToolCalls: () => {},
			checkShutdownRequested: async () => {},
			flushCompactionQueue: async () => {},
			ui: { requestRender: vi.fn() },
		};
		await callHandleEvent(host, { type: "routing_end" });
		expect(host.loadingAnimation).toBe(loader);
		await callHandleEvent(host, { type: "agent_end", messages: [], willRetry: true });
		expect(host.loadingAnimation).toBe(loader);
		await callHandleEvent(host, {
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 5_000,
			errorMessage: "test",
		});
		expect(loader.setMessage).toHaveBeenLastCalledWith(expect.stringContaining("Retry 1/3"));
		await callHandleEvent(host, { type: "auto_retry_end", success: true, attempt: 1 });
		await callHandleEvent(host, {
			type: "provider_admission_wait",
			lane: "foreground",
			provider: "test",
			phase: "start",
			reason: "capacity",
		});
		expect(loader.setMessage).toHaveBeenLastCalledWith(expect.stringContaining("waiting"));
		await callHandleEvent(host, {
			type: "provider_admission_wait",
			lane: "foreground",
			provider: "test",
			phase: "end",
			reason: "capacity",
			waitedMs: 1,
		});
		await callHandleEvent(host, { type: "compaction_start", reason: "overflow" });
		expect(host.loadingAnimation).toBe(loader);
		expect(loader.setMessage).toHaveBeenLastCalledWith(expect.stringContaining("compacting"));
		await callHandleEvent(host, {
			type: "compaction_end",
			reason: "overflow",
			skipReason: "test",
			result: undefined,
			aborted: false,
			willRetry: true,
		});
		expect(host.loadingAnimation).toBe(loader);
		expect(loader.setMessage).toHaveBeenLastCalledWith("Working...");
		expect(loader.stop).not.toHaveBeenCalled();
		lane.dispose();
		vi.useRealTimers();
	});

	test("shows standalone manual compaction with a custom loader and settles that phase", async () => {
		const lane = new ActivityLaneComponent(theme, () => {});
		lane.setParentVisible(false);
		const loader = { stop: vi.fn(), setMessage: vi.fn() };
		const host = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			session: {
				getForegroundActivity: () => ({ busy: false }),
				getSessionWorkState: () => ({ phase: "idle" as const, busy: false, label: "Ready", sessionId: "s" }),
			},
			loadingAnimation: undefined as typeof loader | undefined,
			workingVisible: true,
			workingIndicatorOptions: {},
			activityLane: lane,
			settingsManager: { getShowTerminalProgress: () => false },
			defaultEditor: { onEscape: () => {} },
			statusContainer: { addChild: vi.fn(), clear: vi.fn() },
			createWorkingLoader: () => loader,
			stopWorkingLoader() {
				this.loadingAnimation?.stop();
				this.loadingAnimation = undefined;
			},
			getWorkingLoaderMessage: () => "Working...",
			flushCompactionQueue: async () => {},
			ui: { requestRender: vi.fn() },
		};
		await callHandleEvent(host, { type: "compaction_start", reason: "manual" });
		expect(host.loadingAnimation).toBe(loader);
		expect(loader.setMessage).toHaveBeenCalledWith(expect.stringContaining("Compacting context"));
		await callHandleEvent(host, {
			type: "compaction_end",
			reason: "manual",
			skipReason: "test",
			result: undefined,
			aborted: false,
			willRetry: false,
		});
		expect(host.loadingAnimation).toBeUndefined();
		expect(loader.stop).toHaveBeenCalledOnce();
		lane.dispose();
	});

	test("scopes admission waits by provider lane without replacing unrelated foreground work", async () => {
		const lane = new ActivityLaneComponent(theme, () => {});
		lane.syncForegroundActivity({ sessionId: "s", epoch: 1, busy: true });
		lane.update("runtime:turn", "Writing");
		const host = {
			isInitialized: true,
			footer: { invalidate: () => {} },
			activityLane: lane,
			ui: { requestRender: () => {} },
		};
		await callHandleEvent(host, {
			type: "provider_admission_wait",
			lane: "background",
			provider: "test",
			phase: "start",
			reason: "capacity",
		});
		expect(stripAnsi(lane.render(120).join(""))).toMatch(/● Writing/);
		await callHandleEvent(host, {
			type: "provider_admission_wait",
			lane: "foreground",
			provider: "test",
			phase: "start",
			reason: "capacity",
		});
		expect(lane.getItems().filter((item) => item.id.startsWith("runtime:admission:")).length).toBe(2);
		await callHandleEvent(host, {
			type: "provider_admission_wait",
			lane: "background",
			provider: "test",
			phase: "end",
			reason: "capacity",
			waitedMs: 1,
		});
		expect(stripAnsi(lane.render(120).join(""))).toContain("foreground request");
		lane.dispose();
	});
});
