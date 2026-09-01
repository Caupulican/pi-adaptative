import type { AgentTool } from "@caupulican/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
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
		await new Promise((resolve) => setTimeout(resolve, 0));

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
		await new Promise((resolve) => setTimeout(resolve, 0));

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
		await new Promise((resolve) => setTimeout(resolve, 0));

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
		await new Promise((resolve) => setTimeout(resolve, 0));

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
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(harness.faux.state.callCount).toBe(2);

		await harness.session.prompt("thanks");
		await new Promise((resolve) => setTimeout(resolve, 0));

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
		await new Promise((resolve) => setTimeout(resolve, 0));

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
