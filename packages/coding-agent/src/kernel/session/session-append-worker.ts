/** Worker adapter for the admitted physical phase of a session append. */
import { type MessagePort, parentPort } from "node:worker_threads";
import { executeSessionAppendDisk, type SessionAppendDiskRequest } from "./session-append-disk.ts";

export interface SessionAppendWorkerRequest {
	readonly request: SessionAppendDiskRequest;
	readonly port: MessagePort;
	readonly signal: SharedArrayBuffer;
}

parentPort?.on("message", ({ request, port, signal }: SessionAppendWorkerRequest) => {
	const state = new Int32Array(signal);
	try {
		const outcome = executeSessionAppendDisk(request);
		try {
			port.postMessage(outcome);
		} catch (error) {
			port.postMessage({
				failed: true,
				started: !("failed" in outcome) || outcome.started,
				error: new Error(String(error)),
			});
		}
	} finally {
		Atomics.store(state, 0, 1);
		Atomics.notify(state, 0);
		port.close();
	}
});
