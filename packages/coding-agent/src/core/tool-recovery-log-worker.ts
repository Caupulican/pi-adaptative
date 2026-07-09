import { parentPort } from "node:worker_threads";
import { type ToolRecoveryLogWorkerRecord, writeToolRecoveryLogRecord } from "./tool-recovery-log-records.ts";

interface ToolRecoveryLogBatchMessage {
	type: "records";
	batchId: number;
	records: ToolRecoveryLogWorkerRecord[];
}

interface ToolRecoveryLogShutdownMessage {
	type: "shutdown";
}

type ToolRecoveryLogWorkerMessage = ToolRecoveryLogBatchMessage | ToolRecoveryLogShutdownMessage;

interface ToolRecoveryLogAckMessage {
	type: "ack";
	batchId: number;
	written: number;
	failed: number;
}

function isWorkerRecord(value: unknown): value is ToolRecoveryLogWorkerRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<ToolRecoveryLogWorkerRecord>;
	return typeof record.eventLogPath === "string" && typeof record.failureCorpusPath === "string" && !!record.record;
}

function isWorkerMessage(value: unknown): value is ToolRecoveryLogWorkerMessage {
	if (!value || typeof value !== "object") return false;
	const message = value as Partial<ToolRecoveryLogWorkerMessage>;
	if (message.type === "shutdown") return true;
	if (message.type !== "records") return false;
	return (
		typeof message.batchId === "number" && Array.isArray(message.records) && message.records.every(isWorkerRecord)
	);
}

const port = parentPort;
if (!port) {
	throw new Error("tool recovery log worker requires parentPort");
}

port.on("message", (message: unknown) => {
	if (!isWorkerMessage(message)) return;
	if (message.type === "shutdown") {
		port.close();
		return;
	}

	let written = 0;
	let failed = 0;
	for (const record of message.records) {
		try {
			writeToolRecoveryLogRecord(record);
			written++;
		} catch {
			failed++;
		}
	}
	const response: ToolRecoveryLogAckMessage = { type: "ack", batchId: message.batchId, written, failed };
	port.postMessage(response);
});
