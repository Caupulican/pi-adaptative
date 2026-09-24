import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	resolveSelfCompactionSettings,
	SELF_COMPACT_TOOL_NAME,
	SELF_COMPACTION_ABANDONED_CUSTOM_TYPE,
	SELF_COMPACTION_HANDOFF_CUSTOM_TYPE,
	SELF_COMPACTION_MAX_ATTEMPTS,
	SELF_COMPACTION_REQUEST_CUSTOM_TYPE,
	SELF_COMPACTION_SUMMARY_INSTRUCTIONS,
} from "../src/core/compaction/self-compaction.ts";
import {
	createSelfCompactToolDefinition,
	SelfCompactionController,
} from "../src/core/compaction/self-compaction-controller.ts";

const WINDOW = 100_000;
const HARD = 90_000;
const EARLY = 60_000;
const NOTICE = Math.floor(EARLY * 0.7);
const WARNING = Math.floor(EARLY * 0.85);
const FORCED = Math.floor(HARD * 0.95);

type CompactMode = "succeed" | "fail" | "cancel" | "untagged";

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function batch(...calls: Array<{ name: string; arguments?: Record<string, unknown> }>): AssistantMessage {
	return {
		...assistantMessage(),
		content: calls.map((call, index) => ({
			type: "toolCall" as const,
			id: `call-${index}`,
			name: call.name,
			arguments: call.arguments ?? {},
		})),
		stopReason: "toolUse",
	};
}

function setup(
	options: {
		tokens?: number;
		compactable?: boolean;
		manager?: SessionManager;
		settings?: Parameters<typeof resolveSelfCompactionSettings>[0];
	} = {},
) {
	const manager = options.manager ?? SessionManager.inMemory();
	if (!options.manager) manager.appendMessage({ role: "user", content: "start", timestamp: 1 });
	const world = {
		tokens: options.tokens ?? WARNING,
		compactable: options.compactable ?? true,
		compactMode: "succeed" as CompactMode,
		answer: true,
		awaitingOwner: false,
	};
	const calls = {
		compact: [] as string[],
		delivered: [] as unknown[],
		asked: [] as { customType: string; content: string }[],
		continued: 0,
		settled: 0,
		warnings: [] as string[],
		compactableChecks: 0,
	};
	const settings = resolveSelfCompactionSettings(options.settings ?? {});
	const controller: SelfCompactionController = new SelfCompactionController({
		getSessionManager: () => manager,
		getSettings: () => settings,
		getContextUsage: () => ({ tokens: world.tokens, contextWindow: WINDOW, percent: (world.tokens / WINDOW) * 100 }),
		getCachedTokens: () => Math.floor(world.tokens / 2),
		getHardTriggerTokens: () => HARD,
		getEarlyTriggerTokens: () => EARLY,
		hasCompactableHistory: () => {
			calls.compactableChecks++;
			return world.compactable;
		},
		compact: async (instructions) => {
			calls.compact.push(instructions);
			const firstId = manager.getBranch()[0]!.id;
			manager.appendCompactionStart(`c${calls.compact.length}`, firstId, world.tokens);
			if (world.compactMode === "fail" || world.compactMode === "cancel") {
				manager.appendCompactionEnd(
					`c${calls.compact.length}`,
					world.compactMode === "cancel" ? "cancelled" : "failure",
					world.compactMode === "fail" ? { error: "summarizer down" } : {},
				);
				throw new Error(world.compactMode === "cancel" ? "Compaction cancelled" : "summarizer down");
			}
			const state = controller.state();
			const id = manager.appendCompaction(
				"summary",
				firstId,
				world.tokens,
				world.compactMode === "untagged" ? {} : { selfCompaction: { handoffId: state.request?.id } },
			);
			manager.appendCompactionEnd(`c${calls.compact.length}`, "success", { compactionEntryId: id });
			world.tokens = 1_000;
		},
		deliverNote: async (message) => {
			calls.delivered.push(message);
			manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
			if (world.answer) manager.appendMessage(assistantMessage());
		},
		askForHandoff: async (message) => {
			calls.asked.push(message);
			manager.appendCustomMessageEntry(message.customType, message.content, message.display);
		},
		continueFromHandoff: async () => {
			calls.continued++;
			if (world.answer) manager.appendMessage(assistantMessage());
		},
		isForegroundBusy: () => false,
		waitForForegroundIdle: async () => {},
		isDisposed: () => false,
		isAwaitingOwner: () => world.awaitingOwner,
		onHandoffSettled: () => calls.settled++,
		warn: (message) => calls.warnings.push(message),
	});
	const runToIdle = () =>
		new Promise<void>((resolve) => {
			const off = controller.subscribeActivity(() => {
				if (controller.hasPendingContinuation()) return;
				off();
				resolve();
			});
			if (!controller.schedule()) {
				off();
				resolve();
			}
		});
	return { manager, world, calls, controller, runToIdle };
}

