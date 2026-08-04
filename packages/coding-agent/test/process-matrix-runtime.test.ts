import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentIdentityContract, AgentResumeContext } from "../src/core/orchestration/contracts.ts";
import type { ProcessMatrixEntry } from "../src/core/process-matrix/codes.ts";
import {
	getOrchestrationAgentId,
	getParentPid,
	getParentSessionId,
	getProcessTaskRef,
	PI_ORCHESTRATION_AGENT_ID_ENV,
	PI_PARENT_PID_ENV,
	PI_PARENT_SESSION_ENV,
	PI_TASK_REF_ENV,
	PROCESS_MATRIX_RESUMABLE_RETENTION_MS,
	type ProcessMatrixRuntimeConfig,
	startProcessMatrixRuntime,
} from "../src/core/process-matrix/runtime.ts";
import * as processMatrixStore from "../src/core/process-matrix/store.ts";
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

describe("getOrchestrationAgentId", () => {
	it("returns one trimmed logical identity and rejects empty values", () => {
		expect(getOrchestrationAgentId({ [PI_ORCHESTRATION_AGENT_ID_ENV]: "  worker-1  " })).toBe("worker-1");
		expect(getOrchestrationAgentId({ [PI_ORCHESTRATION_AGENT_ID_ENV]: "   " })).toBeUndefined();
	});
});

