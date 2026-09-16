/**
 * Terminal handoff for a RESUMED worker: whose record may an exit report close?
 *
 * A master that resumes a dead worker claims its entry, launches a replacement and records the new
 * pid. The replacement then registers itself, which legitimately moves `startedAt` -- so a changed
 * timestamp alone can never be the fence. What the exit report is allowed to close is the entry that
 * still belongs to the launch this master performed.
 *
 * Everything runs through the public master runtime with an owned in-memory store and a controlled
 * launch completion: no real processes, no orphan actions, no polling of output.
 *
 * The terminal handoff is fire-and-forget inside the runtime (`waitForIdle` does not track it), so
 * these cases wait on the handoff's own OBSERVABLE ends instead of a readiness delay: the store
 * signals when a terminal acknowledgement is persisted, and the runtime's diagnostic sink signals an
 * explicit stale-handoff rejection. Baseline behaviour reaches the first; a corrected owner reaches
 * the second; a persistence or delivery failure rejects the gate instead of hanging.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentIdentityContract } from "../src/core/orchestration/contracts.ts";
import type { ProcessMatrixEntry } from "../src/core/process-matrix/codes.ts";
import {
	type ProcessMatrixRuntimeConfig,
	type ProcessMatrixRuntimeHandle,
	type ProcessMatrixStorePort,
	startProcessMatrixRuntime,
} from "../src/core/process-matrix/runtime.ts";

const MASTER_SESSION = "resume-ownership-master";
const WORKER_SESSION = "resume-ownership-worker";
const FOREIGN_SESSION = "resume-ownership-foreign-master";
const TASK_REF = "task:resume-ownership";
const FOREIGN_TASK_REF = "task:someone-elses-goal";
const DEAD_WORKER_PID = 515_151;
const DEAD_PARENT_PID = 616_161;
const FOREIGN_PARENT_PID = 717_171;
const RELAUNCHED_PID = 818_181;
const T0 = Date.parse("2026-08-01T09:00:00.000Z");
const WORKER_ENTRY_ID = "worker-resume-ownership-entry";

/** How the resumed worker's terminal handoff ended, as the runtime itself reported it. */
type HandoffOutcome = "acknowledged" | "rejected_as_stale";

const scratchRoots: string[] = [];

