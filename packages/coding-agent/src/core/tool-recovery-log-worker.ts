/**
 * Worker-thread entry for the tool recovery log: a `parentPort` transport around one
 * {@link ToolRecoveryLogProcessor}, which owns validation, writes and acknowledgements.
 */

import { parentPort } from "node:worker_threads";
import { ToolRecoveryLogProcessor } from "./tool-recovery-log-processor.ts";

const port = parentPort;
if (!port) {
	throw new Error("tool recovery log worker requires parentPort");
}
const workerPort = port;

const processor = new ToolRecoveryLogProcessor({
	post: (message) => workerPort.postMessage(message),
	close: () => workerPort.close(),
	// Transport loss ends the worker through its uncaught-error path, never through the failed channel.
	fail: (error) => {
		setImmediate(() => {
			throw error;
		});
	},
});

workerPort.on("message", (message: unknown) => processor.receive(message));
