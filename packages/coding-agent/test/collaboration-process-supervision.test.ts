import { watch } from "node:fs";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";
import { CollaborationJobStore } from "../src/core/collaboration/job-store.ts";
import type { ProcessMatrixEntry } from "../src/core/process-matrix/codes.ts";
import { buildEntryId, entryPath, readEntry, writeEntry } from "../src/core/process-matrix/store.ts";
import { SessionSupervisionRuntime } from "../src/core/session-supervision-runtime.ts";
import { canonicalizeWatchDir } from "../src/utils/fs-watch.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";
import { createHarness } from "./suite/harness.ts";

it.each([true, false])(
	"native session supervision observes only authenticated job ownership (token: %s)",
	async (valid) => {
		const f = await collaborationFixture();
		const worker = await createHarness({
			agentDir: f.root,
			cwd: f.root,
			settings: { processMatrix: { enabled: true }, worktreeSync: { enabled: false } },
		});
		const requestExit = vi.fn(async () => {});
		const supervision = new SessionSupervisionRuntime({
			agentDir: f.root,
			isProcessAlive: () => true,
			resumeWorker: async () => ({ started: false, reason: "No process replacement in this test" }),
			onDiagnostic: () => {},
			requestExit,
		});
		let observer: ReturnType<typeof watch> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await f.execute({
				action: "fire_task",
				launchKey: "birth",
				task: "Initial assignment",
				agents: [{ provider: "pi", name: "builder" }],
			});
			const first = f.store.load("birth").agents[0];
			for (const [key, value] of Object.entries(f.backend.createWorkspace.mock.calls[0][0].env ?? {}))
				vi.stubEnv(key, value);
			vi.stubEnv("PI_PARENT_PID", String(process.pid));
			vi.stubEnv("PI_PARENT_SESSION", "parent");
			if (!valid) vi.stubEnv("PI_COLLABORATION_PEER_TOKEN", "0".repeat(64));
			const at = new Date().toISOString();
			for (const sessionId of ["parent", "next-parent"])
				await writeEntry(f.root, {
					entryId: buildEntryId("master", sessionId),
					role: "master",
					pid: process.pid,
					hostname: "fixture",
					startedAt: at,
					heartbeatAt: at,
					status: "running",
					agent: {
						agentId: sessionId,
						resumeContext: {
							provider: "pi",
							sessionId,
							cwd: f.root,
							resourceProfileNames: [],
							contextPointers: [],
						},
					},
				});
			await supervision.start(worker.session);
			const id = buildEntryId("worker", worker.sessionManager.getSessionId());
			expect((await readEntry(f.root, id))?.parentSessionId).toBe("parent");
			const observed = new Promise<ProcessMatrixEntry | undefined>((resolve) => {
				const inspect = () => {
					void readEntry(f.root, id).then((entry) => {
						if (entry?.parentSessionId === "next-parent") resolve(entry);
					});
				};
				observer = watch(canonicalizeWatchDir(dirname(entryPath(f.root, id))), { persistent: false }, inspect);
				timer = setTimeout(() => resolve(undefined), 3000);
				inspect();
			});
			f.store.finishTurn("birth", first.id, first.turnId, "done", "First result");
			await f.execute({ action: "list_jobs" });
			new CollaborationJobStore(f.root, "next-parent").admit(
				{ ...f.store.load("birth"), id: "next", parentSessionId: "next-parent" },
				"Next assignment",
				{},
			);
			const next = await observed;
			if (valid)
				expect(next).toMatchObject({ parentSessionId: "next-parent", parentPid: process.pid, status: "running" });
			else expect(next).toBeUndefined();
			expect(requestExit).not.toHaveBeenCalled();
		} finally {
			if (timer) clearTimeout(timer);
			observer?.close();
			await supervision.stop();
			await worker.cleanup();
			await f.cleanup();
			vi.unstubAllEnvs();
		}
	},
);
