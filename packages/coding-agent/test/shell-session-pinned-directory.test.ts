import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PersistentShellSession, type ShellSessionExecOptions } from "../src/core/tools/shell-session.ts";

const windows = process.platform === "win32";

describe("pinned persistent shell directory", () => {
	it("restores pinned cwd while preserving shell variables and unpinned cd behavior", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-shell-pin-"));
		const root = realpathSync(scratch);
		const child = join(root, "child");
		mkdirSync(child);
		const session = new PersistentShellSession("pin-fixture", windows ? "powershell" : "bash");
		const run = async (command: string, forceCwd = false) => {
			const chunks: Buffer[] = [];
			const options = { onData: (chunk: Buffer) => chunks.push(chunk), timeoutSeconds: 10, forceCwd };
			const result = await session.exec(command, root, options);
			return { ...result, text: Buffer.concat(chunks).toString("utf8").trim() };
		};
		try {
			const moved = await run(
				windows
					? "$env:PI_FIXTURE_PIN_VALUE='kept'; Set-Location child"
					: "export PI_FIXTURE_PIN_VALUE=kept; cd child",
			);
			expect(moved.exitCode).toBe(0);
			const unpinned = await run(windows ? "(Get-Location).Path" : "pwd");
			expect(unpinned.text).toBe(child);
			const pinned = await run(
				windows ? "(Get-Location).Path; $env:PI_FIXTURE_PIN_VALUE" : "pwd; printf '%s' \"$PI_FIXTURE_PIN_VALUE\"",
				true,
			);
			expect(pinned.exitCode).toBe(0);
			expect(pinned.initialCwd).toBe(root);
			expect(pinned.text.replace(/\r/g, "")).toBe(`${root}\nkept`);
			const again = await run(windows ? "(Get-Location).Path" : "pwd");
			expect(again.text).toBe(root);
		} finally {
			session.dispose();
			await session.terminalPromise;
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("does not execute the submitted command when pinned cwd cannot be restored", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-shell-pin-missing-"));
		const session = new PersistentShellSession("missing-pin-fixture", windows ? "powershell" : "bash");
		const chunks: Buffer[] = [];
		const options: ShellSessionExecOptions = {
			onData: (chunk) => chunks.push(chunk),
			timeoutSeconds: 10,
			forceCwd: true,
		};
		try {
			await session.exec(windows ? "Write-Output ready" : "printf ready", scratch, options);
			chunks.length = 0;
			const result = await session.exec(
				windows ? "Write-Output MUST_NOT_RUN" : "printf MUST_NOT_RUN",
				join(scratch, "missing"),
				options,
			);
			expect(result.exitCode).not.toBe(0);
			expect(Buffer.concat(chunks).toString("utf8")).not.toContain("MUST_NOT_RUN");
		} finally {
			session.dispose();
			await session.terminalPromise;
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