describe("getProcessTaskRef", () => {
	it("returns one trimmed task identity and rejects empty values", () => {
		expect(getProcessTaskRef({ [PI_TASK_REF_ENV]: "  goal-1  " })).toBe("goal-1");
		expect(getProcessTaskRef({ [PI_TASK_REF_ENV]: "   " })).toBeUndefined();
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

function agentIdentity(
	sessionId: string,
	options: { agentId?: string; resumeContext?: Partial<AgentResumeContext> } = {},
): AgentIdentityContract {
	return {
		agentId: options.agentId ?? `agent-${sessionId}`,
		resumeContext: {
			provider: "pi",
			sessionId,
			cwd: "/repo",
			resourceProfileNames: [],
			contextPointers: [],
			...options.resumeContext,
		},
	};
}

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
		agent: agentIdentity("runtime-test-session", {
			resumeContext: {
				...(process.env[PI_WORKTREE_LANE_ENV]?.trim()
					? { worktreeLaneKey: process.env[PI_WORKTREE_LANE_ENV]?.trim() }
					: {}),
			},
		}),
		hasUI: false,
		settings: { enabled: true, heartbeatMs: HEARTBEAT_MS, adoptionGraceMs: GRACE_MS, watcherPollMs: POLL_MS },
		isProcessAlive: (pid) => harness.livePids.has(pid),
		now: () => harness.clock.ms,
		notify: (text) => {
			harness.notices.push(text);
		},
		onDiagnostic: (message) => harness.diagnostics.push(message),
		promptConfirm: async (message) => {
			harness.confirmAsks.push(message);
			return harness.confirmAnswers.shift() ?? false;
		},
		requestExit: async () => {
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

async function awaitNotice(harness: Harness, predicate: (notice: string) => boolean): Promise<string> {
	const notices = await awaitState(
		async () => harness.notices,
		(values) => values.some(predicate),
	);
	return notices.find(predicate) as string;
}

function workerEntryId(harness: Harness): string {
	return buildEntryId("worker", harness.config.agent.resumeContext.sessionId);
}

async function readWorkerEntry(harness: Harness): Promise<ProcessMatrixEntry | undefined> {
	return readEntry(harness.agentDir, workerEntryId(harness));
}

async function registerLiveParent(harness: Harness, sessionId: string, pid = PARENT_PID): Promise<void> {
	const at = new Date(harness.clock.ms).toISOString();
	await writeEntry(harness.agentDir, {
		entryId: buildEntryId("master", sessionId),
		role: "master",
		agent: agentIdentity(sessionId),
		pid,
		hostname: "CauDev",
		startedAt: at,
		heartbeatAt: at,
		status: "running",
	});
}

function useWorkerEnv(parentSessionId?: string, laneKey?: string, taskRef?: string): void {
	vi.stubEnv(PI_PARENT_PID_ENV, String(PARENT_PID));
	vi.stubEnv(PI_PARENT_SESSION_ENV, parentSessionId ?? "");
	vi.stubEnv(PI_WORKTREE_LANE_ENV, laneKey ?? "");
	vi.stubEnv(PI_TASK_REF_ENV, taskRef ?? "");
}

function useMasterEnv(): void {
	vi.stubEnv(PI_PARENT_PID_ENV, "");
	vi.stubEnv(PI_PARENT_SESSION_ENV, "");
	vi.stubEnv(PI_WORKTREE_LANE_ENV, "");
	vi.stubEnv(PI_TASK_REF_ENV, "");
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
		await handle.stop();
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
			agent: harness.config.agent,
		});

		await tick(POLL_MS * 3);
		const stillRunning = await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry?.status === "running",
		);
		expect(stillRunning?.status).toBe("running");
		expect(harness.notices).toEqual([]);
		expect(harness.exitRequests).toBe(0);
		await handle.stop();
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
		expect(await awaitNotice(harness, (notice) => notice.includes("parent process"))).toContain("parent process");
		await handle.stop();
	});

	it("parent death winds down gracefully -- never silently -- leaving a lane-tagged resumable payload", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv("parent-session-1", "lane-alpha", "goal-1");
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
			resumable: { lastCode: "resumable", agent: harness.config.agent },
		});
		await awaitNotice(harness, (notice) => notice.includes(`pid ${PARENT_PID}`) && notice.includes("resumable"));
		expect(harness.notices).toHaveLength(1);
		expect(harness.notices[0]).toContain(`pid ${PARENT_PID}`);
		expect(harness.notices[0]).toContain("resumable");
		// Grace window: wound down but NOT exited yet.
		expect(harness.exitRequests).toBe(0);
		await handle.stop();
	});

	it("persists the exact logical-agent resume context when the parent disappears", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv("parent-session-1", "lane-alpha", "goal-1");
		const resumeContext = {
			provider: "pi" as const,
			sessionId: "worker-session-1",
			sessionDir: "/agent/sessions",
			sessionFile: "/agent/sessions/worker-session-1.jsonl",
			cwd: "/repo/lane-alpha",
			worktreeLaneKey: "lane-alpha",
			orchestrationProfileId: "fast-worker",
			resourceProfileNames: ["worker-minimal"],
			modelRef: "faux/fast",
			contextPointers: [],
		};
		const harness = makeHarness({
			agent: { agentId: "agent-worker-1", resumeContext },
			taskRef: "ignored-config-task-ref",
			taskSummary: "Finish the scoped implementation",
		});
		const handle = await startProcessMatrixRuntime(harness.config);
		harness.livePids.delete(PARENT_PID);
		await tick(POLL_MS);

		const entry = await awaitState(
			() => readWorkerEntry(harness),
			(value) => value?.status === "resumable",
		);
		expect(entry?.agent).toEqual({ agentId: "agent-worker-1", resumeContext });
		expect(entry?.taskRef).toBe("goal-1");
		expect(entry?.taskSummary).toBe("Finish the scoped implementation");
		expect(entry?.resumable).toMatchObject({
			agent: { agentId: "agent-worker-1", resumeContext },
			taskRef: "goal-1",
			taskSummary: "Finish the scoped implementation",
		});
		await handle.stop();
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
		await awaitNotice(harness, (notice) => notice.includes(`pid ${NEW_PARENT_PID}`));
		expect(harness.exitRequests).toBe(0);

		// The healthy watch now tracks the NEW parent: its death triggers a second wind-down.
		harness.livePids.delete(NEW_PARENT_PID);
		await tick(POLL_MS);
		const rewoundDown = await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry?.status === "resumable" && entry?.windDownReason === "parent_lost",
		);
		expect(rewoundDown).toMatchObject({ status: "resumable", windDownReason: "parent_lost" });
		await awaitNotice(harness, (notice) => notice.includes(`pid ${NEW_PARENT_PID}`) && notice.includes("gone"));
		await handle.stop();
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
		await handle.stop();
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
			(entry) => entry?.status === "closed",
		);
		expect(woundDown).toMatchObject({ status: "closed", windDownReason: "user_cleanup" });
		await awaitNotice(harness, (notice) => notice.includes("cooperative cleanup"));
		await awaitState(
			async () => harness.exitRequests,
			(count) => count === 1,
		);
		expect(harness.exitRequests).toBe(1);

		await tick(POLL_MS * 3);
		expect(harness.exitRequests).toBe(1);
		await handle.stop();
	});

	it("honors cooperative cleanup during the adoption grace window and replaces resumable state with terminal state", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv("parent-session-1");
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);

		await tick(POLL_MS);
		const resumable = (await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry?.status === "resumable",
		)) as ProcessMatrixEntry;
		await writeEntry(
			harness.agentDir,
			beginWindDown(resumable, "user_cleanup", new Date(harness.clock.ms).toISOString()),
		);

		await tick(POLL_MS);
		const closed = await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry?.status === "closed",
		);
		expect(closed).toMatchObject({ status: "closed", windDownReason: "user_cleanup" });
		expect(harness.exitRequests).toBe(1);
		await handle.stop();
	});

	it("stop() halts the watch: a later parent death is no longer observed", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		await settle();

		await handle.stop();
		harness.livePids.delete(PARENT_PID);
		await tick(POLL_MS * 3);

		expect((await readWorkerEntry(harness))?.status).toBe("closed");
		expect(harness.notices).toEqual([]);
		expect(harness.exitRequests).toBe(0);
	});

	it("an older worker exit cannot close a newer same-session process generation", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useWorkerEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		const registered = await awaitState(
			() => readWorkerEntry(harness),
			(entry) => entry !== undefined,
		);
		const newer = {
			...(registered as ProcessMatrixEntry),
			pid: 919_191,
			startedAt: new Date(T0 + 1).toISOString(),
			heartbeatAt: new Date(T0 + 1).toISOString(),
		};
		await writeEntry(harness.agentDir, newer);

		await handle.stop();

		expect(await readWorkerEntry(harness)).toEqual(newer);
	});
});

