import { parentPort, workerData } from "node:worker_threads";
import lockfile from "proper-lockfile";
import { ProviderLimitStore } from "../../src/core/provider-admission/limit-state.ts";

export interface LimitContenderInput {
	agentDir: string;
	provider: string;
	operation: "record" | "clear" | "read" | "list";
	limitedUntil: number;
	now: number;
	pauseAtClockRead?: number;
	barrier: SharedArrayBuffer;
}

const input = workerData as LimitContenderInput;
if (!parentPort) throw new Error("Provider limit fixture requires a parent port");
const port = parentPort;
const barrier = new Int32Array(input.barrier);
let clockReads = 0;
const originalLockSync = lockfile.lockSync;
// Observe the real advisory lock's rejection; preserve its error and the owner's retry behavior.
lockfile.lockSync = (...args) => {
	try {
		return originalLockSync(...args);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ELOCKED") {
			port.postMessage("contended");
		}
		throw error;
	}
};
const store = new ProviderLimitStore(input.agentDir, {
	now: () => {
		clockReads++;
		if (clockReads === input.pauseAtClockRead) {
			port.postMessage("paused-after-read");
			if (Atomics.wait(barrier, 0, 0, 10_000) === "timed-out") throw new Error("Test barrier was not released");
		}
		return input.now;
	},
});

port.once("message", () => {
	try {
		switch (input.operation) {
			case "record":
				store.record(input.provider, { limitedUntil: input.limitedUntil, reason: "usage_window" });
				break;
			case "clear":
				store.clear(input.provider, ["rate_limit"]);
				break;
			case "read":
				store.read(input.provider);
				break;
			case "list":
				store.list();
				break;
		}
		port.postMessage("completed");
	} catch (error) {
		port.postMessage({ error: String(error) });
		process.exitCode = 1;
	} finally {
		lockfile.lockSync = originalLockSync;
		port.close();
	}
});
port.postMessage("ready");
