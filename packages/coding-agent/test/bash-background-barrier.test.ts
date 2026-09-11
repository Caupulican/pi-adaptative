import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";
import { withExclusiveMutationBarrier } from "../src/core/tools/file-mutation-queue.ts";

const cleanupDirectories: string[] = [];

afterEach(() => {
	for (const directory of cleanupDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

function createTool(root: string, onExec: () => void) {
	return createBashTool(root, {
		platform: "linux",
		pathFlavor: process.platform === "win32" ? "win32" : "posix",
		operations: {
			exec: async (_command, _cwd, options) => {
				onExec();
				options.onData(Buffer.from("ran\n"));
				return { exitCode: 0, initialCwd: root, cwd: root };
			},
		},
	});
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

describe("bash background calls and the exclusive mutation barrier", () => {
	it("a background call runs while an exclusive run holds the barrier; a foreground call waits", async () => {
		const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pi-bash-background-barrier-")));
		cleanupDirectories.push(root);
		let executions = 0;
		const tool = createTool(root, () => {
			executions++;
		});

		const started = deferred();
		const release = deferred();
		const holder = withExclusiveMutationBarrier(async () => {
			started.resolve();
			await release.promise;
		});
		await started.promise;

		// The model declared this command independent of the batch: it must not park behind the
		// writer lock, because its handoff stub is what the turn is waiting for.
		const background = await tool.execute("bg-1", { command: "echo ran", background: true });
		expect(firstText(background)).toContain("ran");
		expect(executions).toBe(1);

		let foregroundSettled = false;
		const foreground = tool.execute("fg-1", { command: "echo ran" }).then((result) => {
			foregroundSettled = true;
			return result;
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(foregroundSettled).toBe(false);
		expect(executions).toBe(1);

		release.resolve();
		await holder;
		expect(firstText(await foreground)).toContain("ran");
		expect(executions).toBe(2);
	});
});
