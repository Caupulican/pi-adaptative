/**
 * Process-matrix worker branch: stop() versus an in-flight watcher read.
 *
 * Every watcher tick checks `stopped` on entry and then awaits a store read. None of the four
 * continuations rechecks it afterwards (runtime.ts):
 *
 * - `healthyTick` :791 awaits `declaredParentIsAlive()` and goes straight into `enterWindDown()`.
 * - `healthyTick` :796 awaits the directive read and goes straight into `completeCooperativeCleanup()`.
 * - `graceTick` :829 awaits its read, then applies an adoption (:836) and calls `startHealthyWatch()`.
 * - `graceTick` :862 reaches grace expiry and calls `config.requestExit()`.
 *
 * `closeWorker` does not await `watchTask` (it cannot: `completeCooperativeCleanup` calls `stop()`
 * from inside a watch tick), so a tick that was already awaiting a read when `stop()` was called
 * resumes afterwards and writes through a compare-and-swap whose "expected" value is exactly what
 * stop just persisted. The guard succeeds, so a terminal record is downgraded, a session notice is
 * emitted, `requestExit` fires and a fresh interval is armed - all after the handle was stopped and
 * awaited.
 *
 * The existing coverage ("stop() halts the watch: a later parent death is no longer observed")
 * stops the handle while no tick is running, so it only proves that future ticks are suppressed.
 *
 * Only setInterval/clearInterval are faked, matching the existing runtime suite. Reads are gated at
 * the existing ProcessMatrixStorePort, never by patching the filesystem.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentIdentityContract } from "../src/core/orchestration/contracts.ts";
import type { ProcessMatrixEntry } from "../src/core/process-matrix/codes.ts";
import {
	localProcessMatrixStore,
	PI_PARENT_PID_ENV,
	PI_PARENT_SESSION_ENV,
	PI_TASK_REF_ENV,
	type ProcessMatrixRuntimeConfig,
	type ProcessMatrixStorePort,
	startProcessMatrixRuntime,
} from "../src/core/process-matrix/runtime.ts";
import { buildEntryId, entryPath, readEntry, writeEntry } from "../src/core/process-matrix/store.ts";
import { applyAdoption, beginWindDown } from "../src/core/process-matrix/supervisor.ts";
import { PI_WORKTREE_LANE_ENV } from "../src/core/worktree-sync/runtime.ts";

const POLL_MS = 1_000;
const HEARTBEAT_MS = 5_000;
const GRACE_MS = 60_000;
const PARENT_PID = 424_242;
const NEW_PARENT_PID = 515_151;
const PARENT_SESSION = "parent-session";
const WORKER_SESSION = "worker-lifetime-session";
const T0 = Date.parse("2026-07-19T12:00:00.000Z");

interface Gate {
	/** Resolves once the gated read has actually been entered by the runtime. */
	entered: Promise<void>;
	release(value: ProcessMatrixEntry | undefined): void;
}

interface GatedStore {
	port: ProcessMatrixStorePort;
	/** Intercept the next read of `entryId`, holding it until the gate is released. */
	hold(entryId: string): Gate;
}

function gatedStore(): GatedStore {
	const gates = new Map<string, (value: ProcessMatrixEntry | undefined) => void>();
	const port: ProcessMatrixStorePort = {
		...localProcessMatrixStore,
		readEntry: async (agentDir: string, entryId: string) => {
			const pending = gates.get(entryId);
			if (!pending) return localProcessMatrixStore.readEntry(agentDir, entryId);
			gates.delete(entryId);
			return new Promise<ProcessMatrixEntry | undefined>((resolve) => {
				pending(undefined);
				gateResolvers.set(entryId, resolve);
			});
		},
	};
	const gateResolvers = new Map<string, (value: ProcessMatrixEntry | undefined) => void>();
	return {
		port,
		hold(entryId: string): Gate {
			let signalEntered!: () => void;
			const entered = new Promise<void>((resolve) => {
				signalEntered = resolve;
			});
			gates.set(entryId, () => signalEntered());
			return {
				entered,
				release(value) {
					const resolve = gateResolvers.get(entryId);
					if (!resolve) throw new Error(`Gate for ${entryId} was never entered`);
					gateResolvers.delete(entryId);
					resolve(value);
				},
			};
		},
	};
}

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
	diagnostics: string[];
	exitRequests: number;
	store: GatedStore;
	config: ProcessMatrixRuntimeConfig;
}

const cleanups: string[] = [];

