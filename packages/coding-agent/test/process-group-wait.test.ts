// @isolated: mutates process.kill to fault-inject an owned process-group signal failure
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForChildProcess } from "../src/utils/child-process.ts";
import { awaitOwnedProcessGroup, consumeProcessTreeUntracked } from "../src/utils/process-group-wait.ts";

const children = new Set<ReturnType<typeof spawn>>();

async function spawnGroupLeader() {
	const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
		detached: true,
		stdio: "ignore",
	});
	children.add(child);
	await once(child, "spawn");
	return child;
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const child of children) {
		if (child.pid && child.exitCode === null && child.signalCode === null) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}
		await waitForChildProcess(child).catch(() => undefined);
	}
	children.clear();
	consumeProcessTreeUntracked(process.cwd());
});

describe.runIf(process.platform === "linux")("owned process-group waits", () => {
	it("settles cancellation after a delivered group kill", async () => {
		const child = await spawnGroupLeader();
		const abort = new AbortController();
		const waiting = awaitOwnedProcessGroup(child.pid, process.cwd(), abort.signal);
		abort.abort();

		await expect(waiting).resolves.toBeUndefined();
		expect(consumeProcessTreeUntracked(process.cwd())).toBe(false);
	});

	it("rejects instead of hanging when cancellation cannot signal the group", async () => {
		const child = await spawnGroupLeader();
		const pid = child.pid!;
		const originalKill = process.kill.bind(process);
		vi.spyOn(process, "kill").mockImplementation((target, signal) => {
			if (target === -pid && signal === "SIGKILL") {
				const error = new Error("fault-injected group kill refusal") as NodeJS.ErrnoException;
				error.code = "EPERM";
				throw error;
			}
			return originalKill(target, signal);
		});
		const abort = new AbortController();
		const waiting = awaitOwnedProcessGroup(pid, process.cwd(), abort.signal);
		abort.abort();
		const guard = Symbol("still-pending");
		const observed = await Promise.race([
			waiting.then(
				() => "settled" as const,
				() => "rejected" as const,
			),
			new Promise<typeof guard>((resolve) => setTimeout(() => resolve(guard), 500)),
		]);

		expect(observed).toBe("rejected");
		expect(consumeProcessTreeUntracked(process.cwd())).toBe(true);
	});
});