const NOTE = "Goal: ship X\nDone: edited src/a.ts\nNEXT ACTION: run npm test";

describe("self-compaction sibling tool calls", () => {
	it("refuses a sibling preflighted before self_compact in the same batch, before it can run", () => {
		const { controller } = setup();
		const message = batch({ name: "bash" }, { name: SELF_COMPACT_TOOL_NAME, arguments: { note_to_self: NOTE } });
		expect(controller.gateToolCall("bash", message)).toMatchObject({ block: true, terminate: true });
		expect(controller.gateToolCall(SELF_COMPACT_TOOL_NAME, message)).toBeUndefined();
	});

	it("refuses a sibling preflighted after self_compact saved its note, before it can run", () => {
		const { controller } = setup();
		const message = batch({ name: SELF_COMPACT_TOOL_NAME, arguments: { note_to_self: NOTE } }, { name: "write" });
		expect(controller.request(NOTE).accepted).toBe(true);
		expect(controller.gateToolCall("write", message)).toMatchObject({ block: true, terminate: true });
	});

	it("refuses a sibling after self_compact in batch order when every call is preflighted before any runs", () => {
		const { controller } = setup({ tokens: NOTICE });
		const message = batch({ name: SELF_COMPACT_TOOL_NAME, arguments: { note_to_self: NOTE } }, { name: "edit" });
		expect(controller.gateToolCall("edit", message)).toMatchObject({ block: true, terminate: true });
	});

	it("leaves an ordinary parallel batch alone at the warning line (control)", () => {
		const { controller } = setup();
		const message = batch({ name: "bash" }, { name: "read" }, { name: "grep" });
		for (const name of ["bash", "read", "grep"]) expect(controller.gateToolCall(name, message)).toBeUndefined();
	});

	it("runs siblings of a self_compact call it would refuse (control)", () => {
		const { controller } = setup({ tokens: NOTICE - 1 });
		const message = batch({ name: "bash" }, { name: SELF_COMPACT_TOOL_NAME, arguments: { note_to_self: NOTE } });
		expect(controller.gateToolCall("bash", message)).toBeUndefined();
		expect(controller.request(NOTE).accepted).toBe(false);
	});
});

describe("self-compaction forced line", () => {
	it("refuses every other tool at the forced line while there is history to compact", () => {
		const { controller } = setup({ tokens: FORCED });
		expect(controller.gateToolCall("read", batch({ name: "read" }))).toMatchObject({ block: true });
		expect(controller.gateToolCall(SELF_COMPACT_TOOL_NAME, batch({ name: SELF_COMPACT_TOOL_NAME }))).toBeUndefined();
		expect(controller.view()).toMatchObject({ level: "forced", toolsLocked: true });
	});

	it("never strands the agent at the forced line when nothing can be compacted (control)", () => {
		const { controller } = setup({ tokens: FORCED, compactable: false });
		expect(controller.gateToolCall("read", batch({ name: "read" }))).toBeUndefined();
		const outcome = controller.request(NOTE);
		expect(outcome.accepted).toBe(false);
		expect(outcome.accepted === false && outcome.reason).toContain("Nothing to compact");
	});
});

describe("self_compact tool", () => {
	it("reports usage without a note and refuses malformed or premature notes as operation outcomes", async () => {
		const { controller, manager } = setup({ tokens: NOTICE - 10 });
		const tool = createSelfCompactToolDefinition(() => controller);
		const view = await tool.execute("t1", {}, undefined, undefined, undefined as never);
		expect(JSON.parse((view.content[0] as { text: string }).text)).toMatchObject({
			level: "idle",
			usedTokens: NOTICE - 10,
		});
		for (const note of ["", "   ", "x".repeat(24_001), NOTE]) {
			const refused = await tool.execute("t2", { note_to_self: note }, undefined, undefined, undefined as never);
			expect(refused).toMatchObject({ isError: true, errorKind: "operation_outcome" });
		}
		expect(manager.getBranch().some((entry) => entry.type === "custom")).toBe(false);
	});

	it("saves the exact note once admitted and ends the turn", async () => {
		const { controller, manager } = setup();
		const tool = createSelfCompactToolDefinition(() => controller);
		const saved = await tool.execute("t1", { note_to_self: NOTE }, undefined, undefined, undefined as never);
		expect(saved).toMatchObject({ terminate: true });
		expect((saved.content[0] as { text: string }).text).not.toContain(NOTE);
		const record = manager.getBranch().find((entry) => entry.type === "custom");
		expect(record).toMatchObject({ customType: SELF_COMPACTION_REQUEST_CUSTOM_TYPE, data: { note: NOTE } });
	});
});

