import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("a real IPC admission releases the parent without waiting for its detached child", () => {
	const result = spawnSync(
		process.execPath,
		["--conditions=pi-source", fileURLToPath(new URL("./fixtures/collaboration-ipc-runtime.ts", import.meta.url))],
		// A released parent exits after its own start plus the child's; one that waits for the child is held
		// for the child's 60 s watchdog. 30 s separates the two even on a loaded Windows runner, where two
		// cold starts from source approached the former 4 s bound.
		{ encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "" } },
	);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout.trim()).toBe("admitted");
});
