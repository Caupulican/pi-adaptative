/**
 * Worker-thread entry for transcript recall: a `parentPort` transport around one
 * {@link TranscriptRecallProcessor}, which owns all request handling and state.
 */

import { parentPort } from "node:worker_threads";
import { TranscriptRecallProcessor } from "./transcript-recall-processor.ts";

const port = parentPort;
if (!port) throw new Error("transcript recall worker requires parentPort");
const workerPort = port;

const processor = new TranscriptRecallProcessor({
	post: (response) => workerPort.postMessage(response),
	close: () => workerPort.close(),
	schedule: (callback) => {
		setImmediate(callback);
	},
	// Transport loss ends the worker through its uncaught-error path, never through the failed channel.
	fail: (error) => {
		setImmediate(() => {
			throw error;
		});
	},
});

workerPort.on("message", (value: unknown) => processor.receive(value));
