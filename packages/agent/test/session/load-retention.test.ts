import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SESSION_VERSION, loadEntriesFromFile, SessionManager } from "../../src/session/session-manager.ts";

describe("tool result details retention on session load", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-load-retention-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSessionFile(file: string, details: unknown): void {
		const lines = [
			JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "load-retention",
				timestamp: "2026-01-01T00:00:00Z",
				cwd: tempDir,
			}),
			JSON.stringify({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01Z",
				message: { role: "user", content: "run tool", timestamp: 1 },
			}),
			JSON.stringify({
				type: "message",
				id: "t1",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "bash",
					content: [{ type: "text", text: "small model-visible result" }],
					details,
					isError: false,
					timestamp: 2,
				},
			}),
		];
		writeFileSync(file, `${lines.join("\n")}\n`);
	}

	function loadedToolResultDetails(manager: SessionManager): unknown {
		const entry = manager
			.getEntries()
			.find((candidate) => candidate.type === "message" && candidate.message.role === "toolResult");
		if (!entry || entry.type !== "message" || entry.message.role !== "toolResult") {
			throw new Error("toolResult entry missing after load");
		}
		return entry.message.details;
	}

	it("compacts oversized tool result details when loading a session file", () => {
		const file = join(tempDir, "oversized.jsonl");
		writeSessionFile(file, { payload: "x".repeat(200_000), nested: { keep: "metadata" } });

		const manager = SessionManager.open(file, tempDir, tempDir);

		const details = loadedToolResultDetails(manager) as Record<string, unknown>;
		expect(details.piToolResultDetailsTruncated).toBe(true);
		expect(JSON.stringify(details).length).toBeLessThan(4_096);
	});

	it("keeps small tool result details intact when loading a session file", () => {
		const file = join(tempDir, "small.jsonl");
		writeSessionFile(file, { summary: "kept", lines: 3 });

		const manager = SessionManager.open(file, tempDir, tempDir);

		expect(loadedToolResultDetails(manager)).toEqual({ summary: "kept", lines: 3 });
	});

	it("skips a line too large to hold in a string instead of failing the whole load", () => {
		const file = join(tempDir, "oversized-line.jsonl");
		const lines = [
			JSON.stringify({
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: "oversized-line",
				timestamp: "2026-01-01T00:00:00Z",
				cwd: tempDir,
			}),
			JSON.stringify({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-01-01T00:00:01Z",
				message: { role: "user", content: "before the bloated entry", timestamp: 1 },
			}),
			// A single line beyond the assembly budget: dropped like any other
			// unparseable line instead of crashing the load.
			`{"type":"message","id":"bloated","payload":"${"x".repeat(5000)}"}`,
			JSON.stringify({
				type: "message",
				id: "u2",
				parentId: "u1",
				timestamp: "2026-01-01T00:00:02Z",
				message: { role: "user", content: "after the bloated entry", timestamp: 2 },
			}),
		];
		writeFileSync(file, `${lines.join("\n")}\n`);

		const entries = loadEntriesFromFile(file, { maxLineChars: 1000 });

		expect(entries.map((entry) => (entry.type === "session" ? "header" : entry.id))).toEqual(["header", "u1", "u2"]);
	});

	it("does not rewrite the session file when compacting loaded details", () => {
		const file = join(tempDir, "untouched.jsonl");
		writeSessionFile(file, { payload: "x".repeat(200_000) });
		const before = readFileSync(file, "utf-8");

		SessionManager.open(file, tempDir, tempDir);

		expect(readFileSync(file, "utf-8")).toBe(before);
	});
});
