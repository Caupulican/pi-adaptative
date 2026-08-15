import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";
import { isPiSessionJsonlPath, projectPiSessionJsonlLine } from "../src/core/tools/session-transcript-read.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

describe("Pi session jsonl read projection", () => {
	let tempDir: string;
	let sessionFile: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-read-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const sessionDir = join(tempDir, ".pi", "agent", "sessions", "cwd");
		mkdirSync(sessionDir, { recursive: true });
		sessionFile = join(sessionDir, "2026-01-01T00-00-00-000Z_01test.jsonl");
		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", id: "01test" }),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: [{ type: "text", text: "continue the prior task" }] },
				}),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "SECRET_THINKING", thinkingSignature: "encrypted-blob" },
							{ type: "text", text: "I will inspect the tree." },
							{ type: "toolCall", name: "read", arguments: { path: "/secret" } },
						],
					},
				}),
				JSON.stringify({
					type: "message",
					message: {
						role: "toolResult",
						toolName: "read",
						isError: false,
						content: [{ type: "text", text: "HUGE_PAYLOAD" }],
					},
				}),
				JSON.stringify({
					type: "message",
					message: {
						role: "toolResult",
						toolName: "goal",
						isError: true,
						content: [
							{
								type: "text",
								text: '[harness] {"failure_code":"owner_authorization_required"}',
							},
						],
					},
				}),
			].join("\n"),
		);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("detects session store paths", () => {
		expect(isPiSessionJsonlPath(sessionFile)).toBe(true);
		expect(isPiSessionJsonlPath(join(tempDir, "notes.jsonl"))).toBe(false);
	});

	it("omits thinking, signatures, and successful tool payloads", () => {
		const projected = projectPiSessionJsonlLine(
			JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "SECRET_THINKING" },
						{ type: "text", text: "Visible reply" },
					],
				},
			}),
		);
		expect(projected).toBe("ASSISTANT Visible reply");
		expect(projected).not.toContain("SECRET");
	});

	it("returns a labeled transcript when the read tool opens a session file", async () => {
		const tool = createReadTool(tempDir);
		const result = await tool.execute("read-session", { path: sessionFile });
		const text = textOf(result);
		expect(text).toContain("Pi session transcript");
		expect(text).toContain("USER continue the prior task");
		expect(text).toContain("ASSISTANT I will inspect the tree.");
		expect(text).toContain("TOOL read");
		expect(text).toContain("TOOLERR goal owner_authorization_required");
		expect(text).not.toContain("SECRET_THINKING");
		expect(text).not.toContain("encrypted-blob");
		expect(text).not.toContain("HUGE_PAYLOAD");
	});
});
