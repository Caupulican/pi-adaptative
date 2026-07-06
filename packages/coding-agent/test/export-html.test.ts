import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportSessionToHtml } from "../src/core/export-html/index.ts";

let tempDir: string;

beforeEach(() => {
	tempDir = join(tmpdir(), `pi-export-html-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
	if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe("HTML export asset injection", () => {
	it("preserves dollar replacement sequences inside injected JS assets", async () => {
		const session = SessionManager.create(tempDir, tempDir, tempDir);
		session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
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
			timestamp: Date.now(),
		});
		const outputPath = join(tempDir, "export.html");

		await exportSessionToHtml(session, undefined, { outputPath });

		const html = readFileSync(outputPath, "utf-8");
		expect(html).toContain('Cost:</span><span class="info-value">$${totalCost.toFixed(3)}</span>');
		expect(html).toContain(String.raw`[-+*\/?!$&|:<=>@^~]`);
	});
});