function makeHarness(): Harness {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-process-matrix-worker-lifetime-"));
	cleanups.push(agentDir);
	const store = gatedStore();
	const harness: Harness = {
		agentDir,
		clock: { ms: T0 },
		livePids: new Set([PARENT_PID]),
		notices: [],
		diagnostics: [],
		exitRequests: 0,
		store,
		config: undefined as unknown as ProcessMatrixRuntimeConfig,
	};
	harness.config = {
		agentDir,
		agent: agentIdentity(WORKER_SESSION),
		settings: { enabled: true, heartbeatMs: HEARTBEAT_MS, adoptionGraceMs: GRACE_MS, watcherPollMs: POLL_MS },
		isProcessAlive: (pid) => harness.livePids.has(pid),
		now: () => harness.clock.ms,
		notify: (text) => {
			harness.notices.push(text);
		},
		onDiagnostic: (message) => harness.diagnostics.push(message),
		requestExit: async () => {
			harness.exitRequests += 1;
		},
		store: store.port,
	};
	return harness;
}

/** Real-macrotask yields so a resumed tick's store I/O completes before assertions. */
async function settle(rounds = 12): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function workerEntryId(): string {
	return buildEntryId("worker", WORKER_SESSION);
}

function masterEntryId(): string {
	return buildEntryId("master", PARENT_SESSION);
}

async function readWorkerEntry(harness: Harness): Promise<ProcessMatrixEntry | undefined> {
	return readEntry(harness.agentDir, workerEntryId());
}

async function registerLiveParent(harness: Harness): Promise<void> {
	const at = new Date(harness.clock.ms).toISOString();
	await writeEntry(harness.agentDir, {
		entryId: masterEntryId(),
		role: "master",
		agent: agentIdentity(PARENT_SESSION),
		pid: PARENT_PID,
		hostname: "test-host",
		startedAt: at,
		heartbeatAt: at,
		status: "running",
	});
}

async function awaitWorkerEntry(harness: Harness): Promise<ProcessMatrixEntry> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const entry = await readWorkerEntry(harness);
		if (entry) return entry;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("worker never self-registered");
}

function useWorkerEnv(): void {
	vi.stubEnv(PI_PARENT_PID_ENV, String(PARENT_PID));
	vi.stubEnv(PI_PARENT_SESSION_ENV, PARENT_SESSION);
	vi.stubEnv(PI_WORKTREE_LANE_ENV, "");
	vi.stubEnv(PI_TASK_REF_ENV, "");
}

type EntryFileState = "valid-entry" | "unreadable-entry" | "missing-file";

/**
 * Distinguishes "the record changed" from "the record is no longer a record at all". `store.ts:107`
 * rejects any persisted entry that carries a `terminal` handoff without `status: "closed"`, so a
 * write that mutates the status of a terminal entry in place leaves a file that `readEntry` and
 * `listEntries` both skip.
 */
async function entryFileState(harness: Harness): Promise<EntryFileState> {
	let raw: string;
	try {
		raw = await readFile(entryPath(harness.agentDir, workerEntryId()), "utf8");
	} catch {
		return "missing-file";
	}
	if (raw.length === 0) return "missing-file";
	return (await readWorkerEntry(harness)) ? "valid-entry" : "unreadable-entry";
}

interface PostStopObservation {
	status: string | undefined;
	entryFileState: EntryFileState;
	notices: string[];
	exitRequests: number;
	activeIntervals: number;
}

