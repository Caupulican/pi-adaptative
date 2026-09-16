import { isDeepStrictEqual } from "node:util";
import { expect, it, vi } from "vitest";
import type { AgentIdentityContract } from "../src/core/orchestration/contracts.ts";
import type { ProcessMatrixEntry } from "../src/core/process-matrix/codes.ts";
import {
	PI_PARENT_PID_ENV,
	PI_PARENT_SESSION_ENV,
	type ProcessMatrixStorePort,
	startProcessMatrixRuntime,
} from "../src/core/process-matrix/runtime.ts";
import { buildEntryId } from "../src/core/process-matrix/store.ts";

it.each(["different-pid", "same-pid", "invalid-master", "stale-generation", "stopped"])(
	"authenticated parent ownership handles %s without losing the retained worker",
	async (action) => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		vi.stubEnv(PI_PARENT_PID_ENV, "101");
		vi.stubEnv(PI_PARENT_SESSION_ENV, "birth-parent");
		const at = "2026-09-16T00:00:00.000Z";
		const records = new Map<string, ProcessMatrixEntry>();
		const identity = (sessionId: string): AgentIdentityContract => ({
			agentId: sessionId,
			resumeContext: { provider: "pi", sessionId, cwd: "/repo", resourceProfileNames: [], contextPointers: [] },
		});
		const installParent = (sessionId: string, pid: number, valid = true) =>
			records.set(buildEntryId("master", sessionId), {
				entryId: buildEntryId("master", sessionId),
				role: "master",
				agent: identity(valid ? sessionId : "foreign"),
				pid,
				hostname: "fixture",
				startedAt: at,
				heartbeatAt: at,
				status: "running",
			});
		installParent("birth-parent", 101);
		const parentPid = action === "same-pid" ? 101 : 202;
		installParent("next-parent", parentPid, action !== "invalid-master");
		const write = (expected: ProcessMatrixEntry | undefined, next: ProcessMatrixEntry) => {
			if (!isDeepStrictEqual(records.get(next.entryId), expected)) return false;
			records.set(next.entryId, structuredClone(next));
			return true;
		};
		const store: ProcessMatrixStorePort = {
			listEntries: async () => structuredClone([...records.values()]),
			readEntry: async (_root, id) => structuredClone(records.get(id)),
			writeEntry: async (_root, entry) => {
				records.set(entry.entryId, structuredClone(entry));
			},
			writeEntryIfUnchanged: async (_root, _id, expected, next) => write(expected, next),
			writeEntryIfUnchangedSync: (_root, expected, next) => write(expected, next),
			removeEntryIfUnchanged: async (_root, entry) => {
				if (!isDeepStrictEqual(records.get(entry.entryId), entry)) return false;
				return records.delete(entry.entryId);
			},
		};
		let owner = { parentSessionId: "birth-parent", parentPid: 101, generation: 1 };
		let changed: (() => void) | undefined;
		const unsubscribe = vi.fn();
		const requestExit = vi.fn(async () => {});
		const notices: string[] = [];
		const config = {
			agentDir: "/fixture",
			agent: identity("worker"),
			store,
			settings: { enabled: true, heartbeatMs: 5000, watcherPollMs: 1000, adoptionGraceMs: 60000 },
			observeProcess: () => "alive" as const,
			now: () => Date.parse(at),
			notify: (message: string) => {
				notices.push(message);
			},
			requestExit,
			parentOwnership: {
				read: () => owner,
				subscribe: (listener: () => void) => {
					changed = listener;
					return unsubscribe;
				},
			},
		};
		const handle = await startProcessMatrixRuntime(config);
		try {
			if (action === "stopped") await handle.stop();
			owner = { parentSessionId: "next-parent", parentPid, generation: action === "stale-generation" ? 1 : 2 };
			changed?.();
			await handle.waitForIdle();
			const record = records.get(buildEntryId("worker", "worker"))!;
			if (action === "different-pid" || action === "same-pid") {
				expect(record).toMatchObject({ parentSessionId: "next-parent", parentPid, status: "running" });
				records.delete(buildEntryId("master", "birth-parent"));
				await vi.advanceTimersByTimeAsync(1000);
				await handle.waitForIdle();
				expect(records.get(record.entryId)?.status).toBe("running");
			} else {
				expect(record).toMatchObject({
					parentSessionId: "birth-parent",
					parentPid: 101,
					status: action === "stopped" ? "closed" : "running",
				});
			}
			expect(notices.some((message) => message.includes("Winding down"))).toBe(false);
			expect(requestExit).not.toHaveBeenCalled();
		} finally {
			await handle.stop();
			vi.useRealTimers();
			vi.unstubAllEnvs();
		}
	},
);
