/**
 * `isProcessAlive`: an unclassified probe failure must not be reported as death.
 *
 * `process-tree.ts:16-24` catches every error from `process.kill(pid, 0)` and returns `true` only for
 * EPERM. Any other failure - a code that is neither ESRCH nor EPERM, or an error with no `code` at
 * all - is swallowed and answered as a plain `false`, indistinguishable from ESRCH.
 *
 * ESRCH is the only error that proves absence. Everything else means the probe could not determine
 * liveness, and the caller has no way to tell the two apart because a boolean cannot carry "unknown".
 * Inside this module the consequence is `killTree`'s acknowledgement branch reading a failed probe as
 * confirmation of death (the outcome-level consequences are covered by the frozen
 * process-tree-termination-evidence.test.ts); `coding-agent`'s `isLocalProcessAlive` is a second,
 * independent copy of the same semantics with the same flaw.
 *
 * The assertion is deliberately not a specific return value: letting the error propagate and
 * answering conservatively alive are both acceptable repairs, and pinning one would choose for the
 * implementer. Only "answered a confident dead" is rejected.
 *
 * Only the OS boundary is mocked. No real process is signalled, and no claim is made that any
 * platform is guaranteed to emit any particular code - these describe what the boundary reports.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isProcessAlive, probeProcessLiveness } from "../../src/reliability/process-tree.ts";

const PROBE_PID = 4242;

function errnoError(code?: string): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(code ? `mock ${code}` : "mock failure without a code");
	if (code) error.code = code;
	return error;
}

function useKill(behaviour: () => true): void {
	vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: string | number): true => {
		if (signal !== 0) throw new Error(`unexpected signal ${String(signal)}`);
		return behaviour();
	});
}

type ProbeOutcome = "alive" | "dead" | "threw";

function probe(): ProbeOutcome {
	try {
		return isProcessAlive(PROBE_PID) ? "alive" : "dead";
	} catch {
		return "threw";
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isProcessAlive liveness classification", () => {
	it("negative control: a successful probe is alive", () => {
		useKill(() => true);

		expect(probe()).toBe("alive");
	});

	it("negative control: EPERM is a live, inaccessible process", () => {
		useKill(() => {
			throw errnoError("EPERM");
		});

		expect(probe()).toBe("alive");
	});

	it("negative control: ESRCH is the one error that proves the process is gone", () => {
		useKill(() => {
			throw errnoError("ESRCH");
		});

		expect(probe()).toBe("dead");
	});

	it("does not probe non-positive pids", () => {
		const kill = vi.fn();
		expect(probeProcessLiveness(0, kill)).toBe("unknown");
		expect(probeProcessLiveness(-1, kill)).toBe("unknown");
		expect(kill).not.toHaveBeenCalled();
	});

	it.each([
		["a code that is neither ESRCH nor EPERM", "EINVAL"],
		["an error carrying no code at all", undefined],
	])("does not report death when the probe fails with %s", (_label, code) => {
		useKill(() => {
			throw errnoError(code);
		});

		// Propagating (so a caller can treat it as unknown) or answering conservatively alive are both
		// acceptable; a confident "dead" is not.
		expect(probe()).not.toBe("dead");
	});
});
