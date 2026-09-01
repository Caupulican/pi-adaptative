import type { ExtensionAPI } from "@caupulican/pi-adaptative";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.ts";

async function createWaitingHarness(
	options: {
		tools?: AgentTool[];
		extensionFactories?: Harness["session"]["extensionRunner"] extends never
			? never
			: Array<(pi: ExtensionAPI) => void>;
	} = {},
): Promise<{
	harness: Harness;
	releaseToolExecution: () => void;
	promptPromise: Promise<void>;
	waitForToolStart: Promise<void>;
}> {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease;
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
			};
		},
	};
	const harness = await createHarness({
		settings: { autoLearn: { reflectionReview: false } },
		tools: [waitTool, ...(options.tools ?? [])],
		extensionFactories: options.extensionFactories,
	});

	const waitForToolStart = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				unsubscribe();
				resolve();
			}
		});
	});

	return {
		harness,
		releaseToolExecution: () => releaseToolExecution?.(),
		promptPromise: harness.session.prompt("start"),
		waitForToolStart,
	};
}

describe("AgentSession queue characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("dispatches extension commands immediately when prompted while idle", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/testcmd hello world");

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages).toEqual([]);
		// Extension-command-handled is an early return before the routing/prep phase (no turn is ever
		// started) — the working-spinner bracket must not fire for it either.
		expect(harness.eventsOfType("routing_start")).toHaveLength(0);
		expect(harness.eventsOfType("routing_end")).toHaveLength(0);
	});

	it("delivers extension-origin steering messages before the next LLM call", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const waiting = await createWaitingHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const sawSteer = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "steer now",
				);
				return fauxAssistantMessage(sawSteer ? "saw steer" : "missing steer");
			},
		]);

		await waitForToolStart;
		await new Promise((resolve) => setTimeout(resolve, 0));

		extensionApi?.sendUserMessage("steer now", { deliverAs: "steer" });
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer now"]);
		expect(getAssistantTexts(harness)).toContain("saw steer");
	});

	it("delivers follow-up messages only after the current run finishes", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const assistantSeenBeforeFollowUp: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				assistantSeenBeforeFollowUp.push(
					...context.messages
						.filter((message) => message.role === "assistant")
						.map((message) =>
							message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
						),
				);
				return fauxAssistantMessage("follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("after current run");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "after current run"]);
		expect(assistantSeenBeforeFollowUp).toContain("");
		expect(getAssistantTexts(harness)).toContain("follow-up response");
	});

	it("delivers multiple steering messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled steer 1"),
			fauxAssistantMessage("handled steer 2"),
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1");
		await harness.session.steer("steer 2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer 1", "steer 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "handled steer 1", "handled steer 2"]);
	});

	it("delivers multiple follow-up messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			fauxAssistantMessage("handled follow-up 1"),
			fauxAssistantMessage("handled follow-up 2"),
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1");
		await harness.session.followUp("follow-up 2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(getAssistantTexts(harness)).toEqual([
			"",
			"original turn complete",
			"handled follow-up 1",
			"handled follow-up 2",
		]);
	});

	it("delivers all steering messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setSteeringMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched steer response");
			},
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1");
		await harness.session.steer("steer 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "steer 1", "steer 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "batched steer response"]);
	});

	it("delivers all follow-up messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1");
		await harness.session.followUp("follow-up 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "original turn complete", "batched follow-up response"]);
	});

	it("queues custom messages with deliverAs steer while streaming", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "steer custom"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "steer custom", display: true, details: { value: 1 } },
			{ deliverAs: "steer" },
		);
		releaseToolExecution();
		await promptPromise;

		expect(sawCustomMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "queue-test"),
		).toBe(true);
	});

	it("queues custom messages with deliverAs followUp while streaming", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "follow-up custom"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "follow-up custom", display: true, details: { value: 1 } },
			{ deliverAs: "followUp" },
		);
		releaseToolExecution();
		await promptPromise;

		expect(sawCustomMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "queue-test"),
		).toBe(true);
	});

	it("orders triggerTurn: false custom messages after tool results without interleaving (F3)", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("follow-up completed"),
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "mid-tool-custom", content: "queued message", display: true, details: { value: 42 } },
			{ triggerTurn: false },
		);
		releaseToolExecution();
		await promptPromise;

		const messageRoles = harness.session.messages.map((m) => m.role);
		const toolResultIndex = messageRoles.indexOf("toolResult");
		const customIndex = harness.session.messages.findIndex(
			(m) => m.role === "custom" && m.customType === "mid-tool-custom",
		);

		expect(toolResultIndex).toBeGreaterThan(-1);
		expect(customIndex).toBeGreaterThan(toolResultIndex);

		// Also verify session entries ordering in SessionManager
		const entries = harness.session.sessionManager.getEntries();
		const entryTypes = entries.map((e) => e.type);
		const messageEntryIndex = entryTypes.indexOf("message");
		const customEntryIndex = entryTypes.indexOf("custom_message");
		expect(customEntryIndex).toBeGreaterThan(messageEntryIndex);
	});

	it("does not let a triggerTurn:false custom message race ahead of a BACKGROUNDED tool call's late-arriving completion (F3, the one real risk)", async () => {
		// Deliberately NOT createWaitingHarness(): its "wait" tool only signals readiness via the
		// tool_execution_start EVENT, which is emitted from reservePreparedToolCalls() -- a step
		// that runs and fully resolves BEFORE the handoff-subscription registration inside
		// executeAndFinalizePreparedToolCall() (a later, separate step in the same pipeline).
		// backgroundRunningToolCalls() needs that subscription to already exist, so this signals
		// readiness from inside the tool's own execute(), matching the proven pattern in
		// test/agent-session-background-tool-task.test.ts.
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		let markStarted: (() => void) | undefined;
		const toolStarted = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				markStarted?.();
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({
			settings: { autoLearn: { reflectionReview: false } },
			tools: [waitTool],
		});
		harnesses.push(harness);
		// "wait" arrives through createHarness's baseToolsOverride, which replaces the default
		// active tool set entirely. tool_task is always registered (agent-session.ts wires
		// getToolTaskDependencies unconditionally) but still needs explicit activation to use the
		// manual handoff API below.
		harness.session.setActiveToolsByName(["wait", "tool_task"]);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("foreground continued"),
			fauxAssistantMessage("background completion acknowledged"),
		]);

		const promptPromise = harness.session.prompt("start");
		await toolStarted;
		const handoffCount = harness.session.backgroundRunningToolCalls();
		expect(handoffCount).toBe(1);

		// The foreground prompt resolves once the model is told its call was handed off and
		// replies -- the "wait" tool itself is still blocked on releaseToolExecution() below, i.e.
		// still "running" in _backgroundToolTasks even though prompt() (and _foregroundRecovery's
		// busy state with it) has already settled.
		await promptPromise;

		await harness.session.sendCustomMessage(
			{ customType: "mid-background-custom", content: "queued during background", display: true, details: {} },
			{ triggerTurn: false },
		);

		let resolveAcknowledged!: () => void;
		const acknowledged = new Promise<void>((resolve) => {
			resolveAcknowledged = resolve;
		});
		const unsubscribe = harness.session.subscribe((event) => {
			if (
				event.type === "message_end" &&
				event.message.role === "assistant" &&
				getMessageText(event.message).includes("background completion acknowledged")
			) {
				resolveAcknowledged();
			}
		});
		releaseToolExecution?.();
		await acknowledged;
		unsubscribe();

		// The backgrounded call's own placeholder toolResult lands immediately (turn 1, protocol
		// correctness), so it precedes everything below regardless of the fix -- it is not a useful
		// discriminator here. The real risk this test pins is ordering relative to the tool's late
		// -arriving completion delivery (background-tool-completion): a triggerTurn:false message
		// sent while the task is still "running" must never be spliced in BEFORE that delivery.
		const messages = harness.session.messages;
		const backgroundCompletionIndex = messages.findIndex(
			(m) => m.role === "custom" && m.customType === "background-tool-completion",
		);
		const customIndex = messages.findIndex((m) => m.role === "custom" && m.customType === "mid-background-custom");

		expect(backgroundCompletionIndex).toBeGreaterThan(-1);
		expect(customIndex).toBeGreaterThan(-1);
		expect(customIndex).toBeGreaterThan(backgroundCompletionIndex);
	});

	it("injects nextTurn custom messages into the next prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawCustomMessage = false;

		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "carry this", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);

		harness.setResponses([
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "carry this"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("normal prompt");

		expect(sawCustomMessage).toBe(true);
		// The second custom record is the root reflection cue, not a duplicate of the injected one.
		// It is a transient the provider-request planner adds to every root-session request (production
		// has always sent it to the provider); since transient records became append-on-change it is
		// also committed to durable history, so a host that rebuilds its context from its own persisted
		// transcript between turns keeps it instead of silently losing it. Pinned by customType so a
		// future extra custom record cannot pass unnoticed.
		expect(
			harness.session.messages.map((message) =>
				message.role === "custom" ? `custom:${message.customType}` : message.role,
			),
		).toEqual(["user", "custom:next-turn", "custom:reflection_cue", "assistant"]);
	});

	it("retains nextTurn messages when extension preflight fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "retain this", display: false, details: {} },
			{ deliverAs: "nextTurn" },
		);
		const preflight = vi
			.spyOn(harness.session.extensionRunner, "emitBeforeAgentStart")
			.mockRejectedValueOnce(new Error("preflight failed"));

		await expect(harness.session.prompt("first attempt")).rejects.toThrow("preflight failed");
		expect(
			(harness.session as unknown as { _pendingNextTurnMessages: readonly unknown[] })._pendingNextTurnMessages,
		).toHaveLength(1);

		preflight.mockRestore();
		let sawRetainedMessage = false;
		harness.setResponses([
			(context) => {
				sawRetainedMessage = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "retain this",
				);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("second attempt");

		expect(sawRetainedMessage).toBe(true);
		expect(
			(harness.session as unknown as { _pendingNextTurnMessages: readonly unknown[] })._pendingNextTurnMessages,
		).toHaveLength(0);
	});

	it("does not emit routing_end when input preflight fails before routing_start", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => ({ action: "continue" }));
				},
			],
		});
		harnesses.push(harness);
		vi.spyOn(harness.session.extensionRunner, "emitInput").mockRejectedValueOnce(new Error("input failed"));

		await expect(harness.session.prompt("hello")).rejects.toThrow("input failed");

		expect(harness.eventsOfType("routing_start")).toHaveLength(0);
		expect(harness.eventsOfType("routing_end")).toHaveLength(0);
	});

	it("releases an early-painted user identity when execution fails before message_start", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		vi.spyOn(harness.session.agent, "prompt").mockRejectedValueOnce(new Error("execution failed early"));

		await expect(harness.session.prompt("hello")).rejects.toThrow("execution failed early");

		expect(
			(harness.session as unknown as { _earlyDisplayedUserMessages: ReadonlySet<unknown> })
				._earlyDisplayedUserMessages.size,
		).toBe(0);
	});

	it("does not rebaseline the active turn when prompt queues a steer", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await waitForToolStart;
		const internals = harness.session as unknown as { _costGuardTurnBaselineUsd: number };
		internals._costGuardTurnBaselineUsd = 42;
		await harness.session.prompt("queued", { streamingBehavior: "steer" });

		expect(internals._costGuardTurnBaselineUsd).toBe(42);
		releaseToolExecution();
		await promptPromise;
	});

	it("updates pendingMessageCount and removes queued text before message_start is emitted", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const countsAtQueuedMessageStart: number[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		harness.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "queued"
			) {
				countsAtQueuedMessageStart.push(harness.session.pendingMessageCount);
			}
		});

		await waitForToolStart;
		await harness.session.steer("queued");
		expect(harness.session.pendingMessageCount).toBe(1);
		releaseToolExecution();
		await promptPromise;

		expect(countsAtQueuedMessageStart).toEqual([0]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("throws when queueing an extension command with steer", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.steer("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("throws when queueing an extension command with followUp", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.followUp("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("delivers follow-ups queued during agent_end", async () => {
		let sent = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("agent_end", async () => {
						if (sent) return;
						sent = true;
						pi.sendUserMessage("conflict report", { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("reply"), fauxAssistantMessage("follow-up reply")]);

		await harness.session.prompt("hello");
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["hello", "conflict report"]);
	});

	// Part B (working spinner during the routing/prep phase): a queued steer() while streaming takes
	// the early-return branch in _promptUnserialized (before the routing_start emit added for the
	// working-spinner bracket), so it must not add a second routing_start/routing_end pair — only the
	// ORIGINAL prompt that's actually streaming ever entered that phase.
	it("does not emit an extra routing_start/routing_end pair for a message queued via steer()", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await waitForToolStart;
		await harness.session.steer("queued");
		releaseToolExecution();
		await promptPromise;

		expect(harness.eventsOfType("routing_start")).toHaveLength(1);
		expect(harness.eventsOfType("routing_end")).toHaveLength(1);
	});
});
