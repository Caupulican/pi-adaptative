import { SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it, vi } from "vitest";
import { createHumanInputRequest, resolveHumanInput } from "../src/core/human-input.ts";
import { subscribeHumanInputActivity } from "../src/core/human-input-activity.ts";

describe("human input lifecycle authority", () => {
	it("emits a paired waiting/settled event from the shared presenter, including failures", async () => {
		const sessionManager = SessionManager.inMemory();
		const sequence: string[] = [];
		const off = subscribeHumanInputActivity(sessionManager, (event) => sequence.push(event.phase));
		const request = createHumanInputRequest({ source: "tool", questions: [], acceptsImages: false });
		await expect(
			resolveHumanInput({
				sessionManager,
				request,
				present: () => {
					sequence.push("present");
					return Promise.reject(new Error("presentation failed"));
				},
			}),
		).rejects.toThrow("presentation failed");
		expect(sequence).toEqual(["present", "waiting", "settled"]);
		off();
	});
	it("does not report a cancelled-before-presentation request or another session's question", async () => {
		const sessionManager = SessionManager.inMemory();
		const listener = vi.fn();
		const off = subscribeHumanInputActivity(SessionManager.inMemory(), listener);
		const present = vi.fn();
		await resolveHumanInput({
			sessionManager,
			request: createHumanInputRequest({ source: "tool", questions: [], acceptsImages: false }),
			present,
			signal: AbortSignal.abort(),
		});
		expect(present).not.toHaveBeenCalled();
		expect(listener).not.toHaveBeenCalled();
		off();
	});
});
