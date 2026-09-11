import { describe, expect, it } from "vitest";
import {
	DEFAULT_SHELL_LANE_IDLE_RETIRE_MS,
	ShellLanePool,
	type ShellLanePoolOptions,
} from "../src/core/tools/shell-lane-pool.ts";

interface FakeLane {
	index: number;
}

interface FakeTimer {
	dueAt: number;
	handler: () => void;
}

function createHarness(overrides: Partial<ShellLanePoolOptions<FakeLane>> = {}) {
	const created: number[] = [];
	const disposed: number[] = [];
	const timers = new Map<number, FakeTimer>();
	let nextTimerId = 1;
	let currentTime = 0;

	const pool = new ShellLanePool<FakeLane>({
		createLane: (index) => {
			created.push(index);
			return { index };
		},
		disposeLane: (lane) => {
			disposed.push(lane.index);
		},
		now: () => currentTime,
		setTimeout: (handler, ms) => {
			const id = nextTimerId++;
			timers.set(id, { dueAt: currentTime + ms, handler });
			return id;
		},
		clearTimeout: (handle) => {
			timers.delete(handle as number);
		},
		...overrides,
	});

	const advance = (ms: number): void => {
		currentTime += ms;
		for (const [id, timer] of [...timers]) {
			if (timer.dueAt > currentTime) continue;
			timers.delete(id);
			timer.handler();
		}
	};

	return { pool, created, disposed, advance, armedTimers: () => timers.size };
}

describe("ShellLanePool", () => {
	it("creates the warm minimum on the first acquire and reuses those lanes", async () => {
		const { pool, created } = createHarness();

		const first = await pool.acquire();
		expect(created).toEqual([0, 1, 2]);
		expect(pool.stats()).toEqual({ lanes: 3, idle: 2, busy: 1, waiting: 0 });

		const second = await pool.acquire();
		const third = await pool.acquire();
		expect(created).toEqual([0, 1, 2]);
		expect([first.index, second.index, third.index]).toEqual([0, 1, 2]);
		expect(pool.stats()).toEqual({ lanes: 3, idle: 0, busy: 3, waiting: 0 });

		pool.release(second);
		expect(await pool.acquire()).toBe(second);
		expect(created).toEqual([0, 1, 2]);

		await pool.dispose();
	});

	it("grows past the warm minimum when every lane is busy", async () => {
		const { pool, created } = createHarness();

		const lanes = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()]);
		expect(created).toEqual([0, 1, 2, 3]);
		expect(lanes.map((lane) => lane.index)).toEqual([0, 1, 2, 3]);
		expect(pool.stats()).toEqual({ lanes: 4, idle: 0, busy: 4, waiting: 0 });

		await pool.dispose();
	});

	it("waits at the cap and hands the next waiter the first released lane", async () => {
		const { pool, created } = createHarness({ maxLanes: 4 });

		const lanes = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()]);
		let waitedLane: FakeLane | undefined;
		const waiting = pool.acquire().then((lane) => {
			waitedLane = lane;
			return lane;
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(waitedLane).toBeUndefined();
		expect(pool.stats()).toEqual({ lanes: 4, idle: 0, busy: 4, waiting: 1 });

		pool.release(lanes[2]);
		expect(await waiting).toBe(lanes[2]);
		expect(created).toEqual([0, 1, 2, 3]);
		expect(pool.stats()).toEqual({ lanes: 4, idle: 0, busy: 4, waiting: 0 });

		await pool.dispose();
	});

	it("rejects an aborted wait with the signal reason without consuming a lane", async () => {
		const { pool } = createHarness({ maxLanes: 3 });

		const lanes = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
		const controller = new AbortController();
		const waiting = pool.acquire(controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(pool.stats().waiting).toBe(1);

		controller.abort("operator stopped the turn");
		await expect(waiting).rejects.toBe("operator stopped the turn");
		expect(pool.stats()).toEqual({ lanes: 3, idle: 0, busy: 3, waiting: 0 });

		// The abandoned wait took no lane with it: the next release goes to a fresh acquire.
		pool.release(lanes[0]);
		expect(await pool.acquire()).toBe(lanes[0]);

		await pool.dispose();
	});

	it("retires a lane beyond the warm minimum after it stays idle, keeping the warm lanes", async () => {
		const { pool, created, disposed, advance, armedTimers } = createHarness({ idleRetireMs: 1_000 });

		const lanes = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()]);
		for (const lane of lanes) pool.release(lane);
		// Only the lane beyond the warm minimum arms a retire timer.
		expect(armedTimers()).toBe(1);

		advance(999);
		expect(disposed).toEqual([]);
		advance(1);
		expect(disposed).toEqual([3]);
		expect(pool.stats()).toEqual({ lanes: 3, idle: 3, busy: 0, waiting: 0 });

		// The pool grows again on demand, and the retired index is not reused.
		const reacquired = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()]);
		expect(created).toEqual([0, 1, 2, 3, 4]);
		expect(reacquired[3].index).toBe(4);

		await pool.dispose();
	});

	it("keeps an extra lane that is taken again before its idle deadline", async () => {
		const { pool, disposed, advance } = createHarness({ idleRetireMs: 1_000 });

		const lanes = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()]);
		pool.release(lanes[3]);
		advance(500);
		expect(await pool.acquire()).toBe(lanes[3]);
		advance(1_000);
		expect(disposed).toEqual([]);

		await pool.dispose();
	});

	it("disposes every lane and rejects the waiters on dispose", async () => {
		const { pool, disposed } = createHarness({ maxLanes: 3 });

		const lanes = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
		const waiting = pool.acquire();
		await new Promise((resolve) => setTimeout(resolve, 5));

		await pool.dispose();
		await expect(waiting).rejects.toThrow(/disposed/);
		expect(disposed).toEqual([0, 1, 2]);
		expect(pool.stats()).toEqual({ lanes: 0, idle: 0, busy: 0, waiting: 0 });

		// Releasing a lane the pool no longer owns is a no-op, and no new work is admitted.
		pool.release(lanes[0]);
		await expect(pool.acquire()).rejects.toThrow(/disposed/);
	});

	it("defaults the idle retirement window to one minute", () => {
		expect(DEFAULT_SHELL_LANE_IDLE_RETIRE_MS).toBe(60_000);
	});
});
