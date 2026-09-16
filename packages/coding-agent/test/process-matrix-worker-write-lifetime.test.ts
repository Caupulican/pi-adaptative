/**
 * Process-matrix worker branch: stop arriving from inside a synchronous callout.
 *
 * green2 fenced every watcher continuation that resumes after an awaited STORE read. `notify` is a
 * different shape: `emitRuntimeNotice` calls `config.notify(text)` synchronously (runtime.ts), so a
 * host whose notice sink reacts by stopping the runtime re-enters `stop()` between two synchronous
 * statements, not across an await. Neither `startGraceWatch` nor `startHealthyWatch` checks `stopped`
 * before arming its interval, and both are called immediately after that callout:
 *
 *   enterWindDown: persist -> clearInterval -> preserveResumableOnExit -> emitRuntimeNotice -> startGraceWatch
 *   graceTick:     persist -> emitRuntimeNotice -> ... -> clearInterval -> startHealthyWatch
 *
 * `closeWorker` sets `stopped` and clears the live timer synchronously before its first await, so by
 * the time the notice returns the runtime is already stopped - and then a fresh interval is armed on
 * it. The watcher body is fenced, so nothing further mutates state, but a stopped runtime holding a
 * live interval is exactly the "idle must not look like a live process" boundary this audit is about.
 *
 * Two further gaps live on the ACTIVE path, not the stop path:
 *
 * - `healthyTick` and `graceTick` read a fresh stored entry and hand it straight to `persist` as its
 *   `expected` value. The compare-and-swap therefore matches whatever is on disk and SUCCEEDS on the
 *   first try, so `persist`'s generation check - which only runs in its CAS-failure branch - is never
 *   reached. A directive written by a NEWER generation (same pid, newer `startedAt`) is consumed by
 *   the old handle, which overwrites that generation's record, notifies, and for a cooperative
 *   cleanup calls `requestExit`.
 * - In the adoption branch, `persist` assigns `entry` the adopted RUNNING record, but
 *   `preserveResumableOnExit` stays true until after the notice callout. A stop re-entered from that
 *   callout therefore takes `closeWorker`'s restore branch, finds `current` deep-equal to `entry`,
 *   and writes nothing - then the continuation flips `preserveResumableOnExit` to false after the
 *   exit hook has already been removed. The durable record is left claiming `running` on a stopped
 *   runtime that can no longer write a terminal, even at process exit.
 *
 * Only setInterval/clearInterval are faked, matching the existing runtime suites. Store reads are
 * gated at the existing ProcessMatrixStorePort; `waitForIdle` is used instead of timing guesses, and
 * every scratch directory is removed even when an assertion fails.
 */
import { mkdtempSync, rmSync } from "node:fs";
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
	type ProcessMatrixRuntimeHandle,
	type ProcessMatrixStorePort,
	startProcessMatrixRuntime,
} from "../src/core/process-matrix/runtime.ts";
import { buildEntryId, readEntry, writeEntry } from "../src/core/process-matrix/store.ts";
import { applyAdoption, beginWindDown } from "../src/core/process-matrix/supervisor.ts";
import { PI_WORKTREE_LANE_ENV } from "../src/core/worktree-sync/runtime.ts";

const POLL_MS = 1_000;
const HEARTBEAT_MS = 5_000;
const GRACE_MS = 60_000;
const PARENT_PID = 424_242;
const NEW_PARENT_PID = 515_151;
const PARENT_SESSION = "parent-session";
const WORKER_SESSION = "worker-write-lifetime-session";
const T0 = Date.parse("2026-07-19T12:00:00.000Z");

interface Gate {
	entered: Promise<void>;
	release(value: ProcessMatrixEntry | undefined): void;
}

interface GatedStore {
	port: ProcessMatrixStorePort;
	hold(entryId: string): Gate;
	/** Every entry handed to `writeEntryIfUnchanged`, in call order. */
	writes: ProcessMatrixEntry[];
}