describe("self-compaction handoff runner", () => {
	it("compacts at the idle checkpoint, returns the exact note, and lets the next turn answer it", async () => {
		const { controller, calls, runToIdle } = setup();
		controller.request(NOTE);
		await runToIdle();
		expect(calls.compact).toEqual([SELF_COMPACTION_SUMMARY_INSTRUCTIONS]);
		expect(calls.delivered).toEqual([
			{
				customType: SELF_COMPACTION_HANDOFF_CUSTOM_TYPE,
				content: NOTE,
				display: true,
				details: { handoffId: controller.state().request!.id },
			},
		]);
		expect(controller.state().status).toBe("answered");
		expect(calls.settled).toBe(1);
		expect(controller.schedule()).toBe(false);
	});

	it("keeps the note across failed and cancelled attempts, then releases it after the bounded attempts", async () => {
		const { controller, calls, world, runToIdle, manager } = setup();
		controller.request(NOTE);
		world.compactMode = "fail";
		await runToIdle();
		expect(controller.state()).toMatchObject({ status: "pending", attempts: 1 });
		expect(calls.delivered).toEqual([]);
		world.compactMode = "cancel";
		await runToIdle();
		expect(controller.state()).toMatchObject({
			status: "pending",
			attempts: 2,
			lastError: "compaction was cancelled",
		});
		world.compactMode = "fail";
		await runToIdle();
		expect(controller.state().attempts).toBe(SELF_COMPACTION_MAX_ATTEMPTS);
		expect(controller.view().toolsLocked).toBe(true);
		await runToIdle();
		expect(controller.state().status).toBe("abandoned");
		expect(manager.getBranch().at(-1)).toMatchObject({ customType: SELF_COMPACTION_ABANDONED_CUSTOM_TYPE });
		expect(controller.view().toolsLocked).toBe(false);
		expect(calls.compact).toHaveLength(SELF_COMPACTION_MAX_ATTEMPTS);
		expect(calls.settled).toBe(0);
	});

	it("fails boundedly when a compaction resolves without carrying the note", async () => {
		const { controller, world, calls, runToIdle } = setup();
		controller.request(NOTE);
		world.compactMode = "untagged";
		await runToIdle();
		expect(calls.compact).toHaveLength(1);
		expect(calls.delivered).toEqual([]);
		expect(controller.state().status).toBe("abandoned");
		expect(controller.schedule()).toBe(false);
	});

	it("releases a note instead of stranding the agent when nothing is left to compact", async () => {
		const { controller, world, runToIdle, calls } = setup();
		controller.request(NOTE);
		world.compactable = false;
		await runToIdle();
		expect(controller.state().status).toBe("abandoned");
		expect(calls.compact).toEqual([]);
	});

	it("recovers after a restart: delivers a compacted note, and continues an unanswered one without replaying it", async () => {
		const first = setup();
		first.world.answer = false;
		first.controller.request(NOTE);
		await first.runToIdle();
		expect(first.controller.state().status).toBe("delivered");
		expect(first.calls.delivered).toHaveLength(1);
		expect(first.calls.continued).toBe(0);
		const restarted = setup({ manager: first.manager });
		await restarted.runToIdle();
		expect(restarted.calls.delivered).toEqual([]);
		expect(restarted.calls.continued).toBe(1);
		expect(restarted.controller.state().status).toBe("answered");
		const again = setup({ manager: first.manager });
		expect(again.controller.schedule()).toBe(false);
	});

	it("announces its start and its end to activity subscribers, with no polling", async () => {
		const { controller, runToIdle } = setup();
		const seen: boolean[] = [];
		controller.subscribeActivity(() => seen.push(controller.hasPendingContinuation()));
		controller.request(NOTE);
		await runToIdle();
		expect(seen).toEqual([true, false]);
	});

	it("never overtakes a question pending for the owner, and runs once it is answered", async () => {
		const { controller, world, calls, runToIdle } = setup();
		controller.request(NOTE);
		world.awaitingOwner = true;
		expect(controller.schedule()).toBe(false);
		expect(calls.compact).toEqual([]);
		world.awaitingOwner = false;
		await runToIdle();
		expect(calls.compact).toHaveLength(1);
		expect(controller.state().status).toBe("answered");
	});

	it("retries delivery on a later schedule when an unanswered continuation was interrupted, never in a loop", async () => {
		const { controller, world, calls, runToIdle } = setup();
		world.answer = false;
		controller.request(NOTE);
		await runToIdle();
		expect(calls.delivered).toHaveLength(1);
		expect(calls.continued).toBe(0);
		expect(controller.state().status).toBe("delivered");
	});
});

