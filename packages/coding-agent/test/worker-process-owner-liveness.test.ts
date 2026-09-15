/**
 * Local worker owner liveness: an unclassified probe failure must not become proof of death.
 *
 * `localWorkerProcessOwnerLiveness` (worker-process-owner.ts:47-58) is built for exactly this: it
 * wraps the probe in try/catch and documents at :43-46 that "liveness probe failures stay unknown so
 * recovery cannot steal a potentially active worker". Its own default probe defeats that.
 *
 * `isLocalProcessAlive` (:13-20) catches every error from `process.kill(pid, 0)` and returns `true`
 * only for EPERM. Any other failure - a code that is neither ESRCH nor EPERM, or an error carrying no
 * `code` at all - is swallowed and returned as a plain `false`. Because it returns rather than
 * throws, the "unknown" branch above is unreachable: the answer arrives as a confident `dead`,
 * `isLocalWorkerProcessOwnerProvenDead` returns true, and `worker-lifecycle.ts:294` lets recovery
 * take the lease of a worker that may still be running.
 *
 * ESRCH is the only error that proves absence. This file therefore asserts the downstream property -
 * `isLocalWorkerProcessOwnerProvenDead` stays false - rather than prescribing which repair is taken:
 * letting the error propagate (mapped to "unknown") and answering conservatively alive are both
 * acceptable, and asserting a specific return value would pick one for the implementer.
 *
 * Only the OS boundary is mocked. No signal is sent to any real process, and no claim is made that
 * any particular platform emits any particular code - the tests describe what the probe boundary
 * reports, not what an OS is guaranteed to produce.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createLocalWorkerProcessOwnerId,
	isLocalProcessAlive,
	isLocalWorkerProcessOwnerProvenDead,
	localWorkerProcessOwnerLiveness,
} from "../src/core/delegation/worker-process-owner.ts";

const OWNER_PID = 4242;
const OWNER_ID = createLocalWorkerProcessOwnerId(OWNER_PID, "12345678-1234-4234-8234-123456789abc");

function errnoError(code?: string): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(code ? `mock ${code}` : "mock failure without a code");
	if (code) error.code = code;
	return error;
}

/** Install a scripted OS boundary. Signal 0 is the liveness probe; nothing else is ever sent. */
function useKill(behaviour: () => true): void {
	vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: string | number): true => {
		if (signal !== 0) throw new Error(`unexpected signal ${String(signal)}`);
		return behaviour();
	});
}

type ProbeOutcome = "alive" | "dead" | "threw";

function probe(): ProbeOutcome {
	try {
		return isLocalProcessAlive(OWNER_PID) ? "alive" : "dead";
	} catch {
		return "threw";
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("local worker owner liveness probe", () => {
	it("negative control: a successful probe is live and never proven dead", () => {
		useKill(() => true);

		expect(probe()).toBe("alive");
		expect(localWorkerProcessOwnerLiveness(OWNER_ID, isLocalProcessAlive)).toBe("live");
		expect(isLocalWorkerProcessOwnerProvenDead(OWNER_ID, isLocalProcessAlive)).toBe(false);
	});

	it("negative control: EPERM is a live, inaccessible process", () => {
		useKill(() => {
			throw errnoError("EPERM");
		});

		expect(probe()).toBe("alive");
		expect(localWorkerProcessOwnerLiveness(OWNER_ID, isLocalProcessAlive)).toBe("live");
		expect(isLocalWorkerProcessOwnerProvenDead(OWNER_ID, isLocalProcessAlive)).toBe(false);
	});

	it("negative control: ESRCH is the one error that proves the owner is gone", () => {
		useKill(() => {
			throw errnoError("ESRCH");
		});

		expect(probe()).toBe("dead");
		expect(localWorkerProcessOwnerLiveness(OWNER_ID, isLocalProcessAlive)).toBe("dead");
		expect(isLocalWorkerProcessOwnerProvenDead(OWNER_ID, isLocalProcessAlive)).toBe(true);
	});

	it.each([
		["a code that is neither ESRCH nor EPERM", "EINVAL"],
		["an error carrying no code at all", undefined],
	])("does not prove the owner dead when the probe fails with %s", (_label, code) => {
		useKill(() => {
			throw errnoError(code);
		});

		// Either propagating (mapped to "unknown") or answering conservatively alive is acceptable;
		// a confident "dead" is not.
		expect(probe()).not.toBe("dead");
		expect(localWorkerProcessOwnerLiveness(OWNER_ID, isLocalProcessAlive)).not.toBe("dead");
		expect(isLocalWorkerProcessOwnerProvenDead(OWNER_ID, isLocalProcessAlive)).toBe(false);
	});

	it.each([
		["an unparsable owner scheme", "systemd:4242"],
		["a pi owner without a UUID instance", "pi-worker:4242:not-a-uuid"],
		["an untrimmed identity", " pi-worker:4242:12345678-1234-4234-8234-123456789abc "],
	])("negative control: %s stays unknown without probing the OS", (_label, ownerId) => {
		const kill = vi.spyOn(process, "kill").mockImplementation((): true => true);

		expect(localWorkerProcessOwnerLiveness(ownerId, isLocalProcessAlive)).toBe("unknown");
		expect(isLocalWorkerProcessOwnerProvenDead(ownerId, isLocalProcessAlive)).toBe(false);
		expect(kill).not.toHaveBeenCalled();
	});

	it("negative control: a probe that throws through the seam is unknown, not dead", () => {
		const throwingProbe = () => {
			throw errnoError("EINVAL");
		};

		expect(localWorkerProcessOwnerLiveness(OWNER_ID, throwingProbe)).toBe("unknown");
		expect(isLocalWorkerProcessOwnerProvenDead(OWNER_ID, throwingProbe)).toBe(false);
	});
});
