/**
 * A denied group signal is never proof the group is empty.
 *
 * `signalTree` targets the process GROUP first and falls back to the root pid. The two answers carry
 * different scopes: ESRCH from `kill(-pid)` means the group is gone, ESRCH from `kill(pid)` means only
 * the leader is gone. A group can still hold live descendants after its leader exits, so a group
 * signal that was DENIED (EPERM, or any unclassified failure) leaves the descendants' state unknown
 * even when the root pid is provably gone.
 *
 * The initial-SIGTERM path already honours this: `signalTree` only answers `gone` when both attempts
 * answered ESRCH, so group-EPERM + direct-ESRCH is `failed`.
 *
 * The escalation path does not carry that evidence forward. When SIGKILL comes back non-delivered it
 * hands off to `settleFromEvidence(child, pid, escalated)`, which probes the ROOT pid only. With the
 * root gone, `isProcessAlive` is false and the outcome becomes `killed` - a termination claim for a
 * tree whose group was never successfully signalled and never observed.
 *
 * This is about preserving explicit failed-group evidence during an active termination. It does not
 * touch the semantics of an already-terminal ChildProcess: every child here is non-terminal
 * throughout.
 *
 * SAFETY: this file exercises the POSIX group algorithm, which only exists on the non-win32 branch,
 * so `process.platform` is pinned to "linux" for every test and its original property descriptor is
 * restored exactly afterwards. Without that pin a native Windows run would take the win32 branch and
 * hand these synthetic pids to a REAL `taskkill /F /T`. As a second, independent guard the
 * `node:child_process` boundary is replaced by a spy that refuses to spawn anything at all, and every
 * test asserts it was never reached - so no fixture mistake can ever signal a real process.
 */
import type * as NodeChildProcess from "node:child_process";
import { type ChildProcess, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { killTree } from "../../src/reliability/process-tree.ts";

vi.mock("../../src/reliability/process-termination-protection.ts", () => ({
	readProcessTerminationProtection: () => new Set<number>(),
}));

// The only native-command boundary `process-tree.ts` has. It must never be crossed by this file.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof NodeChildProcess>();
	return {
		...actual,
		spawnSync: vi.fn(() => {
			throw new Error("This fixture must never spawn a native command; the POSIX algorithm is under test.");
		}),
	};
});

type SignalResponse = "delivered" | "eperm" | "esrch";

interface KernelScript {
	/** Whether the ROOT pid still exists. Descendants are deliberately not modelled as a pid. */
	rootAlive: boolean;
	group: SignalResponse;
	direct: SignalResponse;
}

interface SignalRecord {
	target: number;
	signal: string | number;
}

function errnoError(code: string): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(`mock ${code}`);
	error.code = code;
	return error;
}

function installKernel(script: KernelScript): SignalRecord[] {
	const sent: SignalRecord[] = [];
	vi.spyOn(process, "kill").mockImplementation((target: number, signal?: string | number): true => {
		if (signal === 0) {
			if (!script.rootAlive) throw errnoError("ESRCH");
			if (script.direct === "eperm") throw errnoError("EPERM");
			return true;
		}
		sent.push({ target, signal: signal ?? "SIGTERM" });
		const response = target < 0 ? script.group : script.direct;
		if (response === "eperm") throw errnoError("EPERM");
		if (response === "esrch") throw errnoError("ESRCH");
		return true;
	});
	return sent;
}

function mockChild(pid: number): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	Object.assign(child, { pid, exitCode: null, signalCode: null, unref: vi.fn() });
	return child;
}

const TERMINATION_CLAIMS: ReadonlyArray<string> = ["already_dead", "terminated", "killed"];

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
	vi.mocked(spawnSync).mockClear();
	// The group algorithm is the non-win32 branch; pin it so either host exercises the same code.
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
});

afterEach(() => {
	// No native command may have been attempted, on any host.
	expect(vi.mocked(spawnSync)).not.toHaveBeenCalled();
	if (originalPlatformDescriptor) Object.defineProperty(process, "platform", originalPlatformDescriptor);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("process tree group uncertainty", () => {
	it("does not claim termination when the initial group signal is denied and only the root is gone", async () => {
		// Already covered by the initial-SIGTERM evidence rule; kept as this file's own baseline so the
		// escalation result below is read against a directly comparable case.
		installKernel({ rootAlive: false, group: "eperm", direct: "esrch" });

		const outcome = await killTree(mockChild(5150), { graceMs: 50 });

		expect(TERMINATION_CLAIMS).not.toContain(outcome);
		expect(outcome).toBe("failed");
	});

	it("does not claim killed when the escalated group signal is denied and only the root is gone", async () => {
		vi.useFakeTimers();
		const script: KernelScript = { rootAlive: true, group: "delivered", direct: "delivered" };
		const sent = installKernel(script);
		const child = mockChild(5151);

		const settled = killTree(child, { graceMs: 100 });
		// SIGTERM lands; during the grace window the leader exits and the group becomes unreachable,
		// so SIGKILL can neither be delivered to the group nor confirm the descendants are gone.
		script.group = "eperm";
		script.direct = "esrch";
		script.rootAlive = false;
		await vi.advanceTimersByTimeAsync(100);
		const outcome = await settled;

		expect(sent.map((record) => record.signal)).toEqual(["SIGTERM", "SIGKILL", "SIGKILL"]);
		expect(TERMINATION_CLAIMS).not.toContain(outcome);
		expect(outcome).toBe("failed");
	});

	it("negative control: an initial signal answered ESRCH by both group and root is already_dead", async () => {
		installKernel({ rootAlive: false, group: "esrch", direct: "esrch" });

		expect(await killTree(mockChild(5152), { graceMs: 50 })).toBe("already_dead");
	});

	it("negative control: an escalated signal answered ESRCH by both group and root is killed", async () => {
		vi.useFakeTimers();
		const script: KernelScript = { rootAlive: true, group: "delivered", direct: "delivered" };
		installKernel(script);
		const child = mockChild(5153);

		const settled = killTree(child, { graceMs: 100 });
		// The whole group answers ESRCH: nothing is left unaccounted for.
		script.group = "esrch";
		script.direct = "esrch";
		script.rootAlive = false;
		await vi.advanceTimersByTimeAsync(100);

		expect(await settled).toBe("killed");
	});

	it("negative control: a delivered escalation whose root is confirmed gone is killed", async () => {
		vi.useFakeTimers();
		const script: KernelScript = { rootAlive: true, group: "delivered", direct: "delivered" };
		installKernel(script);
		const child = mockChild(5154);

		const settled = killTree(child, { graceMs: 100 });
		await vi.advanceTimersByTimeAsync(100);
		script.rootAlive = false;
		await vi.advanceTimersByTimeAsync(1000);

		expect(await settled).toBe("killed");
	});
});
