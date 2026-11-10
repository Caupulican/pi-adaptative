import "../builtin-install.ts";
import { join } from "node:path";
import { expect } from "vitest";
import {
	emergencyResumePath,
	emergencyStopPath,
	readEmergencyStop,
} from "../../../../src/core/provider-admission/emergency-stop.ts";
import { type Barrier, createBarrier, text } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import {
	carriesMarker,
	contentText,
	delegateReceipts,
	handoffTurn,
	settle,
	startOf,
	startStep,
	submitReport,
} from "./journey-8-shared.ts";
import { expectOwnerWords, INTAKE_JUDGMENTS_WITHOUT_GRANT } from "./shared.ts";

/**
 * Leg 3: the machine-wide emergency stop holds new starts and a worker's next provider request, and never the root's
 * own turns.
 *
 * The root starts one worker that waits at its first request and one that reports and ends. The stop is engaged with a
 * reason: a start made now is accepted and queued with the stop's own words, the waiting worker is not cancelled, and the
 * root's turn still gets its answers. Released, the waiting worker's next request waits instead of reaching the provider.
 * Lifting the stop writes the resume record, removes the sentinel, starts the queued worker and lets the held request go.
 */

const MODEL = "worker-a";
const FINISHING_MODEL = "worker-b";
const QUEUED_MODEL = "worker-c";
const NOTE = "the retry limit is three\n";
const STOP_REASON = "the owner paused every worker on this machine";

const START_PROMPT = "Start one worker to read the note and one to report straight away.";
const STOPPED_PROMPT = "Start one more worker while the machine is stopped.";

function instructionsOf(word: string): string {
	return `Read notes.md and report its first line. You are worker ${word}.`;
}

/** The text of the session's newest assistant message: what the root itself answered. */
function lastAssistantText(session: { messages: ReadonlyArray<{ role: string; content?: unknown }> }): string {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message?.role === "assistant") return contentText(message.content);
	}
	return "";
}

