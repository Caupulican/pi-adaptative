import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("a real IPC admission releases the parent without waiting for its detached child", () => {
	const result = spawnSync(
		process.execPath,
		["--conditions=pi-source", fileURLToPath(new URL("./fixtures/collaboration-ipc-runtime.ts", import.meta.url))],
		{ encoding: "utf8", timeout: 4000, env: { ...process.env, NODE_OPTIONS: "" } },
	);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout.trim()).toBe("admitted");
});
