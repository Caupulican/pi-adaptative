import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { CollaborationJobStore } from "../src/core/collaboration/job-store.ts";
import { createCollaborationPeerContext } from "../src/core/collaboration/peer-context.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

it.each([false, true])(
	"same-session specialist reuse follows its controller process (restarted=%s)",
	async (restarted) => {
		const f = await collaborationFixture();
		try {
			const start = (launchKey: string) =>
				f.execute({
					action: "fire_task",
					launchKey,
					task: launchKey,
					agents: [{ provider: "pi", name: "builder" }],
				});
			await start("birth");
			const birth = f.store.load("birth");
			f.store.finishTurn(birth.id, birth.agents[0].id, birth.agents[0].turnId, "done", "First result");
			await f.execute({ action: "list_jobs" });
			if (restarted) {
				const exited = spawnSync(process.execPath, ["-p", "process.pid"], { encoding: "utf8" });
				expect(exited.status).toBe(0);
				const stored = f.store.load("birth");
				expect(stored.controller).toBeDefined();
				stored.controller!.parentPid = Number(exited.stdout.trim());
				writeFileSync(f.store.path("birth"), JSON.stringify(stored));
			}
			const result = await start("next");
			expect(result.details).toMatchObject({ job: { id: "birth", agents: [{ turn: 2 }] } });
			const current = new CollaborationJobStore(f.root, "parent").load("birth");
			expect(current.controller).toEqual({
				parentSessionId: "parent",
				parentPid: process.pid,
				generation: restarted ? 2 : 1,
			});
			const peer = createCollaborationPeerContext(f.backend.createWorkspace.mock.calls[0][0].env);
			expect(peer).toBeDefined();
			expect(peer!.parentOwnership.read()).toEqual(current.controller);
			expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
			const before = readFileSync(f.store.path("birth"), "utf8");
			if (restarted) {
				expect(() => f.store.setVariable("birth", "stale", "write")).toThrow(/generation|stale/i);
				expect(readFileSync(f.store.path("birth"), "utf8")).toBe(before);
			} else {
				f.store.setVariable("birth", "current", "write");
				expect(f.store.load("birth").variables.current).toBe("write");
			}
		} finally {
			await f.cleanup();
		}
	},
);
