import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { announceToolCall, retireToolCall } from "../src/core/tools/file-mutation-queue.ts";
import { disposeShellExecutionSessionAndWait } from "../src/core/tools/shell-execution-session.ts";
import {
	createWindowsShellEngineOperations,
	disposeWindowsShellEngineSession,
} from "../src/core/tools/windows-shell-engine.ts";

function makeRoot(): string {
	return realpathSync.native(mkdtempSync(join(tmpdir(), "pi-bash-lanes-")));
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("")
		.trim();
}

function createSessionTool(root: string, sessionKey: string) {
	return createBashTool(root, { sessionKey, outputReduction: { enabled: false } });
}

/**
 * Run commands the way the host runs one assistant message's tool wave: every call is announced
 * with its emission index before any body starts, then all bodies run together. Without the
 * announcement a command run is the lone exclusive holder of the mutation barrier, which is exactly
 * the pre-pool behavior and would serialize the batch.
 */
async function runAnnouncedBatch(
	tool: { execute: (id: string, input: { command: string; background?: boolean }) => Promise<unknown> },
	commands: Array<{ command: string; background?: boolean }>,
): Promise<string[]> {
	const batchId = randomUUID();
	const callIds = commands.map((_command, index) => `${batchId}-${index}`);
	for (const [index, callId] of callIds.entries()) announceToolCall(callId, index, false, batchId);
	try {
		const results = await Promise.all(
			commands.map(
				(entry, index) =>
					tool.execute(callIds[index], entry) as Promise<{ content: Array<{ type: string; text?: string }> }>,
			),
		);
		return results.map((result) => text(result));
	} finally {
		for (const callId of callIds) retireToolCall(callId);
	}
}

describe.skipIf(process.platform === "win32")("foreground bash calls on the shell lane pool", () => {
	it("runs commands emitted together concurrently instead of one after another", async () => {
		const root = makeRoot();
		const sessionKey = `test-lanes-concurrent-${randomUUID()}`;
		const tool = createSessionTool(root, sessionKey);
		try {
			const startedAt = Date.now();
			const outputs = await runAnnouncedBatch(tool, [
				{ command: "sleep 1; echo one" },
				{ command: "sleep 1; echo two" },
				{ command: "sleep 1; echo three" },
			]);
			const elapsedMs = Date.now() - startedAt;

			expect(outputs.map((output) => output.trim())).toEqual(["one", "two", "three"]);
			expect(elapsedMs).toBeLessThan(2_500);
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("grows a fourth lane when four commands are emitted together", async () => {
		const root = makeRoot();
		const sessionKey = `test-lanes-growth-${randomUUID()}`;
		const tool = createSessionTool(root, sessionKey);
		try {
			const startedAt = Date.now();
			const outputs = await runAnnouncedBatch(tool, [
				{ command: "sleep 1; echo a" },
				{ command: "sleep 1; echo b" },
				{ command: "sleep 1; echo c" },
				{ command: "sleep 1; echo d" },
			]);
			const elapsedMs = Date.now() - startedAt;

			expect(outputs.map((output) => output.trim())).toEqual(["a", "b", "c", "d"]);
			expect(elapsedMs).toBeLessThan(2_500);
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("shares the working directory across every lane in the pool", async () => {
		const root = makeRoot();
		const target = join(root, "workdir");
		mkdirSync(target);
		const resolvedTarget = realpathSync.native(target);
		const sessionKey = `test-lanes-cwd-${randomUUID()}`;
		const tool = createSessionTool(root, sessionKey);
		try {
			const [moved] = await runAnnouncedBatch(tool, [{ command: `cd ${target} && pwd` }]);
			expect(realpathSync.native(moved.trim())).toBe(resolvedTarget);

			const concurrent = await runAnnouncedBatch(tool, [{ command: "pwd" }, { command: "pwd" }, { command: "pwd" }]);
			for (const reported of concurrent) {
				expect(realpathSync.native(reported.trim())).toBe(resolvedTarget);
			}

			const [later] = await runAnnouncedBatch(tool, [{ command: "pwd" }]);
			expect(realpathSync.native(later.trim())).toBe(resolvedTarget);
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("carries a variable a command needs into that command, whichever lane runs it", async () => {
		const root = makeRoot();
		const sessionKey = `test-lanes-env-${randomUUID()}`;
		const tool = createSessionTool(root, sessionKey);
		try {
			// Exported state lives in the lane that set it, so a command that needs a variable states
			// it itself. That is the documented contract and it holds on every lane.
			const outputs = await runAnnouncedBatch(tool, [
				{ command: "FOO=1 sh -c 'echo value-$FOO'" },
				{ command: "FOO=1 sh -c 'echo value-$FOO'" },
				{ command: "FOO=1 sh -c 'echo value-$FOO'" },
			]);
			expect(outputs.map((output) => output.trim())).toEqual(["value-1", "value-1", "value-1"]);
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a background command detached from the lane pool", async () => {
		const root = makeRoot();
		const sessionKey = `test-lanes-background-${randomUUID()}`;
		const tool = createSessionTool(root, sessionKey);
		try {
			let backgroundSettled = false;
			const background = tool
				.execute("bg-1", { command: "sleep 3; echo bg-done", background: true })
				.then((result) => {
					backgroundSettled = true;
					return result;
				});

			const startedAt = Date.now();
			const foreground = await tool.execute("fg-1", { command: "echo fg-ran" });
			const elapsedMs = Date.now() - startedAt;

			expect(text(foreground)).toContain("fg-ran");
			expect(elapsedMs).toBeLessThan(1_000);
			expect(backgroundSettled).toBe(false);
			expect(text(await background)).toContain("bg-done");
		} finally {
			await disposeShellExecutionSessionAndWait(sessionKey);
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe.skipIf(process.platform !== "win32")("Windows shell engine lanes", () => {
	it("runs engine commands emitted together concurrently on a shared session state", async () => {
		const root = makeRoot();
		const sessionKey = `test-engine-lanes-${randomUUID()}`;
		const operations = createWindowsShellEngineOperations(sessionKey);
		try {
			await operations.exec(`cd ${root.replace(/\\/g, "/")}`, root, { onData: () => {}, timeout: 30 });

			const outputs: string[][] = [[], [], []];
			const startedAt = Date.now();
			const results = await Promise.all(
				outputs.map((chunks, index) =>
					operations
						.exec(`sleep 1; pwd; echo lane-${index}`, root, {
							onData: (data) => chunks.push(data.toString("utf8")),
							timeout: 30,
						})
						.then((result) => result.exitCode),
				),
			);
			const elapsedMs = Date.now() - startedAt;

			expect(results).toEqual([0, 0, 0]);
			expect(elapsedMs).toBeLessThan(2_500);
			for (const [index, chunks] of outputs.entries()) {
				const output = chunks.join("").replace(/\\/g, "/");
				expect(output).toContain(`lane-${index}`);
				expect(output.toLowerCase()).toContain(root.replace(/\\/g, "/").toLowerCase());
			}
		} finally {
			await disposeWindowsShellEngineSession(sessionKey);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
