import { fork } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("vitest worker parent exit", () => {
	it("exits when the parent closes the worker channel", async () => {
		const moduleUrl = pathToFileURL(join(import.meta.dirname, "../../../scripts/vitest-worker-parent-exit.ts")).href;
		const script = join(tmpdir(), `pi-worker-exit-${process.pid}.mjs`);
		writeFileSync(script, `import ${JSON.stringify(moduleUrl)};\nsetInterval(() => {}, 200);\n`);
		const child = fork(script, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
		const exited = new Promise<number | null>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("worker stayed alive after disconnect")), 3000);
			child.once("exit", (code) => {
				clearTimeout(timer);
				resolve(code);
			});
		});
		child.disconnect();
		await expect(exited).resolves.toBe(1);
	});
});
