/**
 * Process-matrix worker branch: OBSERVING a newer generation's record, without writing to it.
 *
 * batch6 put one generation gate at `persist`, so every path that writes stands down when the stored
 * record belongs to a newer generation (same pid, newer `startedAt`). The watcher's other half is
 * not a write:
 *
 * - `graceTick` reads the fresh record and consults `pollWorkerDirective`. When the answer is
 *   neither `adopt` nor `user_cleanup`, `persist` is never called, so the gate never runs. At the
 *   grace deadline the old handle then calls `stop()` and `config.requestExit()` -- terminating the
 *   process that the NEW generation is running in.
 * - `healthyTick` observing the same record keeps its interval armed, so a handle that no longer
 *   owns anything keeps polling the new owner's entry.
 *
 * Ownership is decided when a fresh record is ACCEPTED, not only when one is written. Both cases are
 * driven through the public runtime handle with a deterministic fake clock and fake intervals; the
 * same-generation control proves the ordinary grace expiry still exits exactly once.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentIdentityContract } from "../src/core/orchestration/contracts.ts";
import type { ProcessMatrixEntry } from "../src/core/process-matrix/codes.ts";
import {
	PI_PARENT_PID_ENV,
	PI_PARENT_SESSION_ENV,
	PI_TASK_REF_ENV,
	type ProcessMatrixRuntimeConfig,
	type ProcessMatrixRuntimeHandle,
	startProcessMatrixRuntime,
} from "../src/core/process-matrix/runtime.ts";
import { buildEntryId, readEntry, writeEntry } from "../src/core/process-matrix/store.ts";
import { PI_WORKTREE_LANE_ENV } from "../src/core/worktree-sync/lane-binding.ts";

const POLL_MS = 1_000;
const HEARTBEAT_MS = 5_000;
const GRACE_MS = 60_000;
const PARENT_PID = 424_242;
const PARENT_SESSION = "generation-observation-parent";
const WORKER_SESSION = "generation-observation-worker";
const T0 = Date.parse("2026-07-19T12:00:00.000Z");

function agentIdentity(sessionId: string): AgentIdentityContract {
	return {
		agentId: `agent-${sessionId}`,
		resumeContext: {
			provider: "pi",
			sessionId,
			cwd: "/repo",
			resourceProfileNames: [],
			contextPointers: [],
		},
	};
}

interface Harness {
	agentDir: string;
	clock: { ms: number };
	livePids: Set<number>;
	notices: string[];
	exitRequests: number;
	config: ProcessMatrixRuntimeConfig;
}

const cleanups: string[] = [];

function makeHarness(): Harness {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-process-matrix-generation-"));
	cleanups.push(agentDir);
	const harness: Harness = {
		agentDir,
		clock: { ms: T0 },
		livePids: new Set([PARENT_PID]),
		notices: [],
		exitRequests: 0,
		config: undefined as unknown as ProcessMatrixRuntimeConfig,
	};
	harness.config = {
		agentDir,
		agent: agentIdentity(WORKER_SESSION),
		settings: { enabled: true, heartbeatMs: HEARTBEAT_MS, adoptionGraceMs: GRACE_MS, watcherPollMs: POLL_MS },
		observeProcess: (pid) => (harness.livePids.has(pid) ? "alive" : "dead"),
		now: () => harness.clock.ms,
		notify: (text) => {
			harness.notices.push(text);
		},
		requestExit: async () => {
			harness.exitRequests += 1;
		},
	};
	return harness;
}

function workerEntryId(): string {
	return buildEntryId("worker", WORKER_SESSION);
}

async function settle(rounds = 12): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function awaitWorkerEntry(harness: Harness): Promise<ProcessMatrixEntry> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const entry = await readEntry(harness.agentDir, workerEntryId());
		if (entry) return entry;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("worker never self-registered");
}

function useWorkerEnv(): void {
	vi.stubEnv(PI_PARENT_PID_ENV, String(PARENT_PID));
	vi.stubEnv(PI_PARENT_SESSION_ENV, PARENT_SESSION);
	vi.stubEnv(PI_WORKTREE_LANE_ENV, "");
	vi.stubEnv(PI_TASK_REF_ENV, "");
}

async function registerLiveParent(harness: Harness): Promise<void> {
	const at = new Date(harness.clock.ms).toISOString();
	await writeEntry(harness.agentDir, {
		entryId: buildEntryId("master", PARENT_SESSION),
		role: "master",
		agent: agentIdentity(PARENT_SESSION),
		pid: PARENT_PID,
		hostname: "test-host",
		startedAt: at,
		heartbeatAt: at,
		status: "running",
	});
}

/**
 * Replace the stored worker record with a NEWER generation of the same process: same pid, later
 * `startedAt`, and no directive for the older handle (its parent pid is unchanged, so
 * `pollWorkerDirective` answers `none`).
 */
