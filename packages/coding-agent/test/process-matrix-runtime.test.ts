import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessMatrixEntry } from "../src/core/process-matrix/codes.ts";
import {
	getParentPid,
	getParentSessionId,
	PI_PARENT_PID_ENV,
	PI_PARENT_SESSION_ENV,
	type ProcessMatrixRuntimeConfig,
	startProcessMatrixRuntime,
} from "../src/core/process-matrix/runtime.ts";
import { buildEntryId, listEntries, readEntry, writeEntry } from "../src/core/process-matrix/store.ts";
import { applyAdoption, beginWindDown } from "../src/core/process-matrix/supervisor.ts";
import { PI_WORKTREE_LANE_ENV } from "../src/core/worktree-sync/runtime.ts";

describe("getParentPid", () => {
	it("parses a valid positive integer", () => {
		expect(getParentPid({ [PI_PARENT_PID_ENV]: "12345" })).toBe(12345);
	});

	it("is undefined when unset", () => {
		expect(getParentPid({})).toBeUndefined();
	});

	it("ignores a non-numeric value", () => {
		expect(getParentPid({ [PI_PARENT_PID_ENV]: "not-a-pid" })).toBeUndefined();
	});

	it("ignores zero and negative values", () => {
		expect(getParentPid({ [PI_PARENT_PID_ENV]: "0" })).toBeUndefined();
		expect(getParentPid({ [PI_PARENT_PID_ENV]: "-5" })).toBeUndefined();
	});

	it("parses the leading integer of a value with trailing garbage (Number.parseInt semantics)", () => {
		expect(getParentPid({ [PI_PARENT_PID_ENV]: "123abc" })).toBe(123);
	});
});

