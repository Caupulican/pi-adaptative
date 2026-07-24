import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

function waitForTerminalSignal(worker: Worker, index: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let terminalSignalReceived = false;
		let settled = false;
		const cleanup = () => {
			worker.off("message", onMessage);
			worker.off("error", onError);
			worker.off("exit", onExit);
		};
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve();
		};
		const onMessage = (message: unknown) => {
			if (typeof message !== "object" || message === null || !("done" in message) || message.done !== true) {
				finish(new Error(`Worker ${index} emitted an invalid terminal signal.`));
				return;
			}
			terminalSignalReceived = true;
		};
		const onError = (error: Error) => finish(error);
		const onExit = (code: number) => {
			if (!terminalSignalReceived) {
				finish(new Error(`Worker ${index} exited with code ${code} before its terminal signal.`));
				return;
			}
			if (code !== 0) {
				finish(new Error(`Worker ${index} exited with code ${code}.`));
				return;
			}
			finish();
		};
		worker.on("message", onMessage);
		worker.once("error", onError);
		worker.once("exit", onExit);
	});
}

export async function runSignaledWorkerThreads(workerPath: string, workerData: readonly unknown[]): Promise<void> {
	const workerUrl = pathToFileURL(workerPath);
	const workers = workerData.map((data) => new Worker(workerUrl, { workerData: data }));
	try {
		await Promise.all(workers.map((worker, index) => waitForTerminalSignal(worker, index)));
	} finally {
		await Promise.all(
			workers.map(async (worker) => {
				if (worker.threadId !== -1) await worker.terminate();
			}),
		);
	}
}
