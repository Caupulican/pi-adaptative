import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
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
				JSON.stringify({
					type: "compaction",
					summary: "Durable objective and verified handoff survive compaction.",
					details: { privatePayload: "PRIVATE_COMPACTION_DETAILS" },
				}),
				JSON.stringify({
					type: "branch_summary",
					summary: "The selected branch keeps its unresolved risk.",
					details: { privatePayload: "PRIVATE_BRANCH_DETAILS" },
				}),
				JSON.stringify({
					type: "custom",
					customType: "private-state",
					data: { summary: "PRIVATE_CUSTOM_STATE" },
				}),
			].join("\n"),
		);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("detects session store paths", () => {
		expect(isPiSessionJsonlPath(sessionFile)).toBe(true);
		const customSessionRoot = join(tempDir, "custom-agent-home", "sessions");
		expect(
			isPiSessionJsonlPath(
				join(customSessionRoot, "cwd", "2026-01-01T00-00-00-000Z_01custom.jsonl"),
				customSessionRoot,
			),
		).toBe(true);
		expect(isPiSessionJsonlPath(join(`${customSessionRoot}-other`, "session.jsonl"), customSessionRoot)).toBe(false);
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

	it("preserves authoritative compaction and branch summaries without exposing their details", () => {
		expect(
			projectPiSessionJsonlLine(
				JSON.stringify({
					type: "compaction",
					summary: "Durable objective and verified handoff survive compaction.",
					details: { privatePayload: "PRIVATE_COMPACTION_DETAILS" },
				}),
			),
		).toBe("SUMMARY Durable objective and verified handoff survive compaction.");
		expect(
			projectPiSessionJsonlLine(
				JSON.stringify({
					type: "branch_summary",
					summary: "The selected branch keeps its unresolved risk.",
					details: { privatePayload: "PRIVATE_BRANCH_DETAILS" },
				}),
			),
		).toBe("BRANCH_SUMMARY The selected branch keeps its unresolved risk.");
		expect(
			projectPiSessionJsonlLine(JSON.stringify({ type: "custom", data: { summary: "PRIVATE_CUSTOM_STATE" } })),
		).toBe("");
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
		expect(text).toContain("SUMMARY Durable objective and verified handoff survive compaction.");
		expect(text).toContain("BRANCH_SUMMARY The selected branch keeps its unresolved risk.");
		expect(text).not.toContain("SECRET_THINKING");
		expect(text).not.toContain("encrypted-blob");
		expect(text).not.toContain("HUGE_PAYLOAD");
		expect(text).not.toContain("PRIVATE_COMPACTION_DETAILS");
		expect(text).not.toContain("PRIVATE_BRANCH_DETAILS");
		expect(text).not.toContain("PRIVATE_CUSTOM_STATE");
	});

	it("projects sessions under the configured custom agent directory", async () => {
		const customAgentDir = join(tempDir, "custom-agent-home");
		const customSessionDir = join(customAgentDir, "sessions", "cwd");
		const customSessionFile = join(customSessionDir, "2026-01-01T00-00-00-000Z_01custom.jsonl");
		mkdirSync(customSessionDir, { recursive: true });
		writeFileSync(
			customSessionFile,
			[
				JSON.stringify({ type: "message", message: { role: "user", content: "custom session task" } }),
				JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "CUSTOM_SECRET_THINKING" },
							{ type: "text", text: "custom visible reply" },
						],
					},
				}),
			].join("\n"),
		);
		vi.stubEnv(ENV_AGENT_DIR, customAgentDir);

		const result = await createReadTool(tempDir).execute("read-custom-session", { path: customSessionFile });
		const text = textOf(result);
		expect(text).toContain("Pi session transcript");
		expect(text).toContain("USER custom session task");
		expect(text).toContain("ASSISTANT custom visible reply");
		expect(text).not.toContain("CUSTOM_SECRET_THINKING");
	});
});