describe("getParentSessionId", () => {
	it("returns a trimmed session id", () => {
		expect(getParentSessionId({ [PI_PARENT_SESSION_ENV]: "  session-1  " })).toBe("session-1");
	});

	it("is undefined when unset", () => {
		expect(getParentSessionId({})).toBeUndefined();
	});

	it("is undefined when set to an empty/whitespace-only string", () => {
		expect(getParentSessionId({ [PI_PARENT_SESSION_ENV]: "" })).toBeUndefined();
		expect(getParentSessionId({ [PI_PARENT_SESSION_ENV]: "   " })).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// startProcessMatrixRuntime -- behavioral coverage of the timer/watcher
// composition, with only setInterval/clearInterval faked (fs I/O and the
// settle() yields below run on real macrotasks) and every other dep injected:
// the clock via `now`, liveness via `isProcessAlive`, the ask/notify/exit
// seams via the config. Advancing the fake interval fires a tick; settle()
// then lets the tick's real store I/O finish before asserting.
// ---------------------------------------------------------------------------

const POLL_MS = 1_000;
const HEARTBEAT_MS = 5_000;
const GRACE_MS = 60_000;

const PARENT_PID = 424_242;
const NEW_PARENT_PID = 515_151;
const T0 = Date.parse("2026-07-19T12:00:00.000Z");

interface Harness {
	agentDir: string;
	clock: { ms: number };
	livePids: Set<number>;
	notices: string[];
	diagnostics: string[];
	confirmAsks: string[];
	confirmAnswers: boolean[];
	exitRequests: number;
	config: ProcessMatrixRuntimeConfig;
}

const cleanups: string[] = [];

function makeHarness(overrides: Partial<ProcessMatrixRuntimeConfig> = {}): Harness {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-process-matrix-runtime-"));
	cleanups.push(agentDir);
	const harness: Harness = {
		agentDir,
		clock: { ms: T0 },
		livePids: new Set([PARENT_PID]),
		notices: [],
		diagnostics: [],
		confirmAsks: [],
		confirmAnswers: [],
		exitRequests: 0,
		config: undefined as unknown as ProcessMatrixRuntimeConfig,
	};
	harness.config = {
		agentDir,
		sessionId: "runtime-test-session",
		hasUI: false,
		settings: { enabled: true, heartbeatMs: HEARTBEAT_MS, adoptionGraceMs: GRACE_MS, watcherPollMs: POLL_MS },
		isProcessAlive: (pid) => harness.livePids.has(pid),
		now: () => harness.clock.ms,
		notify: (text) => harness.notices.push(text),
		onDiagnostic: (message) => harness.diagnostics.push(message),
		promptConfirm: async (message) => {
			harness.confirmAsks.push(message);
			return harness.confirmAnswers.shift() ?? false;
		},
		requestExit: () => {
			harness.exitRequests += 1;
		},
		...overrides,
	};
	return harness;
}

/** Real-macrotask yields so a fired tick's fs reads/writes complete before assertions. */
async function settle(): Promise<void> {
	for (let i = 0; i < 8; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

async function tick(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
	await settle();
}

/**
 * Bounded await-until: polls `read()` on a real interval until `predicate` is satisfied or
 * `timeoutMs` elapses, then returns the satisfying value. Replaces a fixed macrotask-yield count
 * (settle()) for assertions that depend on an async state transition (the orphan-scan's
 * promptConfirm -> writeEntry chain, a worker's self-registration write, a heartbeat write): on a
 * slow/loaded runner (observed on windows-latest) a fixed yield count can be outrun, and this
 * polls the actual expected state instead of guessing an event-loop count. Throws with the
 * last-seen value on timeout so a genuine regression still fails loudly and diagnosably.
 */
async function awaitState<T>(
	read: () => Promise<T>,
	predicate: (value: T) => boolean,
	options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
	const { timeoutMs = 5_000, intervalMs = 25 } = options;
	const deadline = Date.now() + timeoutMs;
	let last: T;
	for (;;) {
		last = await read();
		if (predicate(last)) return last;
		if (Date.now() >= deadline) {
			throw new Error(
				`awaitState: timed out after ${timeoutMs}ms waiting for the expected state. Last seen: ${JSON.stringify(last)}`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
}

function workerEntryId(harness: Harness): string {
	return buildEntryId("worker", harness.config.sessionId);
}

async function readWorkerEntry(harness: Harness): Promise<ProcessMatrixEntry | undefined> {
	return readEntry(harness.agentDir, workerEntryId(harness));
}

async function registerLiveParent(harness: Harness, sessionId: string, pid = PARENT_PID): Promise<void> {
	const at = new Date(harness.clock.ms).toISOString();
	await writeEntry(harness.agentDir, {
		entryId: buildEntryId("master", sessionId),
		role: "master",
		pid,
		sessionId,
		hostname: "CauDev",
		startedAt: at,
		heartbeatAt: at,
		status: "running",
	});
}

function useWorkerEnv(parentSessionId?: string, laneKey?: string): void {
	vi.stubEnv(PI_PARENT_PID_ENV, String(PARENT_PID));
	vi.stubEnv(PI_PARENT_SESSION_ENV, parentSessionId ?? "");
	vi.stubEnv(PI_WORKTREE_LANE_ENV, laneKey ?? "");
}

function useMasterEnv(): void {
	vi.stubEnv(PI_PARENT_PID_ENV, "");
	vi.stubEnv(PI_PARENT_SESSION_ENV, "");
	vi.stubEnv(PI_WORKTREE_LANE_ENV, "");
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	while (cleanups.length > 0) {
		const dir = cleanups.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("startProcessMatrixRuntime (worker branch)", () => {
	it("is a no-op when disabled: nothing written, nothing ticks", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness({
			settings: { enabled: false, heartbeatMs: HEARTBEAT_MS, adoptionGraceMs: GRACE_MS, watcherPollMs: POLL_MS },
		});

		const handle = await startProcessMatrixRuntime(harness.config);
		await tick(POLL_MS * 3);

		expect(await listEntries(harness.agentDir)).toEqual([]);
		expect(harness.notices).toEqual([]);
		expect(harness.exitRequests).toBe(0);
		handle.stop();
	});

	it("self-registers a running entry bound to its parent and stays healthy while the parent lives", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv("parent-session-1");
		const harness = makeHarness();
		await registerLiveParent(harness, "parent-session-1");

		const handle = await startProcessMatrixRuntime(harness.config);
		const registered = await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry !== undefined,
		);
		expect(registered).toMatchObject({
			role: "worker",
			status: "running",
			pid: process.pid,
			parentPid: PARENT_PID,
			parentSessionId: "parent-session-1",
			sessionId: harness.config.sessionId,
		});

		await tick(POLL_MS * 3);
		const stillRunning = await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry?.status === "running",
		);
		expect(stillRunning?.status).toBe("running");
		expect(harness.notices).toEqual([]);
		expect(harness.exitRequests).toBe(0);
		handle.stop();
	});

	it("winds down when a reused live PID has no fresh matching parent-session heartbeat", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv("parent-session-1");
		const harness = makeHarness();
		await registerLiveParent(harness, "parent-session-1");
		const parent = await readEntry(harness.agentDir, buildEntryId("master", "parent-session-1"));
		expect(parent).toBeDefined();
		await writeEntry(harness.agentDir, {
			...(parent as ProcessMatrixEntry),
			heartbeatAt: new Date(T0 - HEARTBEAT_MS * 3).toISOString(),
		});

		const handle = await startProcessMatrixRuntime(harness.config);
		await tick(POLL_MS * 2);
		const woundDown = await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry?.status === "resumable",
		);
		expect(woundDown?.windDownReason).toBe("parent_lost");
		expect(harness.notices[0]).toContain("parent process");
		handle.stop();
	});

	it("parent death winds down gracefully -- never silently -- leaving a lane-tagged resumable payload", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv("parent-session-1", "lane-alpha");
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await settle();

		harness.livePids.delete(PARENT_PID);
		await tick(POLL_MS);

		const entry = await awaitState(
			() => readWorkerEntry(harness),
			(value) => value?.status === "resumable",
		);
		expect(entry).toMatchObject({
			status: "resumable",
			windDownReason: "parent_lost",
			resumable: { lastCode: "resumable", laneKey: "lane-alpha" },
		});
		expect(harness.notices).toHaveLength(1);
		expect(harness.notices[0]).toContain(`pid ${PARENT_PID}`);
		expect(harness.notices[0]).toContain("resumable");
		// Grace window: wound down but NOT exited yet.
		expect(harness.exitRequests).toBe(0);
		handle.stop();
	});

	it("applies a master-written adoption during grace, keeps the adopter's sessionId, and re-arms the watch on the new parent", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv("parent-session-1");
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await settle();

		harness.livePids.delete(PARENT_PID);
		await tick(POLL_MS);
		const resumable = await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry?.status === "resumable",
		);
		expect(resumable?.status).toBe("resumable");

		// The adopting master's ask-gated write into the orphan's own entry.
		harness.livePids.add(NEW_PARENT_PID);
		const orphaned = resumable as ProcessMatrixEntry;
		await writeEntry(
			harness.agentDir,
			applyAdoption(orphaned, { parentPid: NEW_PARENT_PID, parentSessionId: "adopter-session" }),
		);

		await tick(POLL_MS);
		const adopted = await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry?.status === "running" && entry?.parentPid === NEW_PARENT_PID,
		);
		expect(adopted).toMatchObject({ status: "running", parentPid: NEW_PARENT_PID });
		// The worker's local re-apply must NOT clobber the adopter's sessionId back to the old parent's.
		expect(adopted?.parentSessionId).toBe("adopter-session");
		expect(adopted?.windDownReason).toBeUndefined();
		expect(harness.notices.some((text) => text.includes(`pid ${NEW_PARENT_PID}`))).toBe(true);
		expect(harness.exitRequests).toBe(0);

		// The healthy watch now tracks the NEW parent: its death triggers a second wind-down.
		harness.livePids.delete(NEW_PARENT_PID);
		await tick(POLL_MS);
		const rewoundDown = await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry?.status === "resumable" && entry?.windDownReason === "parent_lost",
		);
		expect(rewoundDown).toMatchObject({ status: "resumable", windDownReason: "parent_lost" });
		expect(harness.notices.some((text) => text.includes(`pid ${NEW_PARENT_PID}`) && text.includes("gone"))).toBe(
			true,
		);
		handle.stop();
	});

	it("self-exits cooperatively once the adoption grace window expires unclaimed, and only once", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await settle();

		harness.livePids.delete(PARENT_PID);
		await tick(POLL_MS);
		const resumable = await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry?.status === "resumable",
		);
		expect(resumable?.status).toBe("resumable");

		// Still inside the grace window: no exit.
		harness.clock.ms = T0 + GRACE_MS - 1;
		await tick(POLL_MS);
		expect(harness.exitRequests).toBe(0);

		harness.clock.ms = T0 + GRACE_MS;
		await tick(POLL_MS);
		await awaitState(
			async () => harness.exitRequests,
			(count) => count === 1,
		);
		expect(harness.exitRequests).toBe(1);

		// The watcher stopped itself: more polls never double-fire the exit.
		await tick(POLL_MS * 3);
		expect(harness.exitRequests).toBe(1);
		// The resumable payload survives for a future session to pick up.
		expect((await readWorkerEntry(harness))?.status).toBe("resumable");
		handle.stop();
	});

	it("honors a master-requested cooperative cleanup while healthy: persists the wind-down, notifies, exits", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv("parent-session-1");
		const harness = makeHarness();
		await registerLiveParent(harness, "parent-session-1");
		const handle = await startProcessMatrixRuntime(harness.config);
		const fresh = (await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry !== undefined,
		)) as ProcessMatrixEntry;
		await writeEntry(
			harness.agentDir,
			beginWindDown(fresh, "user_cleanup", new Date(harness.clock.ms).toISOString()),
		);

		await tick(POLL_MS);
		const woundDown = await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry?.status === "winding_down",
		);
		expect(woundDown).toMatchObject({ status: "winding_down", windDownReason: "user_cleanup" });
		expect(harness.notices.some((text) => text.includes("cooperative cleanup"))).toBe(true);
		await awaitState(
			async () => harness.exitRequests,
			(count) => count === 1,
		);
		expect(harness.exitRequests).toBe(1);

		await tick(POLL_MS * 3);
		expect(harness.exitRequests).toBe(1);
		handle.stop();
	});

	it("stop() halts the watch: a later parent death is no longer observed", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await settle();

		handle.stop();
		harness.livePids.delete(PARENT_PID);
		await tick(POLL_MS * 3);

		expect((await readWorkerEntry(harness))?.status).toBe("running");
		expect(harness.notices).toEqual([]);
		expect(harness.exitRequests).toBe(0);
	});
});

