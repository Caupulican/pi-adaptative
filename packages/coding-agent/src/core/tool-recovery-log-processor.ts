/**
 * The tool recovery log request processor: validates record batches, writes each record, and acknowledges
 * the batch. It talks to its parent only through {@link ToolRecoveryLogProcessorPort}, so the same processor
 * runs behind the real `parentPort` adapter (`tool-recovery-log-worker.ts`) and behind any other transport.
 * Constructing it has no side effects.
 */

import { type ToolRecoveryLogWorkerRecord, writeToolRecoveryLogRecord } from "./tool-recovery-log-records.ts";

export interface ToolRecoveryLogBatchMessage {
	type: "records";
	batchId: number;
	records: ToolRecoveryLogWorkerRecord[];
}

export interface ToolRecoveryLogShutdownMessage {
	type: "shutdown";
}

export type ToolRecoveryLogWorkerMessage = ToolRecoveryLogBatchMessage | ToolRecoveryLogShutdownMessage;

export interface ToolRecoveryLogAckMessage {
	type: "ack";
	batchId: number;
	written: number;
	failed: number;
}

/** The processor's only channel to its parent. */
export interface ToolRecoveryLogProcessorPort {
	/** Deliver one acknowledgement to the parent. A throw is transport loss. */
	post(message: ToolRecoveryLogAckMessage): void;
	/** Close the channel after a shutdown request. */
	close(): void;
	/** Transport loss: end the host with this error (the worker rethrows it uncaught). */
	fail(error: Error): void;
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

export class ToolRecoveryLogProcessor {
	private readonly port: ToolRecoveryLogProcessorPort;
	/** Set once an acknowledgement could not be delivered: nothing more is written or sent. */
	private transportFailure: Error | undefined;

	constructor(port: ToolRecoveryLogProcessorPort) {
		this.port = port;
	}

	/** Validate and handle one inbound message. Input outside the protocol, and anything after transport loss, is ignored. */
	receive(value: unknown): void {
		if (this.transportFailure || !isWorkerMessage(value)) return;
		if (value.type === "shutdown") {
			this.port.close();
			return;
		}

		let written = 0;
		let failed = 0;
		for (const record of value.records) {
			try {
				writeToolRecoveryLogRecord(record);
				written++;
			} catch {
				failed++;
			}
		}
		const response: ToolRecoveryLogAckMessage = { type: "ack", batchId: value.batchId, written, failed };
		try {
			this.port.post(response);
		} catch (error) {
			// The parent learns of the loss when the host ends with this error, never through the failed channel.
			const failure = error instanceof Error ? error : new Error(String(error));
			this.transportFailure = failure;
			this.port.fail(failure);
		}
	}
}
