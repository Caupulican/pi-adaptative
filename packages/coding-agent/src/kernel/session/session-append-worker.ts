/** Worker adapter for the admitted physical phase of a session append. */
import { type MessagePort, parentPort } from "node:worker_threads";
import { executeSessionAppendDisk, type SessionAppendDiskRequest } from "./session-append-disk.ts";

export interface SessionAppendWorkerRequest {
	readonly request: SessionAppendDiskRequest;
	readonly port: MessagePort;
}

parentPort?.on("message", ({ request, port }: SessionAppendWorkerRequest) => {
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
		port.close();
	}
});
