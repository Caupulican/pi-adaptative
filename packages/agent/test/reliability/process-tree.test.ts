import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { isProcessAlive, killTree, killTreeNow } from "../../src/reliability/process-tree.ts";

const posixOnly = it.skipIf(process.platform === "win32");

function spawnDetached(script: string) {
	const child = spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });
	if (child.pid === undefined) throw new Error("spawn failed");
	return child;
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (cond()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return cond();
}

describe("process-tree", () => {
	posixOnly("isProcessAlive: true for a live child, false after it exits", async () => {
		const child = spawnDetached("sleep 30");
		expect(isProcessAlive(child.pid!)).toBe(true);
		await killTree(child.pid!, { graceMs: 100 });
		expect(await waitFor(() => !isProcessAlive(child.pid!), 2000)).toBe(true);
	});

	posixOnly("killTree terminates a cooperative process via SIGTERM", async () => {
		const child = spawnDetached("sleep 30");
		const outcome = await killTree(child.pid!, { graceMs: 2000 });
		expect(outcome).toBe("terminated");
		expect(isProcessAlive(child.pid!)).toBe(false);
	});

	posixOnly("killTree escalates to SIGKILL when SIGTERM is trapped/ignored", async () => {
		const child = spawnDetached('trap "" TERM; sleep 30');
		// Give bash a moment to install the trap.
		await new Promise((r) => setTimeout(r, 200));
		const outcome = await killTree(child.pid!, { graceMs: 300 });
		expect(outcome).toBe("killed");
		expect(await waitFor(() => !isProcessAlive(child.pid!), 2000)).toBe(true);
	});

	posixOnly("killTree kills grandchildren in the same group", async () => {
		const child = spawnDetached("sleep 30 & sleep 30 & wait");
		await new Promise((r) => setTimeout(r, 200));
		await killTree(child.pid!, { graceMs: 300 });
		// The group leader and its background children must all be gone.
		expect(await waitFor(() => !isProcessAlive(child.pid!), 2000)).toBe(true);
		let groupGone = false;
		try {
			process.kill(-child.pid!, 0);
		} catch {
			groupGone = true;
		}
		expect(groupGone).toBe(true);
	});

	posixOnly("killTree on an already-dead pid returns already_dead", async () => {
		const child = spawnDetached("true");
		await waitFor(() => !isProcessAlive(child.pid!), 2000);
		expect(await killTree(child.pid!, { graceMs: 100 })).toBe("already_dead");
	});

	posixOnly("killTreeNow kills immediately", async () => {
		const child = spawnDetached("sleep 30");
		killTreeNow(child.pid!);
		expect(await waitFor(() => !isProcessAlive(child.pid!), 2000)).toBe(true);
	});
});
