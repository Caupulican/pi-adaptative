// @isolated: starts real shell children and releases them with an OS signal
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { tempDir } from "./temp-dir.ts";

describe.runIf(process.platform === "linux")("managed shell child completion", () => {
	it.each([false, true])("retains ownership until the child exits (shell background: %s)", async (background) => {
		const cwd = tempDir("pi-owned-child-completion-");
		const fixture = join(cwd, "child.cjs");
		writeFileSync(
			fixture,
			[
				"process.on('SIGUSR1', () => { clearInterval(held); process.stdout.write('child-complete\\n'); });",
				"const held = setInterval(() => {}, 1000);",
				"process.stdout.write('child-ready:' + process.pid + '\\n');",
			].join("\n"),
		);
		let settled = false;
		let output = "";
		let released = false;
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const abort = new AbortController();
		const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
		const operation = createLocalBashOperations()
			.exec(`${quote(process.execPath)} ${quote(fixture)}${background ? " &" : ""}`, cwd, {
				detached: true,
				timeout: 5,
				signal: abort.signal,
				onData: (data) => {
					output += data.toString("utf8");
					if (/child-ready:\d+\n/.test(output)) resolveReady();
				},
			})
			.then((result) => {
				settled = true;
				return result;
			});
		try {
			await Promise.race([
				ready,
				operation.then(() => {
					throw new Error("shell settled before child readiness");
				}),
			]);
			expect(settled).toBe(false);
			const pid = Number(/child-ready:(\d+)/.exec(output)?.[1]);
			expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
			process.kill(pid, "SIGUSR1");
			released = true;
			await expect(operation).resolves.toMatchObject({ exitCode: 0 });
			expect(output).toContain("child-complete\n");
		} finally {
			if (!released) abort.abort();
			await operation.catch(() => undefined);
		}
	});
});