describe("startProcessMatrixRuntime (master branch)", () => {
	function orphanEntry(): ProcessMatrixEntry {
		return {
			entryId: buildEntryId("worker", "orphan-session"),
			role: "worker",
			pid: 616_161,
			sessionId: "orphan-session",
			hostname: "host-a",
			startedAt: new Date(T0).toISOString(),
			heartbeatAt: new Date(T0).toISOString(),
			status: "running",
			parentPid: 717_171, // never in livePids -> provably dead
			parentSessionId: "dead-parent-session",
			laneKey: "lane-omega",
		};
	}

	it("registers a master entry and heartbeats it on the configured cadence", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		const entryId = buildEntryId("master", harness.config.sessionId);
		const registered = await awaitState(
			() => readEntry(harness.agentDir, entryId),
			(entry) => entry !== undefined,
		);
		expect(registered).toMatchObject({ role: "master", status: "running", pid: process.pid });
		expect(registered?.heartbeatAt).toBe(new Date(T0).toISOString());

		harness.clock.ms = T0 + HEARTBEAT_MS;
		await tick(HEARTBEAT_MS);
		const heartbeated = await awaitState(
			() => readEntry(harness.agentDir, entryId),
			(entry) => entry?.heartbeatAt === new Date(T0 + HEARTBEAT_MS).toISOString(),
		);
		expect(heartbeated?.heartbeatAt).toBe(new Date(T0 + HEARTBEAT_MS).toISOString());
		handle.stop();
	});

	it("orphan scan without a UI is report-only: a diagnostic names the orphan, nothing is written, nobody is asked", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness({ hasUI: false });
		const orphan = orphanEntry();
		await writeEntry(harness.agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitState(
			async () => harness.diagnostics,
			(diagnostics) => diagnostics.some((text) => text.includes(orphan.entryId)),
		);

		expect(harness.confirmAsks).toEqual([]);
		expect(harness.diagnostics.some((text) => text.includes(orphan.entryId) && text.includes("report-only"))).toBe(
			true,
		);
		expect(await readEntry(harness.agentDir, orphan.entryId)).toEqual(orphan);
		handle.stop();
	});

	it("orphan scan with an owner-confirmed adoption writes this master in as the orphan's new parent", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness({ hasUI: true });
		harness.confirmAnswers.push(true); // adopt?
		const orphan = orphanEntry();
		await writeEntry(harness.agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		const adopted = await awaitState(
			() => readEntry(harness.agentDir, orphan.entryId),
			(entry) => entry?.status === "running" && entry?.parentPid === process.pid,
		);

		expect(harness.confirmAsks).toHaveLength(1);
		expect(harness.confirmAsks[0]).toContain(orphan.entryId);
		expect(harness.confirmAsks[0]).toContain("lane-omega");
		expect(adopted).toMatchObject({
			status: "running",
			parentPid: process.pid,
			parentSessionId: harness.config.sessionId,
		});
		handle.stop();
	});

	it("orphan scan with adoption declined but cleanup confirmed writes a user_cleanup wind-down request", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness({ hasUI: true });
		harness.confirmAnswers.push(false, true); // adopt? no -- clean up? yes
		const orphan = orphanEntry();
		await writeEntry(harness.agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		const cleaned = await awaitState(
			() => readEntry(harness.agentDir, orphan.entryId),
			(entry) => entry?.status === "winding_down",
		);

		expect(harness.confirmAsks).toHaveLength(2);
		expect(cleaned).toMatchObject({
			status: "winding_down",
			windDownReason: "user_cleanup",
		});
		handle.stop();
	});

	it("orphan scan with both asks declined leaves the orphan entry untouched", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness({ hasUI: true });
		harness.confirmAnswers.push(false, false);
		const orphan = orphanEntry();
		await writeEntry(harness.agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitState(
			async () => harness.confirmAsks,
			(asks) => asks.length >= 2,
		);

		expect(harness.confirmAsks).toHaveLength(2);
		expect(await readEntry(harness.agentDir, orphan.entryId)).toEqual(orphan);
		handle.stop();
	});
});
