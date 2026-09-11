import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { withExclusiveMutationBarrier } from "../src/core/tools/file-mutation-queue.ts";

const cleanupDirectories: string[] = [];

afterEach(() => {
	for (const directory of cleanupDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type ExecOptions = Parameters<BashOperations["exec"]>[2];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("condition was not reached");
}

function createTool(root: string, onExec: (options: ExecOptions) => Promise<void> | void) {
	return createBashTool(root, {
		platform: "linux",
		pathFlavor: process.platform === "win32" ? "win32" : "posix",
		operations: {
			exec: async (_command, _cwd, options) => {
				await onExec(options);
				options.onData(Buffer.from("ran\n"));
				return { exitCode: 0, initialCwd: root, cwd: root };
			},
		},
	});
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

function makeRoot(): string {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-bash-background-barrier-")));
	cleanupDirectories.push(root);
	return root;
}

describe("bash background calls and the exclusive mutation barrier", () => {
	it("a background call queued behind an exclusive run waits for it, then runs", async () => {
		const root = makeRoot();
		const detachedFlags: Array<boolean | undefined> = [];
		const tool = createTool(root, (options) => {
			detachedFlags.push(options.detached);
		});

		const started = deferred();
		const release = deferred();
		const holder = withExclusiveMutationBarrier(async () => {
			started.resolve();
			await release.promise;
		});
		await started.promise;

		// A background command still waits for what the batch emitted before it: only after it owns
		// the barrier does it stop holding it. Starting it mid-write is exactly the race the barrier
		// exists to prevent, and "nobody waits for this command" is not "this command waits for nobody".
		let backgroundSettled = false;
		const background = tool.execute("bg-1", { command: "echo ran", background: true }).then((result) => {
			backgroundSettled = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(backgroundSettled).toBe(false);
		expect(detachedFlags).toEqual([]);

		release.resolve();
		await holder;
		expect(firstText(await background)).toContain("ran");
		// The command ran outside the agent's persistent shell session.
		expect(detachedFlags).toEqual([true]);
	});

	it("a running background command does not hold the barrier", async () => {
		const root = makeRoot();
		const running = deferred();
		const detachedFlags: Array<boolean | undefined> = [];
		let executions = 0;
		const tool = createTool(root, async (options) => {
			executions++;
			detachedFlags.push(options.detached);
			if (options.detached === true) await running.promise;
		});

		const background = tool.execute("bg-1", { command: "sleep 600", background: true });
		await waitUntil(() => executions === 1);

		// The background command is still running. It released the barrier the instant its own body
		// started, so a foreground sibling takes the lock and finishes instead of parking behind it.
		expect(firstText(await tool.execute("fg-1", { command: "echo ran" }))).toContain("ran");
		expect(executions).toBe(2);
		expect(detachedFlags[0]).toBe(true);
		expect(detachedFlags[1]).toBeFalsy();

		running.resolve();
		expect(firstText(await background)).toContain("ran");
	});
});