function gatedStore(): GatedStore {
	const entered = new Map<string, () => void>();
	const resolvers = new Map<string, (value: ProcessMatrixEntry | undefined) => void>();
	const writes: ProcessMatrixEntry[] = [];
	const port: ProcessMatrixStorePort = {
		...localProcessMatrixStore,
		readEntry: async (agentDir: string, entryId: string) => {
			const announce = entered.get(entryId);
			if (!announce) return localProcessMatrixStore.readEntry(agentDir, entryId);
			entered.delete(entryId);
			return new Promise<ProcessMatrixEntry | undefined>((resolve) => {
				announce();
				resolvers.set(entryId, resolve);
			});
		},
		writeEntryIfUnchanged: async (agentDir, entryId, expected, next) => {
			writes.push(next);
			return localProcessMatrixStore.writeEntryIfUnchanged(agentDir, entryId, expected, next);
		},
	};
	return {
		port,
		writes,
		hold(entryId: string): Gate {
			let announce!: () => void;
			const promise = new Promise<void>((resolve) => {
				announce = resolve;
			});
			entered.set(entryId, announce);
			return {
				entered: promise,
				release(value) {
					const resolve = resolvers.get(entryId);
					if (!resolve) throw new Error(`Gate for ${entryId} was never entered`);
					resolvers.delete(entryId);
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
	exitRequests: number;
	store: GatedStore;
	config: ProcessMatrixRuntimeConfig;
	/** Set before start; invoked synchronously from inside the runtime's notice callout. */
	onNotice: (text: string) => void;
}

const cleanups: string[] = [];

function makeHarness(): Harness {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-process-matrix-write-lifetime-"));
	cleanups.push(agentDir);
	const store = gatedStore();
	const harness: Harness = {
		agentDir,
		clock: { ms: T0 },
		livePids: new Set([PARENT_PID]),
		notices: [],
		exitRequests: 0,
		store,
		onNotice: () => {},
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
			// A real host sink runs synchronously here; this is where an operator-driven stop lands.
			harness.onNotice(text);
		},
		requestExit: async () => {
			harness.exitRequests += 1;
		},
		store: store.port,
	};
	return harness;
}

async function settle(rounds = 12): Promise<void> {
	for (let round = 0; round < rounds; round++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function workerEntryId(): string {
	return buildEntryId("worker", WORKER_SESSION);
}

async function readWorkerEntry(harness: Harness): Promise<ProcessMatrixEntry | undefined> {
	return readEntry(harness.agentDir, workerEntryId());
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

/** Drive the runtime into its grace watch by losing the parent. */
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

describe("process-matrix worker write lifetime", () => {
	it("arms no interval when the wind-down notice callout stops the runtime", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitWorkerEntry(harness);
		let stopping: Promise<void> | undefined;
		harness.onNotice = (text) => {
			if (text.includes("Winding down gracefully")) stopping = Promise.resolve(handle.stop());
		};

		await windDown(harness, handle);
		await stopping;
		await handle.waitForIdle();
		await settle();

		expect(harness.notices.some((notice) => notice.includes("Winding down gracefully"))).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		expect(harness.exitRequests).toBe(0);
	});

	it("arms no interval when the adoption notice callout stops the runtime", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitWorkerEntry(harness);
		await windDown(harness, handle);
		const resumable = await readWorkerEntry(harness);
		expect(resumable?.status).toBe("resumable");

		harness.livePids.add(NEW_PARENT_PID);
		await writeEntry(
			harness.agentDir,
			applyAdoption(resumable as ProcessMatrixEntry, {
				parentPid: NEW_PARENT_PID,
				parentSessionId: "new-parent-session",
			}),
		);
		let stopping: Promise<void> | undefined;
		harness.onNotice = (text) => {
			if (text.includes("adopted by a new parent")) stopping = Promise.resolve(handle.stop());
		};

		await vi.advanceTimersByTimeAsync(POLL_MS);
		await handle.waitForIdle();
		await stopping;
		await settle();

		expect(harness.notices.some((notice) => notice.includes("adopted by a new parent"))).toBe(true);
		// Both facts in one diff: the adoption assigned `entry` a RUNNING record before the notice, and
		// the stop re-entered from that notice wrote nothing and removed the exit hook. A stopped
		// runtime must neither hold a live interval nor stay durably claimed as running.
		const afterNoticeStop = await readWorkerEntry(harness);
		expect({ timers: vi.getTimerCount(), durableStatus: afterNoticeStop?.status }).toEqual({
			timers: 0,
			durableStatus: afterNoticeStop?.status === "closed" ? "closed" : "resumable",
		});
		// Either ownership policy outcome is acceptable; an active claim is not.
		expect(["closed", "resumable"]).toContain(afterNoticeStop?.status);
	});

	it("negative control: a cooperative cleanup exits exactly once without self-deadlock", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		await registerLiveParent(harness);
		const handle = await startProcessMatrixRuntime(harness.config);
		const registered = await awaitWorkerEntry(harness);
		await writeEntry(
			harness.agentDir,
			beginWindDown(registered, "user_cleanup", new Date(harness.clock.ms).toISOString()),
		);

		await vi.advanceTimersByTimeAsync(POLL_MS);
		await handle.waitForIdle();
		await settle();

		expect(harness.exitRequests).toBe(1);
		expect(harness.notices.filter((notice) => notice.includes("cooperative cleanup"))).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
		// The cleanup path calls stop() from inside its own watch tick; the handle must still settle.
		await handle.stop();
		await handle.waitForIdle();
	});

	it("negative control: a confirmed adoption survives a later stop and is not reverted", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitWorkerEntry(harness);
		await windDown(harness, handle);
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

		await handle.stop();
		await settle();

		// The adoption was confirmed by this runtime, so stopping must not restore the pre-adoption
		// resumable record; it terminates the confirmed generation instead.
		const afterStop = await readWorkerEntry(harness);
		expect(afterStop?.status).toBe("closed");
		expect(afterStop?.parentPid).toBe(NEW_PARENT_PID);
	});

	it("negative control: a newer generation's record is never rewritten by stop", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitWorkerEntry(harness);
		await windDown(harness, handle);
		const resumable = await readWorkerEntry(harness);

		// Same pid, newer startedAt: a second runtime generation owns this entry now.
		const newer: ProcessMatrixEntry = {
			...(resumable as ProcessMatrixEntry),
			startedAt: new Date(T0 + 60_000).toISOString(),
			heartbeatAt: new Date(T0 + 60_000).toISOString(),
			status: "running",
		};
		await writeEntry(harness.agentDir, newer);

		await handle.stop();
		await settle();

		expect(await readWorkerEntry(harness)).toEqual(newer);
	});

	it("does not act on a cooperative-cleanup directive written by a newer generation", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		await registerLiveParent(harness);
		const handle = await startProcessMatrixRuntime(harness.config);
		const registered = await awaitWorkerEntry(harness);

		// A NEWER generation (same pid, newer startedAt) owns the entry and carries a cleanup directive.
		// The old handle reads it as `fresh` and passes it to persist as `expected`, so the CAS matches
		// on the first try and persist's generation check never runs.
		const newerDirective: ProcessMatrixEntry = {
			...beginWindDown(registered, "user_cleanup", new Date(harness.clock.ms).toISOString()),
			startedAt: new Date(T0 + 60_000).toISOString(),
			heartbeatAt: new Date(T0 + 60_000).toISOString(),
		};
		await writeEntry(harness.agentDir, newerDirective);

		await vi.advanceTimersByTimeAsync(POLL_MS);
		await handle.waitForIdle();
		await settle();

		try {
			expect(await readWorkerEntry(harness)).toEqual(newerDirective);
			expect(harness.notices).toEqual([]);
			expect(harness.exitRequests).toBe(0);
		} finally {
			await handle.stop();
			await settle();
		}
	});

	it("does not act on an adoption directive written by a newer generation", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitWorkerEntry(harness);
		await windDown(harness, handle);
		const resumable = await readWorkerEntry(harness);
		expect(resumable?.status).toBe("resumable");
		const noticesBefore = harness.notices.length;

		// A newer generation records its own adoption by a different live parent.
		harness.livePids.add(NEW_PARENT_PID);
		const newerAdoption: ProcessMatrixEntry = {
			...applyAdoption(resumable as ProcessMatrixEntry, {
				parentPid: NEW_PARENT_PID,
				parentSessionId: "new-parent-session",
			}),
			startedAt: new Date(T0 + 60_000).toISOString(),
			heartbeatAt: new Date(T0 + 60_000).toISOString(),
		};
		await writeEntry(harness.agentDir, newerAdoption);

		await vi.advanceTimersByTimeAsync(POLL_MS);
		await handle.waitForIdle();
		await settle();

		try {
			expect(await readWorkerEntry(harness)).toEqual(newerAdoption);
			expect(harness.notices.slice(noticesBefore)).toEqual([]);
		} finally {
			await handle.stop();
			await settle();
		}
	});

	it("does not adopt a newer generation's entry when the active wind-down CAS falls back", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		const registered = await awaitWorkerEntry(harness);

		// A second runtime generation takes this entry: same pid, newer startedAt. The wind-down CAS
		// below must fail against it, and the fallback re-read identifies ownership by pid ALONE.
		const newer: ProcessMatrixEntry = {
			...registered,
			startedAt: new Date(T0 + 60_000).toISOString(),
			heartbeatAt: new Date(T0 + 60_000).toISOString(),
		};
		await writeEntry(harness.agentDir, newer);

		// First tick: parent lost -> enterWindDown -> CAS fails -> fallback read adopts by pid.
		harness.livePids.delete(PARENT_PID);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await handle.waitForIdle();
		await settle();
		// Second tick: the wound-down write now uses whatever the fallback adopted as `expected`.
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await handle.waitForIdle();
		await settle();

		try {
			// This runtime never owned the newer generation and must not rewrite its record.
			expect(await readWorkerEntry(harness)).toEqual(newer);
		} finally {
			await handle.stop();
			await settle();
		}
	});

	it("negative control: the fallback adopts a same-generation directive and reconciles it", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		await registerLiveParent(harness);
		const handle = await startProcessMatrixRuntime(harness.config);
		const registered = await awaitWorkerEntry(harness);

		// A master writes a cooperative-cleanup directive onto THIS generation's entry: same pid, same
		// startedAt. The CAS fails, and the fallback is exactly how the worker picks the directive up.
		await writeEntry(
			harness.agentDir,
			beginWindDown(registered, "user_cleanup", new Date(harness.clock.ms).toISOString()),
		);

		await vi.advanceTimersByTimeAsync(POLL_MS);
		await handle.waitForIdle();
		await settle();

		const settled = await readWorkerEntry(harness);
		expect(settled?.startedAt).toBe(registered.startedAt);
		expect(settled?.windDownReason).toBe("user_cleanup");
		expect(harness.exitRequests).toBe(1);
		await handle.stop();
	});

	it("negative control: a stop during the persist fallback read publishes nothing further", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		const registered = await awaitWorkerEntry(harness);
		// Make the wind-down CAS fail so persist takes its fallback re-read path, and hold that read.
		await writeEntry(harness.agentDir, { ...registered, heartbeatAt: new Date(T0 + 1).toISOString() });
		const gate = harness.store.hold(workerEntryId());

		harness.livePids.delete(PARENT_PID);
		await vi.advanceTimersByTimeAsync(POLL_MS);
		await gate.entered;
		await handle.stop();
		const noticesBefore = harness.notices.length;
		gate.release(await readWorkerEntry(harness));
		await handle.waitForIdle();
		await settle();

		expect(harness.notices.slice(noticesBefore)).toEqual([]);
		expect(harness.exitRequests).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
