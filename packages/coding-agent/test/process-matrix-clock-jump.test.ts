/**
 * A live session showed a tool starting 26 minutes after the assistant message that asked for it,
 * and nothing in the transcript could tell a stalled harness from a suspended laptop. The
 * process-matrix heartbeat is the one thing that ticks on a fixed cadence, so a tick whose
 * wall-clock gap is far larger than its own interval is the observation that separates the two: it
 * is recorded in the session log as `clock_jump`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ClockJumpRecord,
	PI_ORCHESTRATION_AGENT_ID_ENV,
	PI_PARENT_PID_ENV,
	PI_PARENT_SESSION_ENV,
	PI_TASK_REF_ENV,
	type ProcessMatrixRuntimeConfig,
	type ProcessMatrixRuntimeHandle,
	startProcessMatrixRuntime,
} from "../src/core/process-matrix/runtime.ts";
import { PI_WORKTREE_LANE_ENV } from "../src/core/worktree-sync/runtime.ts";

const HEARTBEAT_MS = 5_000;
const T0 = Date.parse("2026-09-11T09:00:00.000Z");

const cleanups: string[] = [];

interface Harness {
	clock: { ms: number };
	jumps: ClockJumpRecord[];
	config: ProcessMatrixRuntimeConfig;
}

function makeHarness(): Harness {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-process-matrix-clock-jump-"));
	cleanups.push(agentDir);
	const clock = { ms: T0 };
	const jumps: ClockJumpRecord[] = [];
	return {
		clock,
		jumps,
		config: {
			agentDir,
			agent: {
				agentId: "clock-jump-agent",
				resumeContext: {
					provider: "pi",
					sessionId: "clock-jump-session",
					cwd: "/repo",
					resourceProfileNames: [],
					contextPointers: [],
				},
			},
			settings: { enabled: true, heartbeatMs: HEARTBEAT_MS, adoptionGraceMs: 60_000, watcherPollMs: 1_000 },
			isProcessAlive: () => true,
			now: () => clock.ms,
			notify: () => {},
			onDiagnostic: () => {},
			requestExit: async () => {},
			recordClockJump: (record) => jumps.push(record),
		},
	};
}

function useMasterEnv(): void {
	vi.stubEnv(PI_ORCHESTRATION_AGENT_ID_ENV, "");
	vi.stubEnv(PI_PARENT_PID_ENV, "");
	vi.stubEnv(PI_PARENT_SESSION_ENV, "");
	vi.stubEnv(PI_WORKTREE_LANE_ENV, "");
	vi.stubEnv(PI_TASK_REF_ENV, "");
}

/** Fire one heartbeat tick with the wall clock already standing at `at`. */
async function tickAt(harness: Harness, at: number, handle: ProcessMatrixRuntimeHandle): Promise<void> {
	harness.clock.ms = at;
	await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
	await handle.waitForIdle();
	for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	while (cleanups.length > 0) {
		const dir = cleanups.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("process-matrix heartbeat: clock-jump record", () => {
	it("records the one tick whose wall-clock gap far exceeds the heartbeat interval", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);

		// An on-cadence tick: a gap of exactly one interval is the normal case.
		await tickAt(harness, T0 + HEARTBEAT_MS, handle);
		expect(harness.jumps).toEqual([]);

		// The host suspended: the timer fires once on wake, ten intervals of wall clock later.
		await tickAt(harness, T0 + 11 * HEARTBEAT_MS, handle);
		expect(harness.jumps).toEqual([
			{
				previousTickAt: new Date(T0 + HEARTBEAT_MS).toISOString(),
				tickAt: new Date(T0 + 11 * HEARTBEAT_MS).toISOString(),
				gapMs: 10 * HEARTBEAT_MS,
				intervalMs: HEARTBEAT_MS,
			},
		]);

		// The next on-cadence tick is measured against the tick after the jump, not before it.
		await tickAt(harness, T0 + 12 * HEARTBEAT_MS, handle);
		expect(harness.jumps).toHaveLength(1);
		await handle.stop();
	});
});