async function installNewerGeneration(harness: Harness, previous: ProcessMatrixEntry): Promise<ProcessMatrixEntry> {
	const at = new Date(harness.clock.ms + 1_000).toISOString();
	const newer: ProcessMatrixEntry = {
		...previous,
		startedAt: at,
		heartbeatAt: at,
		status: "running",
		parentPid: PARENT_PID,
	};
	delete (newer as { windDownReason?: string }).windDownReason;
	delete (newer as { resumable?: unknown }).resumable;
	await writeEntry(harness.agentDir, newer);
	return newer;
}

/** Lose the parent so the runtime leaves its healthy watch for the adoption grace window. */
async function windDown(harness: Harness, handle: ProcessMatrixRuntimeHandle): Promise<void> {
	harness.livePids.delete(PARENT_PID);
	await vi.advanceTimersByTimeAsync(POLL_MS);
	await handle.waitForIdle();
	await settle();
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	while (cleanups.length > 0) {
		const dir = cleanups.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("process-matrix generation observation", () => {
	it("does not request exit at grace expiry once a newer generation owns the entry", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		await registerLiveParent(harness);
		const handle = await startProcessMatrixRuntime(harness.config);
		try {
			const own = await awaitWorkerEntry(harness);
			await windDown(harness, handle);
			const newer = await installNewerGeneration(harness, own);

			// One tick observes the newer record, then the grace window expires.
			await vi.advanceTimersByTimeAsync(POLL_MS);
			await handle.waitForIdle();
			harness.clock.ms += GRACE_MS + POLL_MS;
			await vi.advanceTimersByTimeAsync(POLL_MS);
			await handle.waitForIdle();
			await settle();

			// The old handle owns nothing: its grace deadline may not terminate the process the new
			// generation is running in, and it may not touch that generation's record.
			expect(harness.exitRequests).toBe(0);
			expect(await readEntry(harness.agentDir, workerEntryId())).toEqual(newer);
		} finally {
			await handle.stop();
		}
	});

	it("stands its watcher down after observing a newer generation", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		await registerLiveParent(harness);
		const handle = await startProcessMatrixRuntime(harness.config);
		try {
			const own = await awaitWorkerEntry(harness);
			const newer = await installNewerGeneration(harness, own);

			await vi.advanceTimersByTimeAsync(POLL_MS);
			await handle.waitForIdle();
			await settle();

			// Ownership moved; a handle that owns nothing keeps no watcher armed and writes nothing.
			expect(vi.getTimerCount()).toBe(0);
			expect(await readEntry(harness.agentDir, workerEntryId())).toEqual(newer);
		} finally {
			await handle.stop();
		}
	});

	it("negative control: a same-generation grace expiry still exits exactly once", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		await registerLiveParent(harness);
		const handle = await startProcessMatrixRuntime(harness.config);
		try {
			await awaitWorkerEntry(harness);
			await windDown(harness, handle);

			harness.clock.ms += GRACE_MS + POLL_MS;
			await vi.advanceTimersByTimeAsync(POLL_MS);
			await handle.waitForIdle();
			await settle();

			expect(harness.exitRequests).toBe(1);
			// Its own generation's wind-down is preserved for a later adoption, not overwritten.
			const settled = await readEntry(harness.agentDir, workerEntryId());
			expect(settled?.status).toBe("resumable");
			expect(settled?.resumable?.lastCode).toBe("resumable");
		} finally {
			await handle.stop();
		}
	});

	it("negative control: an owning runtime keeps its watcher armed", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		await registerLiveParent(harness);
		const handle = await startProcessMatrixRuntime(harness.config);
		try {
			await awaitWorkerEntry(harness);

			await vi.advanceTimersByTimeAsync(POLL_MS);
			await handle.waitForIdle();

			expect(vi.getTimerCount()).toBeGreaterThan(0);
			expect(harness.exitRequests).toBe(0);
		} finally {
			await handle.stop();
		}
	});
});
