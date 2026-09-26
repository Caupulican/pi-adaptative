// @isolated: mutates process environment and installs process-exit lifecycle listeners

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentIdentityContract } from "../src/core/orchestration/contracts.ts";
import type { ProcessMatrixEntry } from "../src/core/process-matrix/codes.ts";
import {
	localProcessMatrixStore,
	PI_PARENT_PID_ENV,
	type ProcessMatrixStorePort,
	startProcessMatrixRuntime,
} from "../src/core/process-matrix/runtime.ts";
import { buildWorkerEntry } from "../src/core/process-matrix/supervisor.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function identity(sessionId: string): AgentIdentityContract {
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

function reconciliationEntries(): { closed: ProcessMatrixEntry; recoverable: ProcessMatrixEntry } {
	const now = "2026-09-26T12:00:00.000Z";
	const closed: ProcessMatrixEntry = {
		...buildWorkerEntry({
			agent: identity("closed"),
			pid: 41,
			hostname: "test",
			now,
			parentPid: 40,
		}),
		status: "closed",
	};
	const recoverable = buildWorkerEntry({
		agent: identity("recoverable"),
		pid: 51,
		hostname: "test",
		now,
		parentPid: 50,
	});
	return { closed, recoverable };
}

function runtimeConfig(
	store: ProcessMatrixStorePort,
	diagnostics: string[],
): Parameters<typeof startProcessMatrixRuntime>[0] {
	return {
		agentDir: "/unused/process-matrix-test",
		agent: identity("owner"),
		settings: { enabled: true, heartbeatMs: 60_000, adoptionGraceMs: 60_000, watcherPollMs: 60_000 },
		observeProcess: () => "dead",
		now: () => Date.parse("2026-09-26T12:00:00.000Z"),
		notify: () => {},
		onDiagnostic: (message) => diagnostics.push(message),
		requestExit: async () => {},
		store,
	};
}

async function turn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("process-matrix reconciliation settlement", () => {
	it("does not finish master shutdown while a sibling recovery write remains pending after prune failure", async () => {
		vi.stubEnv(PI_PARENT_PID_ENV, "");
		const { closed, recoverable } = reconciliationEntries();
		const recoveryWrite = deferred<boolean>();
		const pruneFailure = new Error("injected prune failure");
		const diagnostics: string[] = [];
		const store: ProcessMatrixStorePort = {
			...localProcessMatrixStore,
			listEntries: async () => [closed, recoverable],
			readEntry: async () => undefined,
			writeEntry: async () => {},
			writeEntryIfUnchanged: async (_agentDir, entryId) =>
				entryId === recoverable.entryId ? recoveryWrite.promise : true,
			writeEntryIfUnchangedSync: () => true,
			removeEntryIfUnchanged: async () => {
				throw pruneFailure;
			},
		};

		const handle = await startProcessMatrixRuntime(runtimeConfig(store, diagnostics));
		let stopSettled = false;
		const stop = Promise.resolve(handle.stop()).then(() => {
			stopSettled = true;
		});
		try {
			await turn();
			expect(stopSettled).toBe(false);
		} finally {
			recoveryWrite.resolve(true);
			await stop;
		}

		expect(diagnostics).toContain("process-matrix: maintenance failed: injected prune failure");
	});

	it("waits for every reconciliation mutation on the successful control path", async () => {
		vi.stubEnv(PI_PARENT_PID_ENV, "");
		const { closed, recoverable } = reconciliationEntries();
		const recoveryWrite = deferred<boolean>();
		const store: ProcessMatrixStorePort = {
			...localProcessMatrixStore,
			listEntries: async () => [closed, recoverable],
			readEntry: async () => undefined,
			writeEntry: async () => {},
			writeEntryIfUnchanged: async (_agentDir, entryId) =>
				entryId === recoverable.entryId ? recoveryWrite.promise : true,
			writeEntryIfUnchangedSync: () => true,
			removeEntryIfUnchanged: async () => true,
		};

		const handle = await startProcessMatrixRuntime(runtimeConfig(store, []));
		let idleSettled = false;
		const idle = handle.waitForIdle().then(() => {
			idleSettled = true;
		});
		try {
			await turn();
			expect(idleSettled).toBe(false);
		} finally {
			recoveryWrite.resolve(true);
			await idle;
			await handle.stop();
		}
	});
});
