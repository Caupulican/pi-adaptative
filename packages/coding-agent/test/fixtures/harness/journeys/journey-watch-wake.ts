import "../builtin-install.ts";
import { expect } from "vitest";
import { createBarrier, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";

/** What the parent reads after a watch's result that reported nothing for the owner: the session that armed the watch wakes. */
export const WATCH_WAKE_SENTENCE =
	"The owner needs no update from this result alone, but you armed this watch because your own work waits on it: continue that work now, or end the turn if none waits.";

/**
 * A watch's result that reported `ownerUpdate: "none"` still starts a turn of the session that armed the watch. Scripts
 * that turn's answer and asserts the result arrived as the turn's own input with the host's sentence (not as input that
 * rides with the owner's next turn). Resolves once the turn answered; the caller then waits for the session to settle
 * before the journey's next owner step.
 */
export function scriptWatchWake(world: HarnessWorld, label: string, routineId: string): Promise<void> {
	const answered = createBarrier();
	world.provider.enqueue("root", {
		...text(`${label}-wake-answer`, "Alert recorded; no further work waits on it."),
		check: (request) => {
			// The result precedes the wake marker and the authority record the host appends; the latest one is this wake's input.
			const head = `Routine ${routineId} ended: succeeded with nothing for the owner.`;
			const wake = request.context.messages
				.map((message) => JSON.stringify(message))
				.findLast((message) => message.includes(head));
			expect(wake, "the watch result is the input of the wake turn").toBeDefined();
			expect(wake, "the wake turn is told the owner needs nothing and the session's own work decides").toContain(
				WATCH_WAKE_SENTENCE,
			);
			answered.release();
		},
	});
	return answered.promise;
}

/** Waits for a scripted watch wake turn to answer and for the session to settle, so the next owner step starts on an idle session. */
export async function settleWatchWake(
	world: HarnessWorld,
	session: { readonly agent: { waitForIdle(): Promise<void> }; waitForForegroundIdle(): Promise<void> },
	label: string,
	answered: Promise<void>,
): Promise<void> {
	await withDeadline(world.trace, `${label} wake turn answered`, answered);
	await withDeadline(world.trace, `agent idle after ${label} wake turn`, session.agent.waitForIdle());
	await withDeadline(world.trace, `foreground idle after ${label} wake turn`, session.waitForForegroundIdle());
}