describe("self-compaction prompts and phase", () => {
	it("renders a configured notice prompt once per crossing and keeps its text while usage grows inside the level", () => {
		const { controller, world } = setup({
			tokens: NOTICE,
			settings: { prompts: { notice: "notice at {{used_tokens}}, forced {{forced_tokens}}, cycle {{cycle}}" } },
		});
		const first = controller.guidance();
		expect(first).toBe(
			`notice at ${NOTICE.toLocaleString("en-US")}, forced ${FORCED.toLocaleString("en-US")}, cycle 0`,
		);
		world.tokens = NOTICE + 500;
		expect(controller.guidance()).toBe(first);
		world.tokens = WARNING;
		expect(controller.guidance()).toContain("[self-compaction · warning]");
	});

	it("hands a configured summary prompt to the compaction and counts the finished cycle", async () => {
		const { controller, calls, runToIdle } = setup({
			settings: { prompts: { summary: "Summarize for cycle {{cycle}}; keep pending work pending." } },
		});
		expect(controller.request(NOTE).accepted).toBe(true);
		expect(controller.view()).toMatchObject({ phase: "compacting", cycles: 0 });
		await runToIdle();
		expect(calls.compact).toEqual(["Summarize for cycle 0; keep pending work pending."]);
		expect(controller.view()).toMatchObject({ phase: "clear", cycles: 1 });
		expect(controller.info()).toMatchObject({
			promptSources: {
				notice: "built-in",
				warning: "built-in",
				summary: "settings (compaction.selfMonitor.prompts.summary)",
			},
			note: null,
			running: false,
		});
	});

	it("reports the phase an operator needs: warning, forced only while tools are locked, and the saved note", () => {
		const { controller, world } = setup({ tokens: WARNING });
		expect(controller.view()).toMatchObject({ phase: "warning", cachedTokens: Math.floor(WARNING / 2) });
		world.tokens = FORCED;
		expect(controller.view()).toMatchObject({ phase: "forced", toolsLocked: true });
		world.compactable = false;
		expect(controller.view()).toMatchObject({ phase: "warning", toolsLocked: false });
		world.compactable = true;
		controller.request(NOTE);
		expect(controller.info().note).toBe(NOTE);
	});
});

describe("self-compaction on owner request", () => {
	it("reuses a saved note instead of asking the agent for another", async () => {
		const { controller, calls } = setup();
		controller.request(NOTE);
		const outcome = await controller.compactNow();
		expect(outcome).toEqual({ kind: "resumed", noteChars: NOTE.length });
		expect(calls.asked).toEqual([]);
		expect(controller.hasPendingContinuation()).toBe(true);
	});

	it("asks the agent for its note below the notice line, and then admits that note", async () => {
		const { controller, calls } = setup({ tokens: NOTICE - 1_000 });
		expect(controller.request(NOTE).accepted).toBe(false);
		expect(await controller.compactNow()).toEqual({ kind: "asked" });
		expect(calls.asked).toHaveLength(1);
		expect(controller.view().handoff.ownerRequested).toBe(true);
		expect(controller.request(NOTE).accepted).toBe(true);
		expect(controller.state().status).toBe("pending");
	});

	it("spends no model turn when there is nothing to compact or self-compaction is off", async () => {
		const empty = setup({ compactable: false });
		expect(await empty.controller.compactNow()).toMatchObject({ kind: "refused" });
		expect(empty.calls.asked).toEqual([]);
		const disabled = setup({ settings: { enabled: false } });
		expect(await disabled.controller.compactNow()).toMatchObject({ kind: "refused" });
		expect(disabled.calls.asked).toEqual([]);
	});

	it("does not overtake a pending owner question when asked to compact now", async () => {
		const { controller, world, calls } = setup();
		controller.request(NOTE);
		world.awaitingOwner = true;
		expect(await controller.compactNow()).toMatchObject({ kind: "refused" });
		expect(calls.compact).toEqual([]);
	});
});
