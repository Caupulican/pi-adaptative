import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it } from "vitest";
import { type LaneRecord, LaneTracker } from "../src/core/autonomy/lane-tracker.ts";
import { BackgroundLaneController, type BackgroundLaneControllerDeps } from "../src/core/background-lane-controller.ts";
import { FlowTrace } from "../src/core/operator-projection/flow-trace.ts";
import { resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";
import { createTestManagedLaneDispatch } from "./managed-lane-fixture.ts";

const dirs: string[] = [];

function controllerAt(): BackgroundLaneController {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-lane-records-"));
	dirs.push(agentDir);
	const entries: SessionEntry[] = [];
	const sessionManager = {
		getEntries: () => [...entries],
		appendCustomEntry: (customType: string, data: unknown) => {
			const entry = {
				type: "custom",
				customType,
				data,
				id: `entry-${entries.length + 1}`,
			} as unknown as SessionEntry;
			entries.push(entry);
			return entry.id as string;
		},
	} as unknown as SessionManager;
	return new BackgroundLaneController({
		isDisposed: () => false,
		getSessionId: () => `lane-records:${agentDir}`,
		getCwd: () => "/repo",
		getAgentDir: () => agentDir,
		getSessionManager: () => sessionManager,
		getGoalStateSnapshot: () => undefined,
		getCapabilityEnvelope: () => undefined,
		saveWorkerClaimSnapshot: () => "worker-claim-entry",
		emit: () => {},
		notifyWorkerTerminalHandoff: () => {},
	} as unknown as BackgroundLaneControllerDeps);
}

const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("lane record changes are pushed to subscribers", () => {
	afterEach(() => {
		resetInFlightWorkRegistryForTests();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("tells a subscriber about a lane's dispatch and its terminal without anyone reading the lanes", async () => {
		const controller = controllerAt();
		const seen: LaneRecord["status"][][] = [];
		const trace = new FlowTrace();
		controller.subscribeLaneRecords((records) => {
			seen.push(records.map((record) => record.status));
			trace.observeLanes(records);
		});
		controller.recordManagedLane({
			laneId: "tmux:job:agent",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		await settle();
		controller.recordManagedLane({ laneId: "tmux:job:agent", phase: "terminal", status: "succeeded" });
		await settle();
		expect(seen.at(-1)).toEqual(["succeeded"]);
		expect(trace.snapshot().filter((event) => event.kind === "report")).toHaveLength(1);
	});

	it("stops telling a subscriber once it unsubscribes (control)", async () => {
		const controller = controllerAt();
		let calls = 0;
		const unsubscribe = controller.subscribeLaneRecords(() => calls++);
		unsubscribe();
		controller.recordManagedLane({
			laneId: "tmux:job:agent",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch(),
		});
		await settle();
		expect(calls).toBe(0);
	});
});

describe("lane tracker change notification", () => {
	it("notifies on every lane transition and not on a refused one", () => {
		let changes = 0;
		const tracker = new LaneTracker({ onChange: () => changes++ });
		const lane = tracker.enqueue({ type: "research", label: "look" });
		tracker.markRunning(lane.laneId);
		tracker.complete(lane.laneId, { status: "succeeded" });
		expect(changes).toBe(3);
		tracker.markRunning(lane.laneId);
		tracker.complete(lane.laneId, { status: "failed" });
		expect(changes).toBe(3);
	});

	it("records when a lane was queued, apart from when it started running", () => {
		let now = "2026-09-24T10:00:00.000Z";
		const tracker = new LaneTracker({ now: () => now });
		const lane = tracker.enqueue({ type: "research" });
		expect(lane).toMatchObject({ queuedAt: "2026-09-24T10:00:00.000Z" });
		expect(lane.startedAt).toBeUndefined();
		now = "2026-09-24T10:00:30.000Z";
		expect(tracker.markRunning(lane.laneId)).toMatchObject({
			queuedAt: "2026-09-24T10:00:00.000Z",
			startedAt: "2026-09-24T10:00:30.000Z",
		});
	});
});
