import { SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it, vi } from "vitest";
import { createHumanInputRequest, resolveHumanInput } from "../src/core/human-input.ts";
import { publishHumanInputActivity, subscribeHumanInputActivity } from "../src/core/human-input-activity.ts";

describe("human input lifecycle authority", () => {
	it("replays a pending question once without duplicating it through the active publish generation", () => {
		const sessionManager = SessionManager.inMemory();
		const request = createHumanInputRequest({ source: "tool", questions: [], acceptsImages: false });
		const delivery: string[] = [];
		const late = (event: { phase: "waiting" | "settled" }) => delivery.push(`late:${event.phase}`);
		subscribeHumanInputActivity(sessionManager, (event) => {
			delivery.push(`first:${event.phase}`);
			subscribeHumanInputActivity(sessionManager, late);
		});
		subscribeHumanInputActivity(sessionManager, (event) => delivery.push(`existing:${event.phase}`));

		publishHumanInputActivity(sessionManager, { phase: "waiting", request });
		expect(delivery).toEqual(["first:waiting", "late:waiting", "existing:waiting"]);

		publishHumanInputActivity(sessionManager, { phase: "settled", request });
		expect(delivery).toEqual([
			"first:waiting",
			"late:waiting",
			"existing:waiting",
			"first:settled",
			"existing:settled",
			"late:settled",
		]);
	});

	it("does not expose a settled publication to a subscriber added after pending state is cleared", () => {
		const sessionManager = SessionManager.inMemory();
		const request = createHumanInputRequest({ source: "tool", questions: [], acceptsImages: false });
		const delivery: string[] = [];
		const late = (event: { phase: "waiting" | "settled" }) => delivery.push(`late:${event.phase}`);
		subscribeHumanInputActivity(sessionManager, (event) => {
			delivery.push(`first:${event.phase}`);
			if (event.phase === "settled") subscribeHumanInputActivity(sessionManager, late);
		});
		subscribeHumanInputActivity(sessionManager, (event) => delivery.push(`existing:${event.phase}`));

		publishHumanInputActivity(sessionManager, { phase: "waiting", request });
		delivery.length = 0;
		publishHumanInputActivity(sessionManager, { phase: "settled", request });
		expect(delivery).toEqual(["first:settled", "existing:settled"]);

		publishHumanInputActivity(sessionManager, { phase: "waiting", request });
		expect(delivery).toEqual([
			"first:settled",
			"existing:settled",
			"first:waiting",
			"existing:waiting",
			"late:waiting",
		]);
	});

	it("publishes waiting before presentation and settles the activity after a failure", async () => {
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
		expect(sequence).toEqual(["waiting", "present", "settled"]);
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
