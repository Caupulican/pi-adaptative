import { expect, it, vi } from "vitest";
import { CollaborationJobStore } from "../src/core/collaboration/job-store.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

it.each(["idle", "busy", "different-model"])(
	"a new parent honors the %s managed specialist in the same project",
	async (state) => {
		const f = await collaborationFixture();
		try {
			await f.execute({
				action: "fire_task",
				launchKey: "birth",
				task: "First project assignment",
				agents: [{ provider: "pi", name: "builder", model: "one" }],
			});
			const birth = f.store.load("birth");
			const original = birth.agents[0];
			if (state !== "busy") {
				f.store.finishTurn(birth.id, original.id, original.turnId, "done", "Original task evidence");
				await f.execute({ action: "list_jobs" });
			}
			vi.spyOn(f.context.sessionManager, "getSessionId").mockReturnValue("next-parent");
			vi.spyOn(f.context.sessionManager, "getSessionFile").mockReturnValue(undefined);
			const start = f.execute({
				action: "fire_task",
				launchKey: "next",
				task: "Next project assignment",
				agents: [{ provider: "pi", name: "builder", model: state === "different-model" ? "two" : "one" }],
			});
			if (state === "busy") {
				await expect(start).rejects.toThrow(/specialist.*busy|pending|unavailable/i);
				expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
				expect(f.launchTurn).toHaveBeenCalledTimes(1);
				expect(f.store.load("birth").agents[0].turnId).toBe(original.turnId);
			} else if (state === "idle") {
				const result = await start;
				expect(result.details).toMatchObject({
					job: {
						id: "birth",
						agents: [
							{ turn: 2, paneId: original.paneId, terminalId: original.terminalId, profile: original.profile },
						],
					},
				});
				expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
				expect(f.launchTurn).toHaveBeenCalledTimes(2);
				const current = new CollaborationJobStore(f.root, "next-parent").load("birth");
				expect(current.agents[0].args).toEqual(original.args);
				expect(current.agents[0].env).toEqual(original.env);
				expect(() => f.store.reserveTurn("birth", original.id, "Stale parent task")).toThrow(
					/parent|owner|foreign/i,
				);
			} else {
				expect((await start).details).toMatchObject({ job: { id: "next" } });
				expect(f.backend.startAgent).toHaveBeenCalledTimes(2);
			}
			expect(f.backend.readAgent).not.toHaveBeenCalled();
		} finally {
			await f.cleanup();
			vi.restoreAllMocks();
		}
	},
);
