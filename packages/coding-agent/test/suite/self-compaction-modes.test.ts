import { fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import {
	SELF_COMPACT_TOOL_NAME,
	SELF_COMPACTION_HANDOFF_CUSTOM_TYPE,
} from "../../src/core/compaction/self-compaction.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import type { Harness } from "./harness.ts";
import {
	createSelfCompactionSessions,
	handoffNotes,
	handoffSettled,
	NOTE,
	reply,
	script,
} from "./self-compaction-fixture.ts";

const io = vi.hoisted(() => ({
	written: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.ts", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (text: string) => {
		io.written.push(text);
	},
}));

vi.mock("../../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		io.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

function runtimeHostFor(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

function messageIndex(harness: Harness, predicate: (text: string) => boolean): number {
	return harness.sessionManager
		.getEntries()
		.findIndex(
			(entry) => (entry.type === "message" || entry.type === "custom_message") && predicate(JSON.stringify(entry)),
		);
}

function assistantReplies(harness: Harness): number {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
}

function rpcResponses(command: string): Array<{ id?: string; success: boolean; data?: unknown }> {
	return io.written
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map(
			(line) =>
				JSON.parse(line) as { type?: string; command?: string; id?: string; success: boolean; data?: unknown },
		)
		.filter((record) => record.type === "response" && record.command === command);
}

describe("self-compaction handoff in print and RPC modes", () => {
	const sessions = createSelfCompactionSessions();
	afterEach(async () => {
		io.written = [];
		io.lineHandler = undefined;
		await sessions.cleanup();
	});
	const { sessionAtWarning, savedNoteWithoutHandoff, reopen, crashImage, isHandoffLine, answeredHandoff } = sessions;

	it("print mode finishes a saved note before the new prompt after a restart", async () => {
		const first = await sessionAtWarning({ persistSession: true });
		await savedNoteWithoutHandoff(first);
		const second = await reopen(first);
		script(second, [reply("resumed from the note"), reply("answer to the next task")]);
		expect(await runPrintMode(runtimeHostFor(second), { mode: "text", initialMessage: "next task" })).toBe(0);
		expect(handoffNotes(second)).toEqual([NOTE]);
		expect(second.session.getSelfCompactionView().handoff.status).toBe("answered");
		const note = second.sessionManager
			.getEntries()
			.findIndex(
				(entry) => entry.type === "custom_message" && entry.customType === SELF_COMPACTION_HANDOFF_CUSTOM_TYPE,
			);
		const prompt = messageIndex(second, (text) => text.includes('"next task"'));
		expect(note).toBeGreaterThan(-1);
		expect(note).toBeLessThan(prompt);
		expect(io.written.join("")).toContain("answer to the next task");
	});

	it("print mode continues a note delivered before a crash without sending it again", async () => {
		const first = await answeredHandoff([reply("continuing from my note")]);
		const second = await crashImage(first, isHandoffLine);
		expect(second.session.getSelfCompactionView().handoff.status).toBe("delivered");
		script(second, [reply("picked up after the crash"), reply("answer to the next task")]);
		expect(await runPrintMode(runtimeHostFor(second), { mode: "text", initialMessage: "next task" })).toBe(0);
		expect(handoffNotes(second)).toEqual([NOTE]);
		const continued = messageIndex(second, (text) => text.includes("picked up after the crash"));
		const prompt = messageIndex(second, (text) => text.includes('"next task"'));
		expect(continued).toBeGreaterThan(-1);
		expect(continued).toBeLessThan(prompt);
	});

	it("print mode never resumes a handoff the owner aborted or the agent already answered", async () => {
		const first = await answeredHandoff([reply("", { stopReason: "aborted" })]);
		const second = await reopen(first);
		const before = assistantReplies(second);
		script(second, [reply("answer to the next task")]);
		expect(await runPrintMode(runtimeHostFor(second), { mode: "text", initialMessage: "next task" })).toBe(0);
		expect(assistantReplies(second)).toBe(before + 1);
		expect(handoffNotes(second)).toEqual([NOTE]);
		expect(io.written.join("")).toContain("answer to the next task");
	});

	it("print mode waits for a handoff saved during its own run and prints the continued reply", async () => {
		const harness = await sessionAtWarning();
		script(harness, [
			reply([fauxToolCall(SELF_COMPACT_TOOL_NAME, { note_to_self: NOTE })], { stopReason: "toolUse" }),
			reply("continued from the note"),
		]);
		expect(await runPrintMode(runtimeHostFor(harness), { mode: "text", initialMessage: "wrap up" })).toBe(0);
		expect(harness.session.getSelfCompactionView().handoff.status).toBe("answered");
		expect(handoffNotes(harness)).toEqual([NOTE]);
		expect(io.written.join("")).toContain("continued from the note");
	});

	it("RPC mode resumes a note delivered before a crash at startup, once", async () => {
		const first = await answeredHandoff([reply("continuing from my note")]);
		const second = await crashImage(first, isHandoffLine);
		script(second, [reply("picked up in rpc")]);
		const done = handoffSettled(second);
		void runRpcMode(runtimeHostFor(second));
		await done;
		expect(second.session.getSelfCompactionView().handoff.status).toBe("answered");
		expect(handoffNotes(second)).toEqual([NOTE]);
	});

	it("RPC reports self-compaction without a model turn and compacts a saved note on request", async () => {
		const harness = await sessionAtWarning();
		await savedNoteWithoutHandoff(harness);
		const internals = harness.session as unknown as { _selfCompaction: { schedule(): boolean } };
		const schedule = internals._selfCompaction.schedule.bind(internals._selfCompaction);
		internals._selfCompaction.schedule = () => false;
		void runRpcMode(runtimeHostFor(harness));
		await vi.waitFor(() => expect(io.lineHandler).toBeDefined());
		const pending = harness.getPendingResponseCount();
		io.lineHandler!(JSON.stringify({ id: "info", type: "get_self_compaction" }));
		await vi.waitFor(() => expect(rpcResponses("get_self_compaction")).toHaveLength(1));
		expect(rpcResponses("get_self_compaction")[0]).toMatchObject({
			id: "info",
			success: true,
			data: { view: { phase: "compacting", handoff: { status: "pending" } }, note: NOTE },
		});
		expect(harness.getPendingResponseCount()).toBe(pending);
		internals._selfCompaction.schedule = schedule;
		script(harness, [reply("resumed on the rpc request")]);
		const done = handoffSettled(harness);
		io.lineHandler!(JSON.stringify({ id: "now", type: "self_compact_now" }));
		await vi.waitFor(() => expect(rpcResponses("self_compact_now")).toHaveLength(1));
		expect(rpcResponses("self_compact_now")[0]).toMatchObject({
			success: true,
			data: { kind: "resumed", noteChars: NOTE.length },
		});
		await done;
		expect(handoffNotes(harness)).toEqual([NOTE]);
	});
});
