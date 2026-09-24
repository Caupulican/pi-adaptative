import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	SELF_COMPACT_TOOL_NAME,
	SELF_COMPACTION_GUIDANCE_CUSTOM_TYPE,
	SELF_COMPACTION_HANDOFF_CUSTOM_TYPE,
	SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE,
	SELF_COMPACTION_REQUEST_CUSTOM_TYPE,
} from "../../src/core/compaction/self-compaction.ts";
import { beginHumanInputRequest, createHumanInputRequest } from "../../src/core/human-input.ts";
import { publishHumanInputActivity } from "../../src/core/human-input-activity.ts";
import { formatSelfCompactionInfo } from "../../src/modes/interactive/report-commands.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import {
	createSelfCompactionSessions,
	entriesOf,
	filler,
	handoffNotes,
	handoffSettled,
	NOTE,
	reply,
	SETTINGS,
	script,
} from "./self-compaction-fixture.ts";

describe("self-compaction in a session", () => {
	const sessions = createSelfCompactionSessions();
	afterEach(() => sessions.cleanup());
	const { open, sessionAtWarning, savedNoteWithoutHandoff, reopen, crashImage, isHandoffLine, answeredHandoff } =
		sessions;

	it("tells the agent once per level, refuses the sibling, compacts, returns the exact note and continues on its own", async () => {
		const harness = await sessionAtWarning();
		const readCall = fauxToolCall("read", { path: "does-not-exist.md" });
		const counts = script(harness, [
			reply([readCall, fauxToolCall(SELF_COMPACT_TOOL_NAME, { note_to_self: NOTE })], { stopReason: "toolUse" }),
			reply("continuing from my note"),
		]);
		const done = handoffSettled(harness);
		await harness.session.prompt("keep going");
		await done;

		const guidance = entriesOf(harness, SELF_COMPACTION_GUIDANCE_CUSTOM_TYPE);
		expect(guidance.length).toBeGreaterThanOrEqual(1);
		expect(new Set(guidance.map((entry) => (entry.type === "custom_message" ? entry.content : ""))).size).toBe(
			guidance.length,
		);
		const readResult = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === readCall.id,
		);
		expect(JSON.stringify(readResult)).toContain(`${SELF_COMPACT_TOOL_NAME} is in the same batch`);
		expect(JSON.stringify(readResult)).not.toContain("ENOENT");
		const [request] = entriesOf(harness, SELF_COMPACTION_REQUEST_CUSTOM_TYPE);
		const handoffId = request?.type === "custom" ? (request.data as { id: string }).id : undefined;
		expect(handoffId).toBeDefined();
		const compaction = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");
		expect(compaction?.type === "compaction" && compaction.details).toMatchObject({ selfCompaction: { handoffId } });
		expect(handoffNotes(harness)).toEqual([NOTE]);
		expect(counts.summaries).toBeGreaterThan(0);
		const lastAssistant = harness.session.messages.filter((message) => message.role === "assistant").at(-1);
		expect(JSON.stringify(lastAssistant)).toContain("continuing from my note");
		expect(harness.session.getSelfCompactionView()).toMatchObject({
			level: "idle",
			toolsLocked: false,
			handoff: { status: "answered" },
		});
	});

	it("keeps ordinary parallel tool calls running at the warning line (control)", async () => {
		const harness = await sessionAtWarning();
		const first = fauxToolCall("read", { path: "a.md" });
		const second = fauxToolCall("read", { path: "b.md" });
		script(harness, [reply([first, second], { stopReason: "toolUse" }), reply("read both")]);
		await harness.session.prompt("read two files");
		const results = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(results.map((result) => JSON.stringify(result)).some((text) => text.includes("same batch"))).toBe(false);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(harness.session.getSelfCompactionView().handoff.status).toBe("none");
	});

	it("tells native activity watchers when the handoff runner starts and settles", async () => {
		const harness = await sessionAtWarning();
		await savedNoteWithoutHandoff(harness);
		const settledAtNotice: boolean[] = [];
		const off = harness.session.nativeActivity.subscribePendingContinuation(() =>
			settledAtNotice.push(harness.session.nativeActivity.isSettled()),
		);
		script(harness, [reply("resumed from the note")]);
		const done = handoffSettled(harness);
		expect(harness.session.resumeSelfCompaction()).toBe(true);
		await done;
		off();
		expect(settledAtNotice[0]).toBe(false);
		expect(settledAtNotice.at(-1)).toBe(true);
		expect(harness.session.getSelfCompactionView().handoff.status).toBe("answered");
	});

	it("waits for a pending owner question and resumes when it is answered", async () => {
		const harness = await sessionAtWarning();
		await savedNoteWithoutHandoff(harness);
		const question = fauxToolCall("ask_question", { questions: [{ question: "Which file?" }] });
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage([question], { stopReason: "toolUse" }),
			api: harness.getModel().api,
			provider: harness.getModel().provider,
			model: harness.getModel().id,
		});
		const request = createHumanInputRequest({
			source: "tool",
			toolCallId: question.id,
			toolName: "ask_question",
			questions: [
				{
					id: "file",
					header: "File",
					question: "Which file?",
					options: [
						{ label: "notes.md", description: "The notes." },
						{ label: "summary.md", description: "The summary." },
					],
				},
			],
			acceptsImages: false,
		});
		beginHumanInputRequest(harness.sessionManager, request);
		expect(harness.session.resumeSelfCompaction()).toBe(false);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: question.id,
			toolName: "ask_question",
			content: [{ type: "text", text: "notes.md" }],
			isError: false,
			timestamp: Date.now(),
		});
		script(harness, [reply("resumed after the answer")]);
		const done = handoffSettled(harness);
		publishHumanInputActivity(harness.sessionManager, { phase: "settled", request });
		await done;
		expect(harness.session.getSelfCompactionView().handoff.status).toBe("answered");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
	});

	it("recovers a note saved before a restart in a freshly reconstructed session", async () => {
		const first = await sessionAtWarning({ persistSession: true });
		await savedNoteWithoutHandoff(first);
		const second = await reopen(first);
		expect(second.session.getSelfCompactionView().handoff.status).toBe("pending");
		script(second, [reply("resumed after the restart")]);
		const done = handoffSettled(second);
		expect(second.session.resumeSelfCompaction()).toBe(true);
		await done;
		expect(second.session.getSelfCompactionView().handoff.status).toBe("answered");
		expect(handoffNotes(second)).toEqual([NOTE]);
	});

	it("continues after a crash between note delivery and the first answer, without replaying the note", async () => {
		const first = await answeredHandoff([reply("continuing from my note")]);
		const second = await crashImage(first, isHandoffLine);
		expect(second.session.getSelfCompactionView().handoff.status).toBe("delivered");
		script(second, [reply("picked up after the crash")]);
		const continued = handoffSettled(second);
		expect(second.session.resumeSelfCompaction()).toBe(true);
		await continued;
		expect(second.session.getSelfCompactionView().handoff.status).toBe("answered");
		expect(handoffNotes(second)).toEqual([NOTE]);
		const lastAssistant = second.session.messages.filter((message) => message.role === "assistant").at(-1);
		expect(JSON.stringify(lastAssistant)).toContain("picked up after the crash");
	});

	it("continues a note whose first answer failed at the provider, after a restart, without replaying it", async () => {
		const first = await sessionAtWarning({ persistSession: true });
		script(first, [
			reply([fauxToolCall(SELF_COMPACT_TOOL_NAME, { note_to_self: NOTE })], { stopReason: "toolUse" }),
			reply("", { stopReason: "error", errorMessage: "connection reset" }),
		]);
		const delivered = handoffSettled(first);
		await first.session.prompt("wrap up");
		await delivered;
		expect(first.session.getSelfCompactionView().handoff.status).toBe("delivered");

		const second = await reopen(first);
		expect(second.session.getSelfCompactionView().handoff.status).toBe("delivered");
		script(second, [reply("picked up after the restart")]);
		const continued = handoffSettled(second);
		expect(second.session.resumeSelfCompaction()).toBe(true);
		await continued;
		expect(second.session.getSelfCompactionView().handoff.status).toBe("answered");
		expect(handoffNotes(second)).toEqual([NOTE]);
		const lastAssistant = second.session.messages.filter((message) => message.role === "assistant").at(-1);
		expect(JSON.stringify(lastAssistant)).toContain("picked up after the restart");
	});

	it("does not re-drive a handoff the agent already acted on when a crash lands inside its first tool batch", async () => {
		const first = await answeredHandoff([
			reply([fauxToolCall("read", { path: "summary.md" })], { stopReason: "toolUse" }),
			reply("done"),
		]);
		const second = await crashImage(
			first,
			(entry, index, lines) =>
				entry.type === "message" &&
				entry.message?.role === "assistant" &&
				lines.slice(0, index).some(isHandoffLine),
		);
		const entriesBefore = second.sessionManager.getEntries().length;
		expect(second.session.getSelfCompactionView().handoff.status).toBe("answered");
		expect(second.session.resumeSelfCompaction()).toBe(false);
		expect(second.sessionManager.getEntries()).toHaveLength(entriesBefore);
		expect(handoffNotes(second)).toEqual([NOTE]);
		expect(
			second.session.messages.some(
				(message) => message.role === "custom" && message.customType === SELF_COMPACTION_HANDOFF_CUSTOM_TYPE,
			),
		).toBe(true);
		expect(second.session.messages.at(-1)?.role).toBe("toolResult");
	});

	it("never replays an answered handoff after a restart", async () => {
		const first = await answeredHandoff([reply("continuing from my note")]);
		const second = await reopen(first);
		const entriesBefore = second.sessionManager.getEntries().length;
		expect(second.session.getSelfCompactionView().handoff.status).toBe("answered");
		expect(second.session.resumeSelfCompaction()).toBe(false);
		expect(second.sessionManager.getEntries()).toHaveLength(entriesBefore);
		expect(handoffNotes(second)).toEqual([NOTE]);
	});

	it("prints the self-compaction report without spending a model turn", async () => {
		const harness = await sessionAtWarning();
		await savedNoteWithoutHandoff(harness);
		const entries = harness.sessionManager.getEntries().length;
		const pending = harness.getPendingResponseCount();
		initTheme("dark");
		const report = stripAnsi(formatSelfCompactionInfo(harness.session));
		expect(report).toContain("Phase: compacting");
		expect(report).toContain("Cycles completed: 0");
		expect(report).toContain("Prompts: notice built-in; warning built-in; summary built-in");
		expect(report).toContain(NOTE);
		expect(harness.sessionManager.getEntries()).toHaveLength(entries);
		expect(harness.getPendingResponseCount()).toBe(pending);
		expect(harness.session.getSelfCompactionView().handoff.status).toBe("pending");
	});

	it("compacts on the owner's request below the notice line: asks for the note, compacts, returns it", async () => {
		const harness = await open();
		for (let turn = 0; turn < 4; turn++) {
			script(harness, [reply(`noted ${turn}`)]);
			await harness.session.prompt(`context ${turn}: ${filler(1_500)}`);
		}
		expect(harness.session.getSelfCompactionView().level).toBe("idle");
		script(harness, [
			reply([fauxToolCall(SELF_COMPACT_TOOL_NAME, { note_to_self: NOTE })], { stopReason: "toolUse" }),
			reply("continuing on the owner's request"),
		]);
		const done = handoffSettled(harness);
		expect(await harness.session.selfCompactNow()).toEqual({ kind: "asked" });
		await done;
		expect(entriesOf(harness, SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE)).toHaveLength(1);
		expect(handoffNotes(harness)).toEqual([NOTE]);
		expect(harness.session.getSelfCompactionView()).toMatchObject({ cycles: 1, handoff: { status: "answered" } });
	});

	it("reuses the saved note on the owner's request instead of asking again", async () => {
		const harness = await sessionAtWarning();
		await savedNoteWithoutHandoff(harness);
		script(harness, [reply("resumed on request")]);
		const done = handoffSettled(harness);
		expect(await harness.session.selfCompactNow()).toEqual({ kind: "resumed", noteChars: NOTE.length });
		await done;
		expect(entriesOf(harness, SELF_COMPACTION_OWNER_REQUEST_CUSTOM_TYPE)).toHaveLength(0);
		expect(handoffNotes(harness)).toEqual([NOTE]);
	});

	it("keeps the compactable-history preflight off repeated reads at the forced line while the gate still refuses", async () => {
		const harness = await sessionAtWarning(
			{ settings: { compaction: { ...SETTINGS.compaction, selfMonitor: { forced: 0.01 } } } },
			"forced",
		);
		const forcedTokens = harness.session.getSelfCompactionView().thresholds!.forcedTokens;
		for (let turn = 0; turn < 4; turn++) {
			script(harness, [reply(`held ${turn}`)]);
			await harness.session.prompt(`more context ${turn}: ${filler(Math.ceil(forcedTokens / 20))}`);
		}
		const getBranch = vi.spyOn(harness.sessionManager, "getBranch");
		for (let read = 0; read < 50; read++) expect(harness.session.getSelfCompactionView().phase).toBe("forced");
		expect(getBranch.mock.calls.length).toBeLessThanOrEqual(1);
		const readCall = fauxToolCall("read", { path: "a.md" });
		script(harness, [reply([readCall], { stopReason: "toolUse" }), reply("stopped")]);
		await harness.session.prompt("read a file");
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === readCall.id,
		);
		expect(JSON.stringify(result)).toContain("forced self-compaction line");
		const before = getBranch.mock.calls.length;
		harness.session.getSelfCompactionView();
		expect(getBranch.mock.calls.length).toBeGreaterThan(before);
	});

	it("returns a saved note after the owner compacts manually, without waiting for another prompt", async () => {
		const harness = await sessionAtWarning();
		await savedNoteWithoutHandoff(harness);
		script(harness, [reply("continuing after the manual compaction")]);
		const done = handoffSettled(harness);
		await harness.session.compact();
		await done;
		expect(handoffNotes(harness)).toEqual([NOTE]);
		expect(harness.session.getSelfCompactionView()).toMatchObject({ cycles: 1, handoff: { status: "answered" } });
	});

	it("lets an ignored owner request lapse, so a later note below the notice line buys no summary", async () => {
		const harness = await open();
		for (let turn = 0; turn < 4; turn++) {
			script(harness, [reply(`noted ${turn}`)]);
			await harness.session.prompt(`context ${turn}: ${filler(1_500)}`);
		}
		script(harness, [reply("nothing worth handing off yet")]);
		expect(await harness.session.selfCompactNow()).toEqual({ kind: "asked" });
		expect(harness.session.getSelfCompactionView().handoff.ownerRequested).toBe(false);
		const call = fauxToolCall(SELF_COMPACT_TOOL_NAME, { note_to_self: NOTE });
		script(harness, [reply([call], { stopReason: "toolUse" }), reply("kept working")]);
		await harness.session.prompt("carry on");
		const result = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === call.id,
		);
		expect(JSON.stringify(result)).toContain("below the notice line");
		expect(entriesOf(harness, SELF_COMPACTION_REQUEST_CUSTOM_TYPE)).toHaveLength(0);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});
});
