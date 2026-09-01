import type { AgentTool } from "@caupulican/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE } from "../src/core/goals/goal-continuation-prompt.ts";
import { DurableLearningState } from "../src/core/learning/durable-learning-state.ts";
import { analyzeReflectionTurn } from "../src/core/learning/reflection-turn-analysis.ts";
import {
	CURRENT_TURN_REFLECTION_CUSTOM_TYPE,
	CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE,
	REFLECTION_TURN_TRIGGER_CUSTOM_TYPE,
} from "../src/core/reflection-controller.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

/** The cue's own opening line — the only stable way to count cue copies on the wire. */
const CUE_MARKER = "Root reflection contract";
/** The durable half of the reflection turn: its prompt message. */
const REFLECTION_TURN_PROMPT_MARKER = "Reflection checkpoint";

interface ReflectionPreflightHold {
	/** Install on a harness via `extensionFactories`. */
	extension: ExtensionFactory;
	/** Resolves once a reflection submission has entered the hold. */
	entered: Promise<void>;
	/** Let the submissions currently held continue; later ones are held again. */
	releaseHeld(): void;
	/** Let everything held now, and everything arriving later, continue. */
	stopHolding(): void;
}

/**
 * Park a reflection submission inside its own preflight, deterministically.
 *
 * The window these tests are about — a reflection turn that has STARTED but has not reached the
 * provider — is exactly where `agent.abort()` has no run to reach, so it is where cancellation used to
 * be a silent no-op. It is only observable from inside the submission, so it is opened with an
 * extension `input` handler rather than a timer: entering the handler is proof the turn is in flight,
 * and it stays there until the test says otherwise. A timer would pin nothing — it would pass whether
 * or not the cancellation landed, which is the defect the previous preemption test could not see.
 */
function createReflectionPreflightHold(): ReflectionPreflightHold {
	let signalEntered: (() => void) | undefined;
	const entered = new Promise<void>((resolve) => {
		signalEntered = resolve;
	});
	let waiting: Array<() => void> = [];
	let holding = true;
	const drain = () => {
		const release = waiting;
		waiting = [];
		for (const resume of release) resume();
	};
	return {
		extension: (pi) => {
			pi.on("input", async (event) => {
				if (holding && event.text.includes(REFLECTION_TURN_PROMPT_MARKER)) {
					signalEntered?.();
					await new Promise<void>((resolve) => waiting.push(resolve));
				}
				return { action: "continue" };
			});
		},
		entered,
		releaseHeld: drain,
		stopHolding: () => {
			holding = false;
			drain();
		},
	};
}

function countMentions(context: Context | undefined, text: string): number {
	return (context?.messages ?? []).filter((message) => getMessageText(message).includes(text)).length;
}

function countCues(context: Context | undefined): number {
	return (context?.messages ?? []).filter((message) => getMessageText(message).includes(CUE_MARKER)).length;
}

function durableCueCopies(harness: Harness): number {
	const entries = harness.sessionManager
		.getEntries()
		.filter(
			(entry) => entry.type === "custom_message" && entry.customType === CURRENT_TURN_REFLECTION_CUSTOM_TYPE,
		).length;
	const messages = harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === CURRENT_TURN_REFLECTION_CUSTOM_TYPE,
	).length;
	const byText = harness.session.messages.filter((message) => getMessageText(message).includes(CUE_MARKER)).length;
	return entries + messages + byText;
}