afterEach(() => {
	while (scratchRoots.length > 0) {
		const directory = scratchRoots.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

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

interface OwnedStore extends ProcessMatrixStorePort {
	get(entryId: string): ProcessMatrixEntry | undefined;
	set(entry: ProcessMatrixEntry): void;
}

/** An owned store: the runtime's only storage boundary, with no filesystem behind it. */
function createOwnedStore(
	seed: readonly ProcessMatrixEntry[],
	onWrite: (entry: ProcessMatrixEntry) => void,
): OwnedStore {
	const entries = new Map<string, ProcessMatrixEntry>(seed.map((entry) => [entry.entryId, structuredClone(entry)]));
	const matches = (stored: ProcessMatrixEntry | undefined, expected: ProcessMatrixEntry | undefined): boolean =>
		JSON.stringify(stored) === JSON.stringify(expected);
	const writeIfUnchanged = (
		entryId: string,
		expected: ProcessMatrixEntry | undefined,
		next: ProcessMatrixEntry,
	): boolean => {
		if (!matches(entries.get(entryId), expected)) return false;
		entries.set(entryId, structuredClone(next));
		onWrite(structuredClone(next));
		return true;
	};
	return {
		get: (entryId: string) => entries.get(entryId),
		set: (entry: ProcessMatrixEntry) => {
			entries.set(entry.entryId, structuredClone(entry));
		},
		listEntries: async () => [...entries.values()].map((entry) => structuredClone(entry)),
		readEntry: async (_agentDir: string, entryId: string) => {
			const entry = entries.get(entryId);
			return entry ? structuredClone(entry) : undefined;
		},
		removeEntryIfUnchanged: async (_agentDir: string, entry: ProcessMatrixEntry) => {
			if (!matches(entries.get(entry.entryId), entry)) return false;
			entries.delete(entry.entryId);
			return true;
		},
		writeEntry: async (_agentDir: string, entry: ProcessMatrixEntry) => {
			entries.set(entry.entryId, structuredClone(entry));
			onWrite(structuredClone(entry));
		},
		writeEntryIfUnchanged: async (
			_agentDir: string,
			entryId: string,
			expected: ProcessMatrixEntry | undefined,
			next: ProcessMatrixEntry,
		) => writeIfUnchanged(entryId, expected, next),
		writeEntryIfUnchangedSync: (_agentDir: string, expected: ProcessMatrixEntry, next: ProcessMatrixEntry) =>
			writeIfUnchanged(expected.entryId, expected, next),
	};
}

/** The dead resumable worker this master is entitled to resume. */
function deadResumableWorker(): ProcessMatrixEntry {
	const at = new Date(T0).toISOString();
	const agent = agentIdentity(WORKER_SESSION);
	return {
		entryId: WORKER_ENTRY_ID,
		role: "worker",
		agent,
		pid: DEAD_WORKER_PID,
		hostname: "test-host",
		startedAt: at,
		heartbeatAt: at,
		status: "resumable",
		parentPid: DEAD_PARENT_PID,
		parentSessionId: MASTER_SESSION,
		taskRef: TASK_REF,
		taskSummary: "resume ownership fixture",
		resumable: { agent: structuredClone(agent), taskRef: TASK_REF, lastCode: "resumable" },
	};
}

interface ResumeHarness {
	store: OwnedStore;
	notices: string[];
	diagnostics: string[];
	completeLaunch: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
	/** Settles when the runtime persisted a terminal acknowledgement or rejected the handoff as stale. */
	handoff: Promise<HandoffOutcome>;
	config: ProcessMatrixRuntimeConfig;
}

function createResumeHarness(): ResumeHarness {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-resume-ownership-"));
	scratchRoots.push(agentDir);
	const notices: string[] = [];
	const diagnostics: string[] = [];
	let settleHandoff!: (outcome: HandoffOutcome) => void;
	let failHandoff!: (error: Error) => void;
	const handoff = new Promise<HandoffOutcome>((resolve, reject) => {
		settleHandoff = resolve;
		failHandoff = reject;
	});
	// The acknowledgement write is the last step of a completed handoff; the stale diagnostic is the
	// last step of a refused one. Both are the runtime's own events.
	const store = createOwnedStore([deadResumableWorker()], (entry) => {
		if (entry.entryId === WORKER_ENTRY_ID && entry.terminal?.notificationDeliveredAt) {
			settleHandoff("acknowledged");
		}
	});
	let completeLaunch!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
	const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		completeLaunch = resolve;
	});
	return {
		store,
		notices,
		diagnostics,
		completeLaunch,
		handoff,
		config: {
			agentDir,
			agent: agentIdentity(MASTER_SESSION),
			settings: { enabled: true, heartbeatMs: 3_600_000, adoptionGraceMs: 3_600_000, watcherPollMs: 3_600_000 },
			// Only this master's own pid is alive: the stored worker and its old parent are both gone.
			isProcessAlive: (pid: number) => pid === process.pid,
			now: () => T0,
			notify: (text: string) => {
				notices.push(text);
			},
			onDiagnostic: (message: string) => {
				diagnostics.push(message);
				if (message.includes("ignored stale terminal handoff")) settleHandoff("rejected_as_stale");
				if (message.includes("failed to persist terminal handoff")) failHandoff(new Error(message));
				if (message.includes("failed to deliver terminal handoff")) failHandoff(new Error(message));
			},
			requestExit: async () => {},
			taskRef: TASK_REF,
			store,
			resumeWorker: async () => ({ started: true, pid: RELAUNCHED_PID, completion }),
		},
	};
}

/** The launched record this master actually owns, as the runtime recorded it before the exit. */
function launchedRecord(harness: ResumeHarness): ProcessMatrixEntry {
	const entry = harness.store.get(WORKER_ENTRY_ID);
	if (!entry) throw new Error("the resumed worker entry disappeared");
	expect(entry.pid).toBe(RELAUNCHED_PID);
	expect(entry.parentSessionId).toBe(MASTER_SESSION);
	return entry;
}

describe("process matrix resume ownership", () => {
	it("does not close a same-pid record that a different owner has taken over", async () => {
		const harness = createResumeHarness();
		let runtime: ProcessMatrixRuntimeHandle | undefined;
		try {
			runtime = await startProcessMatrixRuntime(harness.config);
			await runtime.waitForIdle();
			const launched = launchedRecord(harness);

			// The same pid is now running someone else's work: a different parent session, a different
			// parent process and a different task, registered after the launch.
			const foreignOwner: ProcessMatrixEntry = {
				...launched,
				agent: agentIdentity(FOREIGN_SESSION),
				startedAt: new Date(T0 + 5_000).toISOString(),
				heartbeatAt: new Date(T0 + 5_000).toISOString(),
				status: "running",
				parentPid: FOREIGN_PARENT_PID,
				parentSessionId: FOREIGN_SESSION,
				taskRef: FOREIGN_TASK_REF,
			};
			harness.store.set(foreignOwner);

			harness.completeLaunch({ code: 0, signal: null });
			const outcome = await harness.handoff;

			// The old launch's exit says nothing about this record. Closing it would report another
			// owner's live worker as finished and consume its future terminal handoff.
			expect(outcome).toBe("rejected_as_stale");
			const stored = harness.store.get(WORKER_ENTRY_ID);
			expect(stored?.parentSessionId).toBe(FOREIGN_SESSION);
			expect(stored?.taskRef).toBe(FOREIGN_TASK_REF);
			expect(stored?.status).toBe("running");
			expect(stored?.terminal).toBeUndefined();
			expect(harness.notices).toEqual([]);
		} finally {
			await runtime?.stop();
		}
	});

	it("closes the record its own relaunched worker registered for itself", async () => {
		const harness = createResumeHarness();
		let runtime: ProcessMatrixRuntimeHandle | undefined;
		try {
			runtime = await startProcessMatrixRuntime(harness.config);
			await runtime.waitForIdle();
			const launched = launchedRecord(harness);

			// Authentic self-registration: the replacement writes its own entry on startup, which moves
			// `startedAt` while keeping this master's launch identity and the task it was resumed for.
			const selfRegistered: ProcessMatrixEntry = {
				...launched,
				startedAt: new Date(T0 + 5_000).toISOString(),
				heartbeatAt: new Date(T0 + 5_000).toISOString(),
				status: "running",
			};
			harness.store.set(selfRegistered);

			harness.completeLaunch({ code: 0, signal: null });
			const outcome = await harness.handoff;

			// A changed timestamp is not a foreign generation: this is the process this master launched,
			// so its exit closes its own record and the original handoff is preserved.
			expect(outcome).toBe("acknowledged");
			const stored = harness.store.get(WORKER_ENTRY_ID);
			expect(stored?.status).toBe("closed");
			expect(stored?.terminal?.code).toBe(0);
			expect(stored?.pid).toBe(RELAUNCHED_PID);
			expect(stored?.startedAt).toBe(selfRegistered.startedAt);
			expect(stored?.parentSessionId).toBe(MASTER_SESSION);
			expect(stored?.taskRef).toBe(TASK_REF);
			expect(stored?.agent.resumeContext.sessionId).toBe(WORKER_SESSION);
			expect(harness.notices).toHaveLength(1);
			expect(harness.notices[0]).toContain(`agent-${WORKER_SESSION}`);
		} finally {
			await runtime?.stop();
		}
	});

	it("negative control: an untouched launched record is closed by its own exit", async () => {
		const harness = createResumeHarness();
		let runtime: ProcessMatrixRuntimeHandle | undefined;
		try {
			runtime = await startProcessMatrixRuntime(harness.config);
			await runtime.waitForIdle();
			launchedRecord(harness);

			harness.completeLaunch({ code: 3, signal: null });
			const outcome = await harness.handoff;

			// Nothing raced the launch, so the exact compare-and-set owns this transition outright.
			expect(outcome).toBe("acknowledged");
			const stored = harness.store.get(WORKER_ENTRY_ID);
			expect(stored?.status).toBe("closed");
			expect(stored?.terminal?.code).toBe(3);
			expect(stored?.terminal?.notificationDeliveredAt).toBeDefined();
			expect(stored?.parentSessionId).toBe(MASTER_SESSION);
			expect(harness.notices).toHaveLength(1);
		} finally {
			await runtime?.stop();
		}
	});
});
