import { describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";

const posixOnly = it.skipIf(process.platform === "win32");

describe("execCommand kill path", () => {
	posixOnly(
		"abort kills a SIGTERM-trapping child (escalation actually fires)",
		async () => {
			const ac = new AbortController();
			const start = Date.now();
			const resultPromise = execCommand("bash", ["-c", 'trap "" TERM; echo up; sleep 60'], process.cwd(), {
				signal: ac.signal,
			});
			await new Promise((r) => setTimeout(r, 300)); // let the trap install
			ac.abort();
			const result = await resultPromise;
			expect(result.killed).toBe(true);
			expect(Date.now() - start).toBeLessThan(20_000); // formerly hung forever
		},
		30_000,
	);

	posixOnly(
		"abort kills grandchildren (process group)",
		async () => {
			const ac = new AbortController();
			const resultPromise = execCommand(
				"bash",
				["-c", "sleep 60.123 & child=$!; echo spawned $child; wait"],
				process.cwd(),
				{ signal: ac.signal },
			);
			await new Promise((r) => setTimeout(r, 300));
			ac.abort();
			const result = await resultPromise;
			expect(result.killed).toBe(true);
			// The grandchild sleep must not survive: find any marker 'sleep 60.123' owned by us.
			// Pattern is anchored (^) so it matches only a process whose argv starts with
			// "sleep 60.123" — otherwise pgrep -f self-matches its own "/bin/sh -c 'pgrep -f
			// sleep 60.123 ...'" wrapper, which contains that literal substring too.
			const { execSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
			await new Promise((r) => setTimeout(r, 6000)); // > graceMs, allow escalation to finish
			const survivors = execSync("pgrep -f '^sleep 60\\.123' || true").toString().trim();
			expect(survivors).toBe("");
		},
		30_000,
	);

	it("surfaces spawn failure (ENOENT) in errorMessage", async () => {
		const result = await execCommand("definitely-not-a-real-binary-xyz", [], process.cwd());
		expect(result.code).toBe(1);
		expect(result.errorMessage).toMatch(/ENOENT|not found/i);
	});
});