export async function runJourney8EmergencyStopPhase(world: HarnessWorld): Promise<void> {
	const trace = world.trace;
	world.io.seed(join(HARNESS_PROJECT_CWD, "notes.md"), NOTE);
	const stopPath = emergencyStopPath(world.agentDir);
	const resumePath = emergencyResumePath(world.agentDir);
	const sessionManager = world.createSessionManager();
	const { session } = await world.createRootSession("root", { sessionManager });

	const waitingHold = createBarrier();
	const waitingFirstRequest = createBarrier();
	const waitingResumed = createBarrier();
	const finishingRequest = createBarrier();
	const queuedRequest = createBarrier();
	const wakes: Barrier[] = [createBarrier(), createBarrier(), createBarrier()];
	const wakeAt = (index: number): Barrier => {
		const barrier = wakes[index];
		if (barrier === undefined) throw new Error(`no wake barrier at ${index}`);
		return barrier;
	};

	// The waiting worker's first reply is a tool call, not a report: its next provider request is the one the stop holds.
	world.provider.enqueueTrack(
		"j8c-waiting",
		MODEL,
		carriesMarker("You are worker waiting."),
		{
			name: "j8c-waiting-read",
			gate: waitingHold.promise,
			check: () => waitingFirstRequest.release(),
			reply: {
				content: [{ type: "toolCall", id: "j8c-waiting-read-1", name: "read", arguments: { path: "notes.md" } }],
				stopReason: "toolUse",
			},
		},
		{
			name: "j8c-waiting-report",
			check: () => waitingResumed.release(),
			reply: submitReport("j8c-waiting-report-1", "Worker waiting read the note."),
		},
	);
	world.provider.enqueueTrack("j8c-finishing", FINISHING_MODEL, carriesMarker("You are worker finishing."), {
		name: "j8c-finishing-report",
		check: () => finishingRequest.release(),
		reply: submitReport("j8c-finishing-report-1", "Worker finishing read the retry limit."),
	});
	world.provider.enqueueTrack("j8c-queued", QUEUED_MODEL, carriesMarker("You are worker queued."), {
		name: "j8c-queued-report",
		check: () => queuedRequest.release(),
		reply: submitReport("j8c-queued-report-1", "Worker queued read the note."),
	});

	world.provider.enqueue(
		"root",
		startStep(session, "j8c-start-waiting", "j8c-starts-1", instructionsOf("waiting"), MODEL),
		startStep(
			session,
			"j8c-start-finishing",
			"j8c-starts-2",
			`${instructionsOf("finishing")} It reports at once.`,
			FINISHING_MODEL,
		),
		text("j8c-starts-done", "One worker waits and one reports straight away."),
		handoffTurn("j8c-wake-finishing", wakeAt(0)),
		startStep(session, "j8c-stopped", "j8c-stopped-1", instructionsOf("queued"), QUEUED_MODEL),
		text("j8c-stopped-done", "The third worker is queued while the machine is stopped."),
		handoffTurn("j8c-wake-waiting", wakeAt(1)),
		handoffTurn("j8c-wake-queued", wakeAt(2)),
	);
	world.systemOne.enterPhase("j8c-emergency-stop", INTAKE_JUDGMENTS_WITHOUT_GRANT, {
		expect: expectOwnerWords({
			sessionManager: () => sessionManager,
			userRequests: [START_PROMPT, STOPPED_PROMPT],
			optionalToolNames: ["secret_store"],
		}),
	});

	await withDeadline(trace, "the two starts", session.prompt(START_PROMPT));
	await withDeadline(trace, "the waiting worker is held at its first request", waitingFirstRequest.promise);
	await withDeadline(trace, "the finishing worker reports", finishingRequest.promise);
	await withDeadline(trace, "the finishing worker's handoff reaches the root", wakeAt(0).promise);
	await withDeadline(trace, "the finishing worker's handoff turn settles", session.waitForForegroundIdle());
	const [waitingStart, finishingStart] = delegateReceipts(session).map(startOf);
	if (waitingStart === undefined || finishingStart === undefined) throw new Error("the first turn has two receipts");

	// The stop is engaged with a reason, and the sentinel holds it.
	session.setEmergencyStop(true, STOP_REASON);
	expect(world.io.existsSync(stopPath), "engaging the stop writes the sentinel file").toBe(true);
	expect(readEmergencyStop(world.agentDir).reason, "the sentinel holds the reason the owner gave").toBe(STOP_REASON);
	const stoppedRaw = world.io.peekFile(stopPath);
	expect(
		stoppedRaw === undefined ? undefined : JSON.parse(stoppedRaw).reason,
		"the file itself holds the reason, as the owner wrote it",
	).toBe(STOP_REASON);

	// A start made while the stop is engaged is accepted and queued with the stop's own words.
	await withDeadline(trace, "the start made while the machine is stopped", session.prompt(STOPPED_PROMPT));
	const queuedStart = delegateReceipts(session).map(startOf)[2];
	if (queuedStart === undefined) throw new Error("the start made under the stop has no receipt");
	expect(
		queuedStart.text,
		`the queued start is told the machine-wide stop and its file: ${queuedStart.text}`,
	).toContain(`waiting: capacity: paused by the machine-wide emergency stop (${stopPath}) (since `);
	expect(lastAssistantText(session), "the root's own turn still gets its answers: the foreground is never held").toBe(
		"The third worker is queued while the machine is stopped.",
	);
	expect(
		{
			waiting: session.getLaneRecords().find((record) => record.laneId === waitingStart.laneId)?.status,
			finishing: session.getLaneRecords().find((record) => record.laneId === finishingStart.laneId)?.status,
			queued: session.getLaneRecords().find((record) => record.laneId === queuedStart.laneId)?.status,
		},
		"the stop cancelled nothing: the waiting worker still runs, the finished one stays finished, and the new one waits",
	).toEqual({ waiting: "running", finishing: "succeeded", queued: "queued" });

	// Released, the waiting worker's next request waits instead of reaching the provider.
	waitingHold.release();
	await withDeadline(
		trace,
		"the stop's own recheck is armed for the held request",
		world.timers.whenArmed("provider-admission"),
	);
	await settle();
	expect(
		world.provider.requests.filter((request) => request.model.id === MODEL).length,
		"the held request does not reach the provider while the stop is engaged",
	).toBe(1);

	// Lifting the stop writes the resume record and removes the sentinel.
	session.setEmergencyStop(false);
	expect(world.io.existsSync(stopPath), "lifting the stop removes the sentinel").toBe(false);
	expect(world.io.existsSync(resumePath), "lifting the stop writes the owner's continue record").toBe(true);
	await withDeadline(trace, "the held request goes on after the lift", waitingResumed.promise);
	await withDeadline(trace, "the queued worker starts after the lift", queuedRequest.promise);

	// Each worker's handoff reaches the root.
	await withDeadline(trace, "the waiting worker's handoff reaches the root", wakeAt(1).promise);
	await withDeadline(trace, "its handoff turn settles", session.waitForForegroundIdle());
	await withDeadline(trace, "the queued worker's handoff reaches the root", wakeAt(2).promise);
	await withDeadline(trace, "the leg's turns settle", session.waitForForegroundIdle());
	expect(
		{
			statuses: delegateReceipts(session)
				.map(startOf)
				.map((start) => session.getLaneRecords().find((record) => record.laneId === start.laneId)?.status),
			stopFile: world.io.existsSync(stopPath),
		},
		"every lane of the leg ended and the stop is lifted",
	).toEqual({ statuses: ["succeeded", "succeeded", "succeeded"], stopFile: false });
	expect(await world.disposeSessionInBody(session), "the emergency-stop root disposes cleanly").toBeUndefined();
	world.trace.mark("root", "j8.emergency-stop");
}
