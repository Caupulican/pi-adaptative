import { expect, it, vi } from "vitest";
import { WorkerLaneIsolation } from "../src/core/delegation/worker-lane-isolation.ts";
import { MERGE_RETRY_MS, MergeLandings, type MergeLanes } from "../src/core/plan/plan-merge.ts";
import type { TimerPort } from "../src/kernel/timer-port.ts";

const lanes: MergeLanes = {
	members: [
		{ nodeId: "first", member: "first", laneCwd: "/first", changedFiles: ["first.ts"] },
		{ nodeId: "second", member: "second", laneCwd: "/second", changedFiles: ["second.ts"] },
	],
};
const host = {
	lanes: () => ({ engineDeps: () => undefined, isolateByDefault: () => true, notifyParent: () => {}, warn: () => {} }),
	landGate: () => ({ gate: "off" as const }),
};

it("a new merge version clears the old retry and lands revised members again", async () => {
	const wake = vi.fn();
	let oldAlarm!: () => void;
	const timers: TimerPort = {
		now: () => 0,
		setTimeout: vi.fn((callback) => {
			oldAlarm = callback;
			return "old-alarm";
		}),
		clearTimeout: vi.fn(),
	};
	const merges = new MergeLandings({ ...host, timers: () => timers }, wake);
	const key = vi.spyOn(WorkerLaneIsolation.prototype, "laneKeyAt").mockResolvedValue("lane");
	let waiting = true;
	const land = vi
		.spyOn(WorkerLaneIsolation.prototype, "land")
		.mockImplementation(async (cwd) =>
			waiting && cwd === "/second"
				? { kind: "worklist", laneKey: "lane", item: { kind: "retry_land", holder: "other-owner" } }
				: { kind: "landed", laneKey: "lane", mainSha: "tip" },
		);
	try {
		expect(await merges.start("plan", "merge", 1, lanes, () => {})).toMatchObject({ kind: "retry" });
		merges.retry("plan", "merge", MERGE_RETRY_MS);
		expect(merges.start("plan", "merge", 1, lanes, () => {})).toBeUndefined();
		expect(land.mock.calls.map(([cwd]) => cwd)).toEqual(["/first", "/second"]);
		waiting = false;
		expect(await merges.start("plan", "merge", 2, lanes, () => {})).toMatchObject({ kind: "landed" });
		expect(timers.clearTimeout).toHaveBeenCalledWith("old-alarm");
		expect(land.mock.calls.map(([cwd]) => cwd)).toEqual(["/first", "/second", "/first", "/second"]);
		oldAlarm();
		expect(wake).not.toHaveBeenCalled();
	} finally {
		merges.dispose();
		land.mockRestore();
		key.mockRestore();
	}
});

it("turns a thrown landing operation into one hold without arming a retry", async () => {
	const timers: TimerPort = { now: () => 0, setTimeout: vi.fn(), clearTimeout: vi.fn() };
	const merges = new MergeLandings({ ...host, timers: () => timers }, vi.fn());
	const key = vi.spyOn(WorkerLaneIsolation.prototype, "laneKeyAt").mockResolvedValue("lane");
	const land = vi
		.spyOn(WorkerLaneIsolation.prototype, "land")
		.mockRejectedValue(new Error("scripted landing failure"));
	try {
		expect(await merges.start("plan", "merge", 1, lanes, () => {})).toEqual({
			kind: "hold",
			detail: "the landing of step first failed: scripted landing failure",
		});
		expect(land).toHaveBeenCalledTimes(1);
		expect(timers.setTimeout).not.toHaveBeenCalled();
	} finally {
		merges.dispose();
		land.mockRestore();
		key.mockRestore();
	}
});

it("rechecks the current plan after asynchronous lane lookup before mutating the lane", async () => {
	let completeLookup!: (key: string) => void;
	const lookup = new Promise<string>((resolve) => {
		completeLookup = resolve;
	});
	const merges = new MergeLandings(host, vi.fn());
	const key = vi.spyOn(WorkerLaneIsolation.prototype, "laneKeyAt").mockReturnValue(lookup);
	const land = vi
		.spyOn(WorkerLaneIsolation.prototype, "land")
		.mockResolvedValue({ kind: "landed", laneKey: "lane", mainSha: "tip" });
	let current = true;
	try {
		const pending = merges.start("plan", "merge", 1, lanes, () => {
			if (!current) throw new Error("plan revised");
		});
		current = false;
		completeLookup("lane");
		expect(await pending).toMatchObject({ kind: "hold", detail: expect.stringContaining("plan revised") });
		expect(land).not.toHaveBeenCalled();
	} finally {
		merges.dispose();
		land.mockRestore();
		key.mockRestore();
	}
});
