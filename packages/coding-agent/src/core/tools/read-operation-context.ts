import { createHash } from "node:crypto";
import { AgentToolExecutionError } from "../../kernel/types.ts";

export type ReadToolName = "read" | "grep" | "find" | "ls" | "repo_read";
export type ReadWorkKind = "sourceBytes" | "entries" | "files" | "metadata" | "processes" | "outputBytes";
export type ReadWorkTotals = Readonly<Record<ReadWorkKind, number>>;
export type ReadCoverage = "complete" | "window" | "partial";

/** Physical work bounds, independent of the model's result and invocation limits. */
export const LOCAL_READ_WORK_LIMITS: ReadWorkTotals = Object.freeze({
	sourceBytes: 1024 * 1024,
	entries: 1024,
	files: 64,
	metadata: 4096,
	processes: 16,
	outputBytes: 256 * 1024,
});
export const LOCAL_READ_DEADLINE_MS = 15_000;
export const LOCAL_READ_CHUNK_BYTES = 64 * 1024;
export const LOCAL_READ_RESULT_BYTES = 8 * 1024;

/** Bound the exact model-visible evidence before its receipt is issued. */
export function boundReadResult(text: string): { text: string; truncated: boolean } {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= LOCAL_READ_RESULT_BYTES) return { text, truncated: false };
	const notice = "\n[Partial result: evidence text limit reached]";
	const prefix = new TextDecoder("utf-8", { fatal: true }).decode(
		bytes.subarray(0, LOCAL_READ_RESULT_BYTES - Buffer.byteLength(notice)),
		{ stream: true },
	);
	return { text: prefix + notice, truncated: true };
}

export interface ReadSourceReceipt {
	readonly toolName: ReadToolName;
	readonly toolCallId: string;
	readonly sourceRef: string;
	readonly observedAt: number;
	readonly queryDigest: string;
	readonly resultDigest: string;
	readonly coverage: ReadCoverage;
	readonly workClass: "metered-source-io" | "native-process";
	readonly work: ReadWorkTotals;
	/** Synchronous authority only: external filesystem currency requires revalidate. */
	isCurrent(): boolean;
	/** Uses the original reservation and deadline; never publishes another receipt. */
	revalidate(signal?: AbortSignal): Promise<boolean>;
}

/**
 * A read refused by its physical work allowance is a definite, side-effect-free operation outcome: the
 * engine must record it as a completed negative result with a bounded failure code, not as an unknown
 * execution. The inherited error name is the cross-copy identity the engine reads, so it must stay.
 */
export class ReadWorkLimitError extends AgentToolExecutionError {
	constructor(kind: string) {
		super(
			`Read investigation limit reached: ${kind}`,
			`read_limit_${kind.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
			`read-limit:${kind}`,
			"operation_outcome",
		);
	}
}

export interface ReadOperation {
	readonly signal: AbortSignal;
	readonly deadlineAt: number;
	readonly work: ReadWorkTotals;
	assertCurrent(): void;
	charge(kind: ReadWorkKind, amount: number): void;
	remaining(kind: ReadWorkKind): number;
	authorizePath(path: string, kind: "file" | "directory" | "metadata"): Promise<void>;
	/** Prove recursive authority, including absent/historical descendants and all exclusion intersections. */
	authorizeSubtree(path: string): Promise<void>;
	observe(input: {
		sourceRef: string;
		query: string;
		result: string | Uint8Array;
		coverage?: ReadCoverage;
		workClass?: ReadSourceReceipt["workClass"];
		revalidate(operation: ReadOperation): Promise<boolean>;
	}): void;
}

export type ReadOperationFactory = (tool: ReadToolName, toolCallId: string, signal?: AbortSignal) => ReadOperation;

export function readDigest(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

/** One review owns one factory. Each admitted call reserves a matching validation allowance. */
export function createReadOperationFactory(options: {
	signal: AbortSignal;
	deadlineAt?: number;
	authorizePath(path: string, kind: "file" | "directory" | "metadata"): Promise<void>;
	/** Must cover both lexical and canonical namespaces; authorizing the directory alone is insufficient. */
	authorizeSubtree(path: string): Promise<void>;
	isCurrent(): boolean;
	observe(receipt: ReadSourceReceipt): void;
}): ReadOperationFactory {
	const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + LOCAL_READ_DEADLINE_MS);
	const deadlineSignal = AbortSignal.any([options.signal, AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()))]);
	let calls = 0;
	return (toolName, toolCallId, callerSignal) => {
		if (++calls > 3) throw new ReadWorkLimitError("calls");
		const signal = callerSignal ? AbortSignal.any([deadlineSignal, callerSignal]) : deadlineSignal;
		let validationOperation: ReadOperation | undefined;
		const createOperation = (validation: boolean, validationSignal?: AbortSignal): ReadOperation => {
			const used: Record<ReadWorkKind, number> = {
				sourceBytes: 0,
				entries: 0,
				files: 0,
				metadata: 0,
				processes: 0,
				outputBytes: 0,
			};
			const activeSignal = validationSignal ? AbortSignal.any([signal, validationSignal]) : signal;
			const operation: ReadOperation = {
				signal: activeSignal,
				deadlineAt,
				get work() {
					return Object.freeze({ ...used });
				},
				assertCurrent() {
					activeSignal.throwIfAborted();
					if (Date.now() >= deadlineAt) throw new ReadWorkLimitError("deadline");
					if (!options.isCurrent()) throw new Error("Read investigation authority changed");
				},
				charge(kind, amount) {
					operation.assertCurrent();
					if (!Number.isSafeInteger(amount) || amount < 0 || amount > operation.remaining(kind))
						throw new ReadWorkLimitError(kind);
					used[kind] += amount;
				},
				remaining(kind) {
					return LOCAL_READ_WORK_LIMITS[kind] - used[kind];
				},
				async authorizePath(path, kind) {
					operation.assertCurrent();
					await options.authorizePath(path, kind);
					operation.assertCurrent();
				},
				async authorizeSubtree(path) {
					operation.assertCurrent();
					await options.authorizeSubtree(path);
					operation.assertCurrent();
				},
				observe(input) {
					if (validation) throw new Error("Validation cannot publish read evidence");
					operation.assertCurrent();
					const observedAt = Date.now();
					let validated = false;
					options.observe(
						Object.freeze({
							toolName,
							toolCallId,
							sourceRef: input.sourceRef,
							observedAt,
							queryDigest: readDigest(input.query),
							resultDigest: readDigest(input.result),
							coverage: input.coverage ?? "complete",
							workClass: input.workClass ?? "metered-source-io",
							work: operation.work,
							isCurrent: () => !signal.aborted && Date.now() < deadlineAt && options.isCurrent(),
							async revalidate(nextSignal?: AbortSignal) {
								// A call's reservation is consumed once, not replenished by repeated validation.
								if (validated) return false;
								validated = true;
								try {
									nextSignal?.throwIfAborted();
									validationOperation ??= createOperation(true, nextSignal);
									const current = await input.revalidate(validationOperation);
									validationOperation.assertCurrent();
									return current;
								} catch {
									return false;
								}
							},
						}),
					);
				},
			};
			operation.assertCurrent();
			return operation;
		};
		return createOperation(false);
	};
}