async function observeAfterStop(harness: Harness, noticesBefore: number): Promise<PostStopObservation> {
	return {
		status: (await readWorkerEntry(harness))?.status,
		entryFileState: await entryFileState(harness),
		notices: harness.notices.slice(noticesBefore),
		exitRequests: harness.exitRequests,
		activeIntervals: vi.getTimerCount(),
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	while (cleanups.length > 0) {
		const dir = cleanups.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("process-matrix worker stop versus an in-flight watcher read", () => {
	it("does not wind down after stop when the parent-liveness read resolves absent", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		await registerLiveParent(harness);
		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitWorkerEntry(harness);

		const gate = harness.store.hold(masterEntryId());
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await gate.entered;
		await handle.stop();
		expect((await readWorkerEntry(harness))?.status).toBe("closed");

		// The parent's master entry is gone: the read that was already in flight now says "parent lost".
		const noticesBefore = harness.notices.length;
		gate.release(undefined);
		await handle.waitForIdle();
		await settle();

		expect(await observeAfterStop(harness, noticesBefore)).toEqual({
			status: "closed",
			entryFileState: "valid-entry",
			notices: [],
			exitRequests: 0,
			activeIntervals: 0,
		});
	});

	it("does not run a cooperative cleanup after stop when the directive read resolves late", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		await registerLiveParent(harness);
		const handle = await startProcessMatrixRuntime(harness.config);
		const registered = await awaitWorkerEntry(harness);
		// A master requests cooperative cleanup by writing the directive into the worker's own entry.
		await writeEntry(
			harness.agentDir,
			beginWindDown(registered, "user_cleanup", new Date(harness.clock.ms).toISOString()),
		);

		const gate = harness.store.hold(workerEntryId());
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await gate.entered;
		await handle.stop();
		const stopped = await readWorkerEntry(harness);
		expect(stopped?.status).toBe("closed");

		// The in-flight read completes against what stop() just persisted.
		const noticesBefore = harness.notices.length;
		gate.release(stopped);
		await handle.waitForIdle();
		await settle();

		expect(await observeAfterStop(harness, noticesBefore)).toEqual({
			status: "closed",
			entryFileState: "valid-entry",
			notices: [],
			exitRequests: 0,
			activeIntervals: 0,
		});
	});

	it("does not adopt a new parent after stop when the grace read resolves late", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitWorkerEntry(harness);

		// Lose the parent so the runtime enters its grace watch.
		harness.livePids.delete(PARENT_PID);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await handle.waitForIdle();
		await settle();
		const resumable = await readWorkerEntry(harness);
		expect(resumable?.status).toBe("resumable");

		// A new master claims the entry while the next grace read is in flight.
		harness.livePids.add(NEW_PARENT_PID);
		await writeEntry(
			harness.agentDir,
			applyAdoption(resumable as ProcessMatrixEntry, {
				parentPid: NEW_PARENT_PID,
				parentSessionId: "new-parent-session",
			}),
		);
		const gate = harness.store.hold(workerEntryId());
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await gate.entered;
		await handle.stop();

		const noticesBefore = harness.notices.length;
		gate.release(await readWorkerEntry(harness));
		await handle.waitForIdle();
		await settle();

		const observed = await observeAfterStop(harness, noticesBefore);
		expect(observed.notices).toEqual([]);
		expect(observed.activeIntervals).toBe(0);
		expect(observed.status).not.toBe("running");
	});

	it("does not request exit after stop when grace expiry is reached by a late read", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitWorkerEntry(harness);

		harness.livePids.delete(PARENT_PID);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await handle.waitForIdle();
		await settle();
		expect((await readWorkerEntry(harness))?.status).toBe("resumable");

		const gate = harness.store.hold(workerEntryId());
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await gate.entered;
		await handle.stop();
		// The grace window expires while the read is still outstanding.
		harness.clock.ms += GRACE_MS * 2;

		const noticesBefore = harness.notices.length;
		gate.release(undefined);
		await handle.waitForIdle();
		await settle();

		const observed = await observeAfterStop(harness, noticesBefore);
		expect(observed.exitRequests).toBe(0);
		expect(observed.activeIntervals).toBe(0);
	});

	it("negative control: a healthy watch keeps the entry running and stays silent", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		await registerLiveParent(harness);
		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitWorkerEntry(harness);

		await vi.advanceTimersByTimeAsync(POLL_MS * 3);
		await handle.waitForIdle();
		await settle();

		expect((await readWorkerEntry(harness))?.status).toBe("running");
		expect(harness.notices).toEqual([]);
		expect(harness.exitRequests).toBe(0);
		await handle.stop();
	});

	it("negative control: a lost parent winds down to resumable with one notice", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitWorkerEntry(harness);

		harness.livePids.delete(PARENT_PID);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await handle.waitForIdle();
		await settle();

		expect((await readWorkerEntry(harness))?.status).toBe("resumable");
		expect(harness.notices.filter((notice) => notice.includes("Winding down gracefully"))).toHaveLength(1);
		expect(harness.exitRequests).toBe(0);
		await handle.stop();
	});

	it("negative control: a live adoption during grace resumes the healthy watch", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitWorkerEntry(harness);

		harness.livePids.delete(PARENT_PID);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await handle.waitForIdle();
		await settle();
		const resumable = await readWorkerEntry(harness);

		harness.livePids.add(NEW_PARENT_PID);
		await writeEntry(
			harness.agentDir,
			applyAdoption(resumable as ProcessMatrixEntry, {
				parentPid: NEW_PARENT_PID,
				parentSessionId: "new-parent-session",
			}),
		);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await handle.waitForIdle();
		await settle();

		expect((await readWorkerEntry(harness))?.status).toBe("running");
		expect(harness.notices.filter((notice) => notice.includes("adopted by a new parent"))).toHaveLength(1);
		await handle.stop();
	});
});