describe("startProcessMatrixRuntime (master branch)", () => {
	function orphanEntry(): ProcessMatrixEntry {
		return {
			entryId: buildEntryId("worker", "orphan-session"),
			role: "worker",
			agent: agentIdentity("orphan-session", {
				resumeContext: { cwd: "/repo/lane-omega", worktreeLaneKey: "lane-omega" },
			}),
			pid: 616_161,
			hostname: "host-a",
			startedAt: new Date(T0).toISOString(),
			heartbeatAt: new Date(T0).toISOString(),
			status: "running",
			parentPid: 717_171, // never in livePids -> provably dead
			parentSessionId: "dead-parent-session",
		};
	}

	it("registers a master entry and heartbeats it on the configured cadence", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		const entryId = buildEntryId("master", harness.config.agent.resumeContext.sessionId);
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
		await handle.stop();
	});

	it("an older master heartbeat and stop cannot overwrite a newer same-session process generation", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness();
		const handle = await startProcessMatrixRuntime(harness.config);
		const entryId = buildEntryId("master", harness.config.agent.resumeContext.sessionId);
		const registered = await awaitState(
			() => readEntry(harness.agentDir, entryId),
			(entry) => entry !== undefined,
		);
		const newer = {
			...(registered as ProcessMatrixEntry),
			pid: 919_191,
			startedAt: new Date(T0 + 1).toISOString(),
			heartbeatAt: new Date(T0 + 1).toISOString(),
		};
		await writeEntry(harness.agentDir, newer);

		harness.clock.ms = T0 + HEARTBEAT_MS;
		await tick(HEARTBEAT_MS);
		await awaitState(
			async () => harness.diagnostics,
			(diagnostics) => diagnostics.some((message) => message.includes("ownership moved")),
		);
		await handle.stop();

		expect(await readEntry(harness.agentDir, entryId)).toEqual(newer);
	});

	it("orphan scan without a UI is report-only: a diagnostic names the orphan, nothing is written, nobody is asked", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness({ hasUI: false });
		const orphan = orphanEntry();
		harness.livePids.add(orphan.pid);
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
		await handle.stop();
	});

	it("prunes terminal and expired records while retaining fresh resumable recovery state", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness({ hasUI: false });
		const base = orphanEntry();
		const closed = { ...base, entryId: buildEntryId("worker", "closed-worker"), status: "closed" as const };
		closed.agent = agentIdentity("closed-worker");
		const expired = {
			...base,
			entryId: buildEntryId("worker", "expired-worker"),
			agent: agentIdentity("expired-worker"),
			status: "resumable" as const,
			heartbeatAt: new Date(T0 - PROCESS_MATRIX_RESUMABLE_RETENTION_MS - 1).toISOString(),
			resumable: {
				lastCode: "resumable" as const,
				agent: agentIdentity("expired-worker"),
			},
		};
		const fresh = {
			...base,
			entryId: buildEntryId("worker", "fresh-worker"),
			agent: agentIdentity("fresh-worker"),
			status: "resumable" as const,
			resumable: {
				lastCode: "resumable" as const,
				agent: agentIdentity("fresh-worker"),
			},
		};
		await Promise.all([
			writeEntry(harness.agentDir, closed),
			writeEntry(harness.agentDir, expired),
			writeEntry(harness.agentDir, fresh),
		]);

		const handle = await startProcessMatrixRuntime(harness.config);
		const entries = await awaitState(
			() => listEntries(harness.agentDir),
			(value) => !value.some((entry) => entry.entryId === closed.entryId || entry.entryId === expired.entryId),
		);

		expect(entries.some((entry) => entry.entryId === fresh.entryId)).toBe(true);
		await awaitState(
			async () => harness.diagnostics,
			(diagnostics) => diagnostics.some((text) => text.includes("pruned 2")),
		);
		await handle.stop();
	});

	it("headless resume automatically re-adopts a live worker owned by this exact session", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness({ hasUI: false });
		const orphan = {
			...orphanEntry(),
			parentSessionId: harness.config.agent.resumeContext.sessionId,
		};
		harness.livePids.add(orphan.pid);
		await writeEntry(harness.agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		const adopted = await awaitState(
			() => readEntry(harness.agentDir, orphan.entryId),
			(entry) => entry?.status === "running" && entry.parentPid === process.pid,
		);

		expect(adopted?.parentSessionId).toBe(harness.config.agent.resumeContext.sessionId);
		expect(harness.confirmAsks).toEqual([]);
		expect(harness.diagnostics.some((text) => text.includes("report-only"))).toBe(false);
		await handle.stop();
	});

	it("headless resume repairs and relaunches an exact worker interrupted before its resumable write", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {});
		const resumeWorker = vi.fn(async () => ({ started: true as const, pid: 818_181, completion }));
		const harness = makeHarness({ hasUI: false, resumeWorker, taskRef: "goal-1" });
		const base = orphanEntry();
		const orphan = {
			...base,
			parentSessionId: harness.config.agent.resumeContext.sessionId,
			taskRef: "goal-1",
			taskSummary: "Finish goal 1",
		};
		await writeEntry(harness.agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitState(
			async () => resumeWorker.mock.calls.length,
			(count) => count === 1,
		);

		expect(resumeWorker).toHaveBeenCalledWith({
			lastCode: "resumable",
			agent: orphan.agent,
			taskRef: "goal-1",
			taskSummary: "Finish goal 1",
		});
		expect(harness.confirmAsks).toEqual([]);
		expect(harness.diagnostics.some((text) => text.includes("recovered 1 interrupted Pi worker"))).toBe(true);
		expect(await readEntry(harness.agentDir, orphan.entryId)).toMatchObject({
			status: "running",
			parentPid: process.pid,
			parentSessionId: harness.config.agent.resumeContext.sessionId,
		});
		await handle.stop();
	});

	it("does not automatically recover an exact-session worker from another goal", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const resumeWorker = vi.fn();
		const harness = makeHarness({ hasUI: false, resumeWorker, taskRef: "goal-new" });
		const orphan = {
			...orphanEntry(),
			parentSessionId: harness.config.agent.resumeContext.sessionId,
			taskRef: "goal-old",
		};
		harness.livePids.add(orphan.pid);
		await writeEntry(harness.agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitState(
			async () => harness.diagnostics,
			(diagnostics) => diagnostics.some((message) => message.includes("task identity")),
		);

		expect(resumeWorker).not.toHaveBeenCalled();
		expect(harness.confirmAsks).toEqual([]);
		expect(await readEntry(harness.agentDir, orphan.entryId)).toEqual(orphan);
		await handle.stop();
	});

	it("does not automatically recover workers when the current goal is terminal", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness({
			hasUI: false,
			taskRef: "goal-1",
			allowAutomaticRecovery: false,
		});
		const orphan = {
			...orphanEntry(),
			parentSessionId: harness.config.agent.resumeContext.sessionId,
			taskRef: "goal-1",
		};
		harness.livePids.add(orphan.pid);
		await writeEntry(harness.agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitState(
			async () => harness.diagnostics,
			(diagnostics) => diagnostics.some((message) => message.includes("current goal state")),
		);

		expect(await readEntry(harness.agentDir, orphan.entryId)).toEqual(orphan);
		await handle.stop();
	});

	it("persists a terminal handoff after owner-session shutdown and delivers it on resume", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		let finish!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
		const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			finish = resolve;
		});
		const resumeWorker = vi.fn(async () => ({ started: true as const, pid: 818_181, completion }));
		const harness = makeHarness({ hasUI: false, resumeWorker, taskRef: "goal-1" });
		const base = orphanEntry();
		const orphan: ProcessMatrixEntry = {
			...base,
			status: "resumable",
			parentSessionId: harness.config.agent.resumeContext.sessionId,
			taskRef: "goal-1",
			resumable: { lastCode: "resumable", agent: base.agent, taskRef: "goal-1" },
		};
		await writeEntry(harness.agentDir, orphan);

		const firstHandle = await startProcessMatrixRuntime(harness.config);
		await awaitState(
			async () => resumeWorker.mock.calls.length,
			(count) => count === 1,
		);
		await firstHandle.stop();
		finish({ code: 0, signal: null });
		const pending = await awaitState(
			() => readEntry(harness.agentDir, orphan.entryId),
			(entry) => entry?.terminal !== undefined,
		);
		expect(pending?.terminal?.notificationDeliveredAt).toBeUndefined();
		expect(harness.notices).toEqual([]);

		const secondHandle = await startProcessMatrixRuntime(harness.config);
		const delivered = await awaitState(
			() => readEntry(harness.agentDir, orphan.entryId),
			(entry) => entry?.terminal?.notificationDeliveredAt !== undefined,
		);
		expect(delivered?.terminal).toMatchObject({ code: 0, signal: null });
		expect(harness.notices.some((notice) => notice.includes("terminal process state"))).toBe(true);
		await secondHandle.stop();
	});

	it("does not overwrite a newer worker when terminal acknowledgement races self-registration", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		let signalNotification!: () => void;
		let releaseNotification!: () => void;
		const notificationStarted = new Promise<void>((resolve) => {
			signalNotification = resolve;
		});
		const notificationGate = new Promise<void>((resolve) => {
			releaseNotification = resolve;
		});
		let harness!: Harness;
		harness = makeHarness({
			notify: async (text) => {
				signalNotification();
				await notificationGate;
				harness.notices.push(text);
			},
		});
		const base = orphanEntry();
		const pending: ProcessMatrixEntry = {
			...base,
			status: "closed",
			parentSessionId: harness.config.agent.resumeContext.sessionId,
			terminal: { code: 0, signal: null, observedAt: new Date(T0).toISOString() },
		};
		await writeEntry(harness.agentDir, pending);

		const handle = await startProcessMatrixRuntime(harness.config);
		await notificationStarted;
		const newer: ProcessMatrixEntry = {
			...base,
			pid: 919_191,
			status: "running",
			parentSessionId: harness.config.agent.resumeContext.sessionId,
		};
		await writeEntry(harness.agentDir, newer);
		releaseNotification();
		await awaitState(
			async () => harness.diagnostics,
			(diagnostics) => diagnostics.some((message) => message.includes("changed before acknowledgement")),
		);

		expect(await readEntry(harness.agentDir, pending.entryId)).toEqual(newer);
		await handle.stop();
	});

	it("orphan scan with an owner-confirmed adoption writes this master in as the orphan's new parent", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness({ hasUI: true });
		harness.confirmAnswers.push(true); // adopt?
		const orphan = orphanEntry();
		harness.livePids.add(orphan.pid);
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
			parentSessionId: harness.config.agent.resumeContext.sessionId,
		});
		await handle.stop();
	});

	it("stop fences a pending owner prompt before it can write an adoption", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		let answer!: (confirmed: boolean) => void;
		const promptConfirm = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					answer = resolve;
				}),
		);
		const harness = makeHarness({ hasUI: true, promptConfirm });
		const orphan = orphanEntry();
		harness.livePids.add(orphan.pid);
		await writeEntry(harness.agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitState(
			async () => promptConfirm.mock.calls.length,
			(count) => count === 1,
		);
		const stopped = Promise.resolve(handle.stop());
		answer(true);
		await stopped;

		expect(await readEntry(harness.agentDir, orphan.entryId)).toEqual(orphan);
	});

	it("orphan scan with adoption declined but cleanup confirmed writes a user_cleanup wind-down request", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness({ hasUI: true });
		harness.confirmAnswers.push(false, true); // adopt? no -- clean up? yes
		const orphan = orphanEntry();
		harness.livePids.add(orphan.pid);
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
		await handle.stop();
	});

	it("orphan scan with both asks declined leaves the orphan entry untouched", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		const harness = makeHarness({ hasUI: true });
		harness.confirmAnswers.push(false, false);
		const orphan = orphanEntry();
		harness.livePids.add(orphan.pid);
		await writeEntry(harness.agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitState(
			async () => harness.confirmAsks,
			(asks) => asks.length >= 2,
		);

		expect(harness.confirmAsks).toHaveLength(2);
		expect(await readEntry(harness.agentDir, orphan.entryId)).toEqual(orphan);
		await handle.stop();
	});

	it("relaunches a dead resumable logical agent and notifies the new parent on its terminal process event", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		let finish!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
		const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			finish = resolve;
		});
		const resumeWorker = vi.fn(async () => ({ started: true as const, pid: 818_181, completion }));
		const harness = makeHarness({ hasUI: true, resumeWorker });
		harness.confirmAnswers.push(true);
		const resumeContext = {
			provider: "pi" as const,
			sessionId: "orphan-session",
			sessionDir: "/agent/sessions",
			cwd: "/repo/lane-omega",
			worktreeLaneKey: "lane-omega",
			orchestrationProfileId: "fast-worker",
			resourceProfileNames: [],
			contextPointers: [],
		};
		const orphan = {
			...orphanEntry(),
			status: "resumable" as const,
			agent: { agentId: "logical-agent-1", resumeContext },
			resumable: {
				lastCode: "resumable" as const,
				agent: { agentId: "logical-agent-1", resumeContext },
				taskSummary: "Finish the worker task",
			},
		};
		await writeEntry(harness.agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitState(
			async () => resumeWorker.mock.calls.length,
			(count) => count === 1,
		);
		expect(resumeWorker).toHaveBeenCalledWith(orphan.resumable);
		expect(await readEntry(harness.agentDir, orphan.entryId)).toMatchObject({
			status: "running",
			parentPid: process.pid,
			parentSessionId: harness.config.agent.resumeContext.sessionId,
		});

		finish({ code: 0, signal: null });
		const terminal = await awaitState(
			() => readEntry(harness.agentDir, orphan.entryId),
			(entry) => entry?.terminal?.notificationDeliveredAt !== undefined,
		);
		expect(terminal).toMatchObject({
			status: "closed",
			terminal: { code: 0, signal: null, notificationDeliveredAt: expect.any(String) },
		});
		expect(await awaitNotice(harness, (notice) => notice.includes("logical-agent-1"))).toContain("terminal");
		await handle.stop();
	});

	it("ignores a stale replacement terminal event after a newer worker has claimed the logical entry", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		let finish!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
		const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			finish = resolve;
		});
		const launchedPid = 818_181;
		const replacementPid = 919_191;
		const resumeWorker = vi.fn(async () => ({ started: true as const, pid: launchedPid, completion }));
		const harness = makeHarness({ hasUI: false, resumeWorker, taskRef: "goal-1" });
		const base = orphanEntry();
		const orphan: ProcessMatrixEntry = {
			...base,
			status: "resumable",
			parentSessionId: harness.config.agent.resumeContext.sessionId,
			taskRef: "goal-1",
			resumable: { lastCode: "resumable", agent: base.agent, taskRef: "goal-1" },
		};
		await writeEntry(harness.agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitState(
			() => readEntry(harness.agentDir, orphan.entryId),
			(entry) => entry?.pid === launchedPid,
		);
		const newerReplacement = {
			...(await readEntry(harness.agentDir, orphan.entryId)),
			pid: replacementPid,
		};
		await writeEntry(harness.agentDir, newerReplacement as ProcessMatrixEntry);

		finish({ code: 0, signal: null });
		await awaitState(
			async () => harness.diagnostics,
			(diagnostics) => diagnostics.some((message) => message.includes("ignored stale terminal handoff")),
		);

		const current = await readEntry(harness.agentDir, orphan.entryId);
		expect(current).toMatchObject({
			status: "running",
			pid: replacementPid,
		});
		expect(current?.terminal).toBeUndefined();
		expect(harness.notices).toEqual([]);
		await handle.stop();
	});

	it("persists terminal state from a replacement that self-registers before launcher bookkeeping", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		let finish!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
		const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			finish = resolve;
		});
		const launchedPid = 818_181;
		const replacementStartedAt = "2026-07-19T12:01:00.000Z";
		let agentDir = "";
		let entryId = "";
		const resumeWorker = vi.fn(async () => {
			const claimed = await readEntry(agentDir, entryId);
			expect(claimed).toBeDefined();
			await writeEntry(agentDir, {
				...(claimed as ProcessMatrixEntry),
				pid: launchedPid,
				startedAt: replacementStartedAt,
				heartbeatAt: replacementStartedAt,
			});
			return { started: true as const, pid: launchedPid, completion };
		});
		const harness = makeHarness({ hasUI: false, resumeWorker, taskRef: "goal-1" });
		const base = orphanEntry();
		const orphan: ProcessMatrixEntry = {
			...base,
			status: "resumable",
			parentSessionId: harness.config.agent.resumeContext.sessionId,
			taskRef: "goal-1",
			resumable: { lastCode: "resumable", agent: base.agent, taskRef: "goal-1" },
		};
		agentDir = harness.agentDir;
		entryId = orphan.entryId;
		await writeEntry(agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitState(
			() => readEntry(agentDir, entryId),
			(entry) => entry?.startedAt === replacementStartedAt,
		);
		finish({ code: 0, signal: null });

		const terminal = await awaitState(
			() => readEntry(agentDir, entryId),
			(entry) => entry?.terminal?.code === 0,
		);
		expect(terminal).toMatchObject({
			pid: launchedPid,
			startedAt: replacementStartedAt,
			status: "closed",
			terminal: { code: 0, signal: null },
		});
		await handle.stop();
	});

	it("persists a terminal handoff when recording the launched pid fails before worker self-registration", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		let finish!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
		const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			finish = resolve;
		});
		const launchedPid = 818_181;
		const resumeWorker = vi.fn(async () => ({ started: true as const, pid: launchedPid, completion }));
		const harness = makeHarness({ hasUI: false, resumeWorker, taskRef: "goal-1" });
		const base = orphanEntry();
		const orphan: ProcessMatrixEntry = {
			...base,
			status: "resumable",
			parentSessionId: harness.config.agent.resumeContext.sessionId,
			taskRef: "goal-1",
			resumable: { lastCode: "resumable", agent: base.agent, taskRef: "goal-1" },
		};
		await writeEntry(harness.agentDir, orphan);
		const originalWriteEntryIfUnchanged = processMatrixStore.writeEntryIfUnchanged;
		let failLaunchedPidWrite = true;
		vi.spyOn(processMatrixStore, "writeEntryIfUnchanged").mockImplementation(
			async (agentDir, entryId, expected, next) => {
				if (
					failLaunchedPidWrite &&
					entryId === orphan.entryId &&
					next.pid === launchedPid &&
					next.status === "running"
				) {
					failLaunchedPidWrite = false;
					throw new Error("injected pid-record write failure");
				}
				return originalWriteEntryIfUnchanged(agentDir, entryId, expected, next);
			},
		);

		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitState(
			async () => harness.diagnostics,
			(diagnostics) => diagnostics.some((message) => message.includes("failed to record resumed worker pid")),
		);
		finish({ code: 7, signal: null });

		const terminal = await awaitState(
			() => readEntry(harness.agentDir, orphan.entryId),
			(entry) => entry?.terminal?.code === 7 && entry.terminal.notificationDeliveredAt !== undefined,
		);
		expect(terminal).toMatchObject({ pid: launchedPid, status: "closed", terminal: { code: 7, signal: null } });
		await awaitNotice(harness, (notice) => notice.includes("terminal process state"));
		await handle.stop();
	});

	it("preserves an undelivered terminal handoff when owner shutdown wins immediately after spawn", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		useMasterEnv();
		let launch!: (outcome: {
			started: true;
			pid: number;
			completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
		}) => void;
		let finish!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
		const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			finish = resolve;
		});
		const launchedPid = 818_181;
		const resumeWorker = vi.fn(
			() =>
				new Promise<{
					started: true;
					pid: number;
					completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
				}>((resolve) => {
					launch = resolve;
				}),
		);
		const harness = makeHarness({ hasUI: false, resumeWorker, taskRef: "goal-1" });
		const base = orphanEntry();
		const orphan: ProcessMatrixEntry = {
			...base,
			status: "resumable",
			parentSessionId: harness.config.agent.resumeContext.sessionId,
			taskRef: "goal-1",
			resumable: { lastCode: "resumable", agent: base.agent, taskRef: "goal-1" },
		};
		await writeEntry(harness.agentDir, orphan);

		const handle = await startProcessMatrixRuntime(harness.config);
		await awaitState(
			async () => resumeWorker.mock.calls.length,
			(count) => count === 1,
		);
		const stopped = Promise.resolve(handle.stop());
		launch({ started: true, pid: launchedPid, completion });
		await stopped;
		finish({ code: 7, signal: null });

		const terminal = await awaitState(
			() => readEntry(harness.agentDir, orphan.entryId),
			(entry) => entry?.terminal?.code === 7,
		);
		expect(terminal).toMatchObject({ pid: launchedPid, status: "closed", terminal: { code: 7, signal: null } });
		expect(terminal?.terminal?.notificationDeliveredAt).toBeUndefined();
		expect(harness.notices).toEqual([]);
		expect(harness.diagnostics.some((message) => message.includes("launched after owner shutdown"))).toBe(true);
	});
});
