import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage, ToolResultMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { BashExecutionMessage } from "../../src/messages.ts";
import { SessionManager } from "../../src/session/session-manager.ts";

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ready" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function toolResultMessage(index: number, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${index}`,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: index + 2,
	};
}

describe("SessionManager lazy session payload loading", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("does not retain large persisted payloads while reopening an uncompacted session", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-session-load-"));
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir, dir);
		session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		session.appendMessage(assistantMessage());

		const payloads = Array.from(
			{ length: 8 },
			(_, index) => `payload-${index}-prefix-${String(index).repeat(32 * 1024)}-payload-${index}-tail`,
		);
		const entryIds = payloads.map((payload, index) => session.appendMessage(toolResultMessage(index, payload)));
		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeTypeOf("string");
		if (!sessionFile) return;

		const reopened = SessionManager.open(sessionFile, dir, dir);
		for (const entryId of entryIds) {
			const entry = reopened.getEntry(entryId);
			expect(entry?.type).toBe("message");
			if (entry?.type !== "message") continue;
			expect(Object.getOwnPropertyDescriptor(entry.message, "content")?.get).toBeTypeOf("function");
		}

		const context = reopened.buildSessionContext();
		const toolResults = context.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult",
		);
		expect(toolResults.map((message) => message.content[0])).toEqual(
			payloads.map((text) => ({ type: "text", text })),
		);
		for (const entryId of entryIds) {
			const entry = reopened.getEntry(entryId);
			if (entry?.type === "message") {
				expect(Object.getOwnPropertyDescriptor(entry.message, "content")?.get).toBeTypeOf("function");
			}
		}
	});

	it("releases one just-persisted large payload through its bounded suffix index", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-session-append-"));
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir, dir);
		session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		session.appendMessage(assistantMessage());
		const payload = `live-prefix-${"x".repeat(32 * 1024)}-live-tail`;
		const entryId = session.appendMessage(toolResultMessage(1, payload));

		session.releasePersistedMessagePayload(entryId);

		const entry = session.getEntry(entryId);
		expect(entry?.type).toBe("message");
		if (entry?.type !== "message") return;
		expect(Object.getOwnPropertyDescriptor(entry.message, "content")?.get).toBeTypeOf("function");
		let persistedBytes: number | undefined;
		const entryIndex = session.getEntries().findIndex((candidate) => candidate.id === entryId);
		session.visitEntries(entryIndex, 1, (_candidate, _index, bytes) => {
			persistedBytes = bytes;
		});
		expect(persistedBytes).toBeTypeOf("number");
		expect(Number.isFinite(persistedBytes)).toBe(true);
		expect((entry.message as ToolResultMessage).content).toEqual([{ type: "text", text: payload }]);
		expect(Object.getOwnPropertyDescriptor(entry.message, "content")?.get).toBeTypeOf("function");
		expect(JSON.stringify(entry)).toContain("live-tail");
		expect(Object.getOwnPropertyDescriptor(entry.message, "content")?.get).toBeTypeOf("function");
	});

	it("leaves a below-threshold persisted payload as an ordinary data property", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-session-small-append-"));
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir, dir);
		session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		session.appendMessage(assistantMessage());
		const message = toolResultMessage(1, "small payload");
		const entryId = session.appendMessage(message);

		session.releasePersistedMessagePayload(entryId);

		const entry = session.getEntry(entryId);
		expect(entry?.type).toBe("message");
		if (entry?.type !== "message") return;
		const descriptor = Object.getOwnPropertyDescriptor(entry.message, "content");
		expect(descriptor?.get).toBeUndefined();
		expect(descriptor?.value).toBe(message.content);
		expect((entry.message as ToolResultMessage).content).toEqual([{ type: "text", text: "small payload" }]);
	});

	it("rejects missing and non-message entry ids", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-session-invalid-entry-"));
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir, dir);
		session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		session.appendMessage(assistantMessage());
		const thinkingEntryId = session.appendThinkingLevelChange("high");

		expect(() => session.releasePersistedMessagePayload("missing-entry")).toThrow(
			/entry missing-entry is not a persisted message/i,
		);
		expect(() => session.releasePersistedMessagePayload(thinkingEntryId)).toThrow(
			new RegExp(`entry ${thinkingEntryId} is not a persisted message`, "i"),
		);
	});

	it("rejects release before the message is durably flushed", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-session-unflushed-"));
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir, dir);
		const payload = `unflushed-prefix-${"x".repeat(32 * 1024)}-unflushed-tail`;
		const entryId = session.appendMessage(toolResultMessage(1, payload));

		expect(() => session.releasePersistedMessagePayload(entryId)).toThrow(/not durably persisted/i);
		const entry = session.getEntry(entryId);
		expect(entry?.type).toBe("message");
		if (entry?.type !== "message") return;
		expect(Object.getOwnPropertyDescriptor(entry.message, "content")?.get).toBeUndefined();
		expect((entry.message as ToolResultMessage).content).toEqual([{ type: "text", text: payload }]);
	});

	it("restores the exact large output of a persisted legacy bash message", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-session-bash-output-"));
		tempDirs.push(dir);
		const session = SessionManager.create(dir, dir, dir);
		session.appendMessage({ role: "user", content: "start", timestamp: 1 });
		session.appendMessage(assistantMessage());
		const output = `bash-prefix-λ-${"x".repeat(32 * 1024)}-bash-tail-終`;
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command: "legacy-command",
			output,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 3,
		};
		const entryId = session.appendMessage(bashMessage);

		session.releasePersistedMessagePayload(entryId);

		const entry = session.getEntry(entryId);
		expect(entry?.type).toBe("message");
		if (entry?.type !== "message") return;
		expect(Object.getOwnPropertyDescriptor(entry.message, "output")?.get).toBeTypeOf("function");
		expect((entry.message as BashExecutionMessage).output).toBe(output);
		expect(Object.getOwnPropertyDescriptor(entry.message, "output")?.get).toBeTypeOf("function");

		const sessionFile = session.getSessionFile();
		expect(sessionFile).toBeTypeOf("string");
		if (!sessionFile) return;
		const reopened = SessionManager.open(sessionFile, dir, dir);
		const reopenedEntry = reopened.getEntry(entryId);
		expect(reopenedEntry?.type).toBe("message");
		if (reopenedEntry?.type !== "message") return;
		expect(Object.getOwnPropertyDescriptor(reopenedEntry.message, "output")?.get).toBeTypeOf("function");
		expect((reopenedEntry.message as BashExecutionMessage).output).toBe(output);
	});

	it("binds released payload getters to an independent branched manager", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-session-branch-"));
		tempDirs.push(dir);
		const source = SessionManager.create(dir, dir, dir);
		source.appendMessage({ role: "user", content: "start", timestamp: 1 });
		source.appendMessage(assistantMessage());
		const payload = `branch-prefix-${"x".repeat(32 * 1024)}-branch-tail`;
		const toolResultId = source.appendMessage(toolResultMessage(1, payload));
		source.releasePersistedMessagePayload(toolResultId);

		const branched = source.createBranchedSessionManager(toolResultId);
		source.newSession();

		const result = branched
			.buildSessionContext()
			.messages.find((message): message is ToolResultMessage => message.role === "toolResult");
		expect(result?.content).toEqual([{ type: "text", text: payload }]);
	});

	it("reopens history larger than the V8 heap by releasing each payload during the load pass", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-lazy-session-low-heap-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "large-session.jsonl");
		const fd = openSync(sessionFile, "w");
		try {
			writeFileSync(
				fd,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "low-heap-session",
					timestamp: "2026-08-02T00:00:00.000Z",
					cwd: dir,
				})}\n`,
			);
			const payload = "x".repeat(1024 * 1024);
			let parentId: string | null = null;
			for (let index = 0; index < 40; index++) {
				const id = `entry-${index}`;
				writeFileSync(
					fd,
					`${JSON.stringify({
						type: "message",
						id,
						parentId,
						timestamp: "2026-08-02T00:00:01.000Z",
						message: toolResultMessage(index, `${index}-${payload}`),
					})}\n`,
				);
				parentId = id;
			}
		} finally {
			closeSync(fd);
		}

		const scriptFile = join(dir, "open-session.mjs");
		const sessionManagerUrl = pathToFileURL(join(import.meta.dirname, "../../src/session/session-manager.ts")).href;
		writeFileSync(
			scriptFile,
			`import { SessionManager } from ${JSON.stringify(sessionManagerUrl)};\n` +
				`const manager = SessionManager.open(process.argv[2], process.argv[3], process.argv[3]);\n` +
				`const cold = manager.getEntries().filter((entry) => entry.type === "message" && typeof Object.getOwnPropertyDescriptor(entry.message, "content")?.get === "function").length;\n` +
				`if (cold !== 40) throw new Error(\`expected 40 cold payloads, received \${cold}\`);\n`,
		);

		const child = spawnSync(
			process.execPath,
			["--max-old-space-size=32", "--experimental-strip-types", scriptFile, sessionFile, dir],
			{ encoding: "utf-8", timeout: 30_000, maxBuffer: 1024 * 1024 },
		);
		expect(child.error).toBeUndefined();
		expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
	});
});
