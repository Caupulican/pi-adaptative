import { mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { stateFile } from "../agent-paths.ts";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../util/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	canonicalLearningWriteRecord,
	type LearningWriteRecord,
	MAX_LEARNING_WRITE_RECORD_BYTES,
	parseLearningWriteRecord,
	sameLearningWriteOutcome,
} from "./learning-write-record.ts";

const MAX_TERMINAL_RECEIPTS = 256;
const MAX_DIRECTORY_ENTRIES = MAX_TERMINAL_RECEIPTS + 32;
const MAX_ENVELOPE_BYTES = MAX_LEARNING_WRITE_RECORD_BYTES + 256;

interface StoredReceipt {
	storedAt: string;
	record: LearningWriteRecord;
}

/** Bounded completed-outcome history; unresolved obligations stay in the separate write journal. */
export class LearningReceiptStore {
	private readonly agentDir: string;
	private directory: string | undefined;
	private readonly warn: (message: string) => void;

	constructor(agentDir: string, warn: (message: string) => void) {
		this.agentDir = agentDir;
		this.warn = warn;
	}

	private root(): string {
		if (this.directory) return this.directory;
		const directory = stateFile(this.agentDir, "learning", "receipts");
		mkdirSync(directory, { recursive: true });
		this.directory = realpathSync(directory);
		return this.directory;
	}

	private path(id: string): string {
		if (!/^audit-[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid learning receipt identity");
		return join(this.root(), `${id}.json`);
	}

	private read(id: string): StoredReceipt | undefined {
		let value: unknown;
		try {
			value = JSON.parse(readBoundedTextFileSync(this.path(id), MAX_ENVELOPE_BYTES, "learning terminal receipt"));
		} catch (error) {
			if (isMissingFileError(error)) return undefined;
			throw error;
		}
		if (!isPlainRecord(value) || typeof value.storedAt !== "string" || !Number.isFinite(Date.parse(value.storedAt))) {
			throw new Error("Invalid learning terminal receipt envelope");
		}
		const record = parseLearningWriteRecord(value.record, id);
		if (record.phase !== "settled" || record.receipt === undefined || record.publisher !== undefined) {
			throw new Error("Learning terminal receipt is not settled");
		}
		return { storedAt: value.storedAt, record };
	}

	get(id: string): LearningWriteRecord | undefined {
		return withFileLockSync(this.root(), () => this.read(id)?.record, { retries: 0, realpath: true });
	}

	private prune(names: readonly string[], keep: number): void {
		const oldest = names
			.map((name) => {
				const id = name.slice(0, -5);
				const stored = this.read(id);
				if (!stored) throw new Error("Learning terminal history changed during pruning");
				return { id, storedAt: stored.storedAt };
			})
			.sort((left, right) => left.storedAt.localeCompare(right.storedAt) || left.id.localeCompare(right.id));
		for (const entry of oldest.slice(0, Math.max(0, names.length - keep))) unlinkSync(this.path(entry.id));
	}

	/** Verify immutable custody before pruning history; cleanup failure never discards that acknowledgement. */
	put(input: LearningWriteRecord): void {
		const record = canonicalLearningWriteRecord({ ...input, phase: "settled", publisher: undefined });
		if (!record.receipt) throw new Error("A terminal receipt requires an actual outcome");
		withFileLockSync(
			this.root(),
			() => {
				// Exact custody can be acknowledged even while unrelated history cleanup is failing.
				const existing = this.read(record.id);
				if (existing) {
					if (!sameLearningWriteOutcome(existing.record, record))
						throw new Error("Conflicting terminal learning receipt");
					return;
				}
				let allNames = readBoundedDirectoryNamesSync(
					this.root(),
					MAX_DIRECTORY_ENTRIES,
					"learning terminal history",
				);
				let names = allNames.filter((name) => /^audit-[a-f0-9-]{36}\.json$/.test(name));
				if (allNames.length === MAX_DIRECTORY_ENTRIES) {
					// Retire excess already-verified history from earlier writes before admitting another
					// file. A failed cleanup cannot create a directory our own reader cannot enumerate.
					this.prune(names, MAX_TERMINAL_RECEIPTS);
					allNames = readBoundedDirectoryNamesSync(
						this.root(),
						MAX_DIRECTORY_ENTRIES,
						"learning terminal history",
					);
					if (allNames.length === MAX_DIRECTORY_ENTRIES)
						throw new Error("Learning terminal history has no admission capacity");
					names = allNames.filter((name) => /^audit-[a-f0-9-]{36}\.json$/.test(name));
				}
				writeFileAtomicSync(this.path(record.id), JSON.stringify({ storedAt: new Date().toISOString(), record }), {
					mode: 0o600,
				});
				const confirmed = this.read(record.id);
				if (!confirmed || !sameLearningWriteOutcome(confirmed.record, record))
					throw new Error("Learning receipt custody could not be confirmed");
				try {
					this.prune(names, MAX_TERMINAL_RECEIPTS - 1);
				} catch (error) {
					try {
						this.warn(
							`Learning terminal receipt retained; history cleanup failed: ${String(error).slice(0, 300)}`,
						);
					} catch {
						/* Custody is already confirmed. */
					}
				}
			},
			{ retries: 0, realpath: true },
		);
	}
}
