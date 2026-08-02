import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage, ToolResultMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
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
			if (!entry || entry.type !== "message") continue;
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