describe("current-session reflection", () => {
	const harnesses: Harness[] = [];
	const originalNativeReflection = process.env.PI_NATIVE_REFLECTION;
	const originalAutoLearnChild = process.env.PI_AUTO_LEARN_CHILD;
	const originalSessionRole = process.env.PI_SESSION_ROLE;

	afterEach(async () => {
		if (originalNativeReflection === undefined) delete process.env.PI_NATIVE_REFLECTION;
		else process.env.PI_NATIVE_REFLECTION = originalNativeReflection;
		if (originalAutoLearnChild === undefined) delete process.env.PI_AUTO_LEARN_CHILD;
		else process.env.PI_AUTO_LEARN_CHILD = originalAutoLearnChild;
		if (originalSessionRole === undefined) delete process.env.PI_SESSION_ROLE;
		else process.env.PI_SESSION_ROLE = originalSessionRole;
		while (harnesses.length > 0) {
			const harness = harnesses.pop();
			if (!harness) continue;
			await harness.session.disposeAndWait();
			await harness.cleanup();
		}
	});

	it("spends exactly one extra provider turn on reflection when a completed turn produced evidence", async () => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const contexts: Context[] = [];
		const capture = (text: string) => (context: Context) => {
			contexts.push(context);
			return fauxAssistantMessage(text);
		};
		harness.setResponses([
			capture("Noted."),
			capture("Nothing durable to record."),
			fauxAssistantMessage("This response must remain unused."),
		]);

		// EXPLICIT_DURABLE_SIGNAL in the user text, so analyzeCompletedTurn raises `durable`.
		await harness.session.prompt("Remember that this project pins its own runtime.");
		await harness.session.settleReflectionTurn();

		// Two calls for one prompt: the work itself, then the one reflection turn its evidence bought.
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(contexts).toHaveLength(2);

		// The turn that DID the work never carries the cue — reflection is what happens after work ends.
		expect(countCues(contexts[0])).toBe(0);
		// The reflection turn carries it exactly once, with the installed-state transition riding along.
		expect(countCues(contexts[1])).toBe(1);
		expect(
			contexts[1]?.messages.some((message) => getMessageText(message).includes("Installed-state transition")),
		).toBe(true);
		expect(
			contexts[1]?.messages.some((message) => getMessageText(message).includes(REFLECTION_TURN_PROMPT_MARKER)),
		).toBe(true);

		const cueStates = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE);
		expect(
			cueStates.map((entry) => (entry.type === "custom" ? (entry.data as { status: string }).status : "")),
		).toEqual(["pending", "due", "due", "consumed", "consumed"]);
		expect(DurableLearningState.forAgentDir(harness.tempDir).readSnapshot()).toMatchObject({
			currentTransitionId: null,
			currentClaimOwnerId: null,
			resolvedTransitions: 1,
		});
		expect(durableCueCopies(harness)).toBe(0);
		expect(harness.session.getSpawnedUsage().reports).toBe(0);
	});

	it("never leaks a second reflection cue copy across three plain-text turns", async () => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const contexts: Context[] = [];
		const capture = (text: string) => (context: Context) => {
			contexts.push(context);
			return fauxAssistantMessage(text);
		};
		harness.setResponses([capture("first"), capture("second"), capture("third")]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");
		await harness.session.prompt("three");
		await harness.session.settleReflectionTurn();

		// The measured regression this pins: three plain-text turns used to send
		//   [user, user] / [user, user, assistant, user, user] / [user, user, assistant, user, user, assistant, user]
		// where every `user` pair was prompt + cue, and the cue copies ACCUMULATED in durable history.
		// One cue per turn is one cue per PROVIDER REQUEST once tools are involved, and a durable copy is
		// re-sent on every request forever after. Now: exactly one prompt per turn, no cue anywhere, and
		// no extra turn — these three turns produced no durable evidence, so reflection costs nothing.
		expect(harness.faux.state.callCount).toBe(3);
		expect(contexts.map((context) => context.messages.map((message) => message.role))).toEqual([
			["user"],
			["user", "assistant", "user"],
			["user", "assistant", "user", "assistant", "user"],
		]);
		expect(contexts.map(countCues)).toEqual([0, 0, 0]);
		expect(contexts.reduce((total, context) => total + countCues(context), 0)).toBe(0);
		expect(durableCueCopies(harness)).toBe(0);
	});

	it("carries the cue on at most one request of a multi-request tool run", async () => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		const echo: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
			tools: [echo],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const contexts: Context[] = [];
		const capture = (step: () => ReturnType<typeof fauxAssistantMessage>) => (context: Context) => {
			contexts.push(context);
			return step();
		};
		harness.setResponses([
			capture(() => fauxAssistantMessage(fauxToolCall("echo", { text: "a" }), { stopReason: "toolUse" })),
			capture(() => fauxAssistantMessage(fauxToolCall("echo", { text: "b" }), { stopReason: "toolUse" })),
			capture(() => fauxAssistantMessage("done")),
			capture(() => fauxAssistantMessage("Nothing durable to record.")),
		]);

		await harness.session.prompt("Remember to use the tool twice here.");
		await harness.session.settleReflectionTurn();

		// Three provider requests inside the working run, then ONE reflection turn. The cue rides the
		// reflection turn only — never once per request of the run that did the work.
		expect(harness.faux.state.callCount).toBe(4);
		expect(contexts.slice(0, 3).map(countCues)).toEqual([0, 0, 0]);
		expect(countCues(contexts[3])).toBe(1);
		expect(contexts.reduce((total, context) => total + countCues(context), 0)).toBe(1);
		expect(durableCueCopies(harness)).toBe(0);
	});

	it("buys no extra provider call when nothing durable is pending", async () => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
			fauxAssistantMessage("this response must remain unused"),
		]);

		await harness.session.prompt("a");
		await harness.session.prompt("b");
		await harness.session.prompt("c");
		await harness.session.settleReflectionTurn();

		// One provider call per prompt, full stop. A turn with no durable evidence buys no reflection
		// turn — not even for the session's first-observation version transition, which is audit-only.
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.getSpawnedUsage().reports).toBe(0);
	});

	it("buys exactly one extra provider call per evidence-bearing turn, never one per turn", async () => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage("worked on it"),
			fauxAssistantMessage("reflected once"),
			fauxAssistantMessage("worked on it again"),
			fauxAssistantMessage("this response must remain unused"),
		]);

		// Turn 1 raises `durable`; turn 2 raises nothing.
		await harness.session.prompt("Remember that the build pins its own runtime.");
		await harness.session.settleReflectionTurn();
		expect(harness.faux.state.callCount).toBe(2);

		await harness.session.prompt("thanks");
		await harness.session.settleReflectionTurn();

		// EXACTLY one extra call in total, not one per turn: the reflection turn's own completion is
		// never itself evidence, and an evidence-free turn buys nothing.
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("does not recurse when the reflection turn itself produces durable evidence", async () => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		const recorded: string[] = [];
		const record: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Record a durable fact",
			parameters: Type.Object({ fact: Type.String() }),
			execute: async (_toolCallId, params) => {
				const fact = typeof params === "object" && params !== null && "fact" in params ? String(params.fact) : "";
				recorded.push(fact);
				return { content: [{ type: "text", text: `stored:${fact}` }], details: { fact } };
			},
		};
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
			tools: [record],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const contexts: Context[] = [];
		const capture = (step: () => ReturnType<typeof fauxAssistantMessage>) => (context: Context) => {
			contexts.push(context);
			return step();
		};
		harness.setResponses([
			capture(() => fauxAssistantMessage("Noted.")),
			// The reflection turn does exactly what the cue asks — writes something durable, and says so
			// in words DURABLE_WORK_SIGNAL matches. Left unguarded, that is textbook `durable` evidence,
			// which would queue a cue and buy the NEXT reflection turn, forever.
			capture(() =>
				fauxAssistantMessage(
					[
						{ type: "text", text: "Confirmed root cause; recording the invariant." },
						fauxToolCall("echo", { fact: "the build pins its own runtime" }),
					],
					{ stopReason: "toolUse" },
				),
			),
			capture(() => fauxAssistantMessage("Recorded the invariant.")),
			fauxAssistantMessage("A recursive reflection turn would consume this. It must remain unused."),
		]);

		await harness.session.prompt("Remember that the build pins its own runtime.");
		await harness.session.settleReflectionTurn();

		// 1 working request + 2 requests inside the ONE reflection turn. The count stops there.
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(recorded).toEqual(["the build pins its own runtime"]);
		expect(contexts.map(countCues)).toEqual([0, 1, 0]);
		expect(durableCueCopies(harness)).toBe(0);

		// The premise, proven rather than assumed: run the SAME projection over the reflection turn's own
		// messages that `agent_end` runs, and confirm it really does read as durable evidence. The
		// threshold is set out of reach so this can only be the `durable` signal, not `complex`.
		const reflectionTurnStart = harness.session.messages.findIndex(
			(message) => message.role === "custom" && message.customType === REFLECTION_TURN_TRIGGER_CUSTOM_TYPE,
		);
		expect(reflectionTurnStart).toBeGreaterThan(0);
		expect(analyzeReflectionTurn(harness.session.messages.slice(reflectionTurnStart), 99).trigger).toBe("durable");

		// So the only reason the count stopped is the suppression: the reflection turn's `agent_end`
		// wrote no new `due` cue after the `consumed` one it settled.
		const statuses = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE)
			.map((entry) => (entry.type === "custom" ? (entry.data as { status: string }).status : ""));
		expect(statuses).toEqual(["pending", "due", "due", "consumed", "consumed"]);
		expect(statuses.lastIndexOf("due")).toBeLessThan(statuses.indexOf("consumed"));
	});

	it("owns the detached reflection turn's lifetime and lets nothing write after dispose() returns", async () => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage("Noted."),
			fauxAssistantMessage("Reflected."),
			fauxAssistantMessage("this response must remain unused"),
		]);

		await harness.session.prompt("Remember that the build pins its own runtime.");

		// DETACHED: the user's answer is already returned and the extra call has not happened yet.
		// Reflection is never on the caller's critical path.
		expect(harness.faux.state.callCount).toBe(1);

		// OWNED, not abandoned: the session holds the turn's promise, so this is a real barrier. An
		// untracked turn would make this a no-op and leave the count at 1 — which is the whole
		// difference between detached-and-owned and detached-and-escaped.
		await harness.session.settleReflectionTurn();
		expect(harness.faux.state.callCount).toBe(2);

		// A second work turn, disposed while ITS reflection turn is still in flight.
		harness.setResponses([fauxAssistantMessage("Noted again."), fauxAssistantMessage("Reflected again.")]);
		await harness.session.prompt("Remember that this second fact is durable too.");
		// 3 = turn 1 + its reflection turn + turn 2's work. Turn 2's reflection turn is detached and has
		// not called the provider yet, so disposal below happens with it genuinely in flight.
		expect(harness.faux.state.callCount).toBe(3);

		await harness.session.disposeAndWait();
		const callsAtDispose = harness.faux.state.callCount;
		const entriesAtDispose = harness.sessionManager.getEntries().length;
		// Disposal settled it rather than leaving it running.
		await expect(harness.session.settleReflectionTurn()).resolves.toBeUndefined();

		// A generous observation window — not a synchronization crutch. If the turn had escaped, this is
		// where its provider call and session writes would land, after `disposeAndWait()` had already
		// reported the session closed: in the test runner an ENOTEMPTY from a teardown racing a live
		// writer, in production a session still writing to the agent dir after it was disposed.
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(harness.faux.state.callCount).toBe(callsAtDispose);
		expect(harness.sessionManager.getEntries().length).toBe(entriesAtDispose);
	});

	it("does not reject a prompt that arrives while the reflection turn is still running", async () => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage("Noted."),
			fauxAssistantMessage("Reflected."),
			fauxAssistantMessage("Answered the follow-up."),
			fauxAssistantMessage("Reflected again."),
		]);

		await harness.session.prompt("Remember that the build pins its own runtime.");
		// The session IS busy here — the detached reflection turn holds the foreground. A user typing
		// straight after reading their answer lands in exactly this window, and must not be told the
		// agent is already processing for work they cannot see. Reflection yields; the prompt runs.
		expect(harness.faux.state.callCount).toBe(1);

		await expect(harness.session.prompt("and one more thing")).resolves.toBeUndefined();
		await harness.session.settleReflectionTurn();

		const answers = harness.session.messages
			.filter((message) => message.role === "assistant")
			.map((message) => getMessageText(message));
		expect(answers).toContain("Answered the follow-up.");
		expect(durableCueCopies(harness)).toBe(0);
	});

	it("cancels a reflection turn still in its own preflight instead of waiting out its provider call", async () => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		const hold = createReflectionPreflightHold();
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
			extensionFactories: [hold.extension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const contexts: Context[] = [];
		const capture = (text: string) => (context: Context) => {
			contexts.push(context);
			return fauxAssistantMessage(text);
		};
		harness.setResponses([
			capture("Noted."),
			capture("Answered the follow-up."),
			capture("Reflected afterwards."),
			fauxAssistantMessage("this response must remain unused"),
		]);

		await harness.session.prompt("Remember that the build pins its own runtime.");
		await hold.entered;
		expect(harness.faux.state.callCount).toBe(1);

		// The user types while the reflection turn sits in its preflight. Not awaited yet: this call is
		// itself blocked on that turn unwinding, and the release below is what lets it.
		const followUp = harness.session.prompt("and one more thing");
		hold.releaseHeld();
		await expect(followUp).resolves.toBeUndefined();

		// Two calls, not three. The reflection turn came out of its preflight into its own cancellation
		// and never reached the provider — the whole point of a level-triggered signal over `agent.abort()`,
		// which had no run to abort in that window and let the turn proceed. The arriving prompt paid for
		// an unwind, not for a full provider turn, so the second call is the follow-up's own.
		expect(harness.faux.state.callCount).toBe(2);
		expect(contexts.map(countCues)).toEqual([0, 0]);
		expect(harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText)).toEqual([
			"Noted.",
			"Answered the follow-up.",
		]);
		// Cancelling a reflection turn is this mechanism working, not a fault to report to the user.
		expect(
			harness.eventsOfType("warning").filter((event) => event.message.includes("Reflection turn failed")),
		).toEqual([]);

		// The cue was abandoned, not destroyed: the follow-up's own completion re-raises it, and that turn
		// runs to the provider normally now that nothing is holding it.
		hold.stopHolding();
		await harness.session.settleReflectionTurn();
		expect(harness.faux.state.callCount).toBe(3);
		expect(countCues(contexts[2])).toBe(1);
		expect(durableCueCopies(harness)).toBe(0);
	});

	it("cancels a reflection turn still in its own preflight on dispose, before the provider is called", async () => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		const hold = createReflectionPreflightHold();
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
			extensionFactories: [hold.extension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("Noted."), fauxAssistantMessage("this response must remain unused")]);

		await harness.session.prompt("Remember that the build pins its own runtime.");
		await hold.entered;
		expect(harness.faux.state.callCount).toBe(1);
		const turnEntriesBeforeDispose = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type !== "custom").length;

		// Disposal starts with the reflection turn genuinely mid-preflight. Not awaited yet, for the same
		// reason as above: it settles that turn, and the release below is what lets it unwind.
		const disposal = harness.session.disposeAndWait();
		hold.stopHolding();
		await expect(disposal).resolves.toBeUndefined();

		// No provider call and no session writes after disposal. Without the cancellation the turn would
		// have run a full provider turn against infrastructure `dispose()` had already torn down — the
		// foreground recovery controller, the reflection controller, the provider request runtime — and
		// `_memory.shutdown()` would have been waiting behind all of it.
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type !== "custom").length).toBe(
			turnEntriesBeforeDispose,
		);
		// The one thing disposal DOES write is the cue's release — the claim it can no longer review is
		// handed back rather than left held, so the next session re-observes the evidence.
		expect(
			harness.sessionManager
				.getEntries()
				.filter(
					(entry) => entry.type === "custom" && entry.customType === CURRENT_TURN_REFLECTION_STATE_CUSTOM_TYPE,
				)
				.map((entry) => (entry.type === "custom" ? (entry.data as { status: string }).status : "")),
		).toEqual(["pending", "due", "due", "dismissed"]);
		// Disposal is not a failure of the reflection turn; the user is shut down, not warned.
		expect(
			harness.eventsOfType("warning").filter((event) => event.message.includes("Reflection turn failed")),
		).toEqual([]);
	});

	it("lets an internal continuation wait for the reflection turn instead of cancelling it", async () => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		const hold = createReflectionPreflightHold();
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
			extensionFactories: [hold.extension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const contexts: Context[] = [];
		const capture = (text: string) => (context: Context) => {
			contexts.push(context);
			return fauxAssistantMessage(text);
		};
		harness.setResponses([
			capture("Noted."),
			capture("Reflected."),
			capture("Continued the goal."),
			fauxAssistantMessage("this response must remain unused"),
		]);

		await harness.session.prompt("Remember that the build pins its own runtime.");
		await hold.entered;
		expect(harness.faux.state.callCount).toBe(1);

		// The session's own autonomous work arrives — a goal continuation, nobody watching a screen.
		const continuation = harness.session.prompt("Continue the goal.", {
			expandPromptTemplates: false,
			processSlashCommands: false,
			autoContinueGoal: false,
			internalContextType: GOAL_CONTINUATION_TRIGGER_CUSTOM_TYPE,
		});
		hold.stopHolding();
		await expect(continuation).resolves.toBeUndefined();

		// Three calls: the work, the reflection turn it bought, then the continuation. Internal work waits
		// its turn rather than cancelling reflection — cancelling here silently destroyed the bought turn,
		// because `startDueTurn` refuses to start from an internal tail, so the abandoned cue had no next
		// completed turn to merge into and could sit undelivered indefinitely.
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.messages.filter((message) => message.role === "assistant").map(getMessageText)).toEqual([
			"Noted.",
			"Reflected.",
			"Continued the goal.",
		]);
		// Delivered, not lost: the cue rode the reflection turn exactly once and nothing else.
		expect(contexts.map(countCues)).toEqual([0, 1, 0]);
		expect(durableCueCopies(harness)).toBe(0);
	});

	it("keeps queued next-turn messages when the reflection turn that consumed them is cancelled", async () => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		const NEXT_TURN_NOTE = "Lane note queued for the next turn";
		const hold = createReflectionPreflightHold();
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
			extensionFactories: [hold.extension],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		const contexts: Context[] = [];
		const capture = (text: string) => (context: Context) => {
			contexts.push(context);
			return fauxAssistantMessage(text);
		};
		harness.setResponses([
			capture("Noted."),
			capture("Answered the follow-up."),
			capture("Reflected afterwards."),
			fauxAssistantMessage("this response must remain unused"),
		]);

		await harness.session.prompt("Remember that the build pins its own runtime.");
		await hold.entered;
		// Queued while the reflection turn sits in its preflight, so that turn is the one that picks it
		// up: it is counted, built into the turn's messages, and would be committed as consumed.
		await harness.session.sendCustomMessage(
			{ customType: "lane-note", content: NEXT_TURN_NOTE, display: false, details: undefined },
			{ deliverAs: "nextTurn" },
		);

		const followUp = harness.session.prompt("and one more thing");
		hold.releaseHeld();
		await expect(followUp).resolves.toBeUndefined();

		// The cancelled reflection turn never ran, so it must not have consumed the note: consumption
		// is committed only for a turn that actually reaches the run. The follow-up is the next turn
		// that does, and the note rides it exactly once.
		expect(harness.faux.state.callCount).toBe(2);
		expect(countMentions(contexts[0], NEXT_TURN_NOTE)).toBe(0);
		expect(countMentions(contexts[1], NEXT_TURN_NOTE)).toBe(1);

		// Delivered once, it is history from then on: the re-bought reflection turn sees the one copy
		// the follow-up carried, not a second delivery.
		hold.stopHolding();
		await harness.session.settleReflectionTurn();
		expect(harness.faux.state.callCount).toBe(3);
		expect(countMentions(contexts[2], NEXT_TURN_NOTE)).toBe(1);
	});

	it.each([
		["the native-reflection kill switch", { PI_NATIVE_REFLECTION: "0" }],
		["an Auto Learn child", { PI_AUTO_LEARN_CHILD: "1" }],
		["a worker session", { PI_SESSION_ROLE: "worker" }],
	] as const)("does not inject reflection into %s", async (_label, environment) => {
		delete process.env.PI_NATIVE_REFLECTION;
		delete process.env.PI_AUTO_LEARN_CHILD;
		delete process.env.PI_SESSION_ROLE;
		Object.assign(process.env, environment);
		const harness = await createHarness({
			settings: { autoLearn: { enabled: true, reflectionReview: true } },
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		let context: Context | undefined;
		harness.setResponses([
			(current) => {
				context = current;
				return fauxAssistantMessage("No reflection privilege.");
			},
		]);

		await harness.session.prompt("Ordinary request.");

		expect(harness.faux.state.callCount).toBe(1);
		expect(context?.messages.some((message) => getMessageText(message).includes("Root reflection contract"))).toBe(
			false,
		);
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) => entry.type === "custom_message" && entry.customType === CURRENT_TURN_REFLECTION_CUSTOM_TYPE,
				),
		).toBe(false);
	});
});
