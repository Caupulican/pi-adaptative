import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMissingFileError, writeFileAtomic } from "../../util/atomic-file.ts";
import { readBoundedTextFile } from "../../util/bounded-file.ts";
import { isPlainRecord } from "../../util/value-guards.ts";
import type { MemoryMutationAdmission } from "../memory-mutation-admission.ts";
import { type MemoryMutationEvidence, MemoryMutationOutcomeError } from "../memory-mutation-outcome.ts";
import type { UserPreferenceCommitReference, UserPreferenceCommitReport } from "../user-preference-metadata.ts";
import { type ArchiveFileChange, type ArchiveMutationPlan, isUserArchiveFileName } from "./user-memory-archive.ts";

const MAX_RECORD_BYTES = 40 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 1025;
const MAX_ERROR_CHARS = 2048;
const USER_STEP = "USER.md";

interface StoredFile {
	name: string;
	before: string | null;
	after: string | null;
	beforeDigest: string | null;
	afterDigest: string | null;
}

interface Receipt {
	state: "complete" | "none" | "partial" | "unknown";
	report: UserPreferenceCommitReport;
	evidence: MemoryMutationEvidence[];
	storageChanged: boolean;
}

interface TransactionRecord {
	version: 1;
	id: string;
	/** Reserved at admission so recovery derives the same audit bytes after receipt-write failure. */
	receiptAt: string;
	user: StoredFile;
	files: StoredFile[];
	audit: UserPreferenceCommitReference | null;
	attempted: string[];
	completed: string[];
	receipt?: Receipt;
}

export interface UserTransactionProgress {
	before(change: ArchiveFileChange): Promise<void>;
	after(change: ArchiveFileChange): Promise<void>;
	beforeUser(): Promise<void>;
	afterUser(): Promise<void>;
}

interface TransactionPorts {
	userPath: string;
	statePath: string;
	archiveDir: string;
	inspectUser(): Promise<{ content: string; recognized: boolean }>;
	settle?(reference: UserPreferenceCommitReference, report: UserPreferenceCommitReport): boolean;
}

function digest(value: string | null): string | null {
	return value === null ? null : createHash("sha256").update(value).digest("hex");
}

function validFile(value: unknown): value is StoredFile {
	return (
		isPlainRecord(value) &&
		typeof value.name === "string" &&
		(value.before === null || typeof value.before === "string") &&
		(value.after === null || typeof value.after === "string") &&
		Buffer.byteLength(value.before ?? "", "utf8") <= MAX_FILE_BYTES &&
		Buffer.byteLength(value.after ?? "", "utf8") <= MAX_FILE_BYTES &&
		value.beforeDigest === digest(value.before) &&
		value.afterDigest === digest(value.after)
	);
}

/** One pending USER operation. Every method is called while the owning USER.md lock is held. */
export class UserMemoryTransaction {
	readonly path: string;
	private readonly ports: TransactionPorts;
	private retained: TransactionRecord | undefined;

	constructor(ports: TransactionPorts) {
		this.ports = ports;
		this.path = `${ports.statePath}.transaction.json`;
	}

	private decode(value: unknown): TransactionRecord {
		if (
			!isPlainRecord(value) ||
			value.version !== 1 ||
			typeof value.id !== "string" ||
			!/^[a-f0-9-]{36}$/.test(value.id) ||
			typeof value.receiptAt !== "string" ||
			!Number.isFinite(Date.parse(value.receiptAt)) ||
			!validFile(value.user) ||
			value.user.name !== USER_STEP ||
			typeof value.user.before !== "string" ||
			typeof value.user.after !== "string" ||
			!Array.isArray(value.files) ||
			value.files.length > MAX_FILES ||
			!value.files.every(
				(file) => validFile(file) && isUserArchiveFileName(file.name) && file.before !== file.after,
			) ||
			new Set(value.files.map((file) => file.name)).size !== value.files.length ||
			!Array.isArray(value.attempted) ||
			!Array.isArray(value.completed)
		)
			throw new Error("Invalid USER transaction plan");
		const steps = new Set([
			...(value.user.before !== value.user.after ? [USER_STEP] : []),
			...value.files.map((file) => file.name),
		]);
		const attempted = value.attempted;
		for (const list of [value.attempted, value.completed]) {
			if (
				list.length > steps.size ||
				new Set(list).size !== list.length ||
				!list.every((id) => typeof id === "string" && steps.has(id))
			)
				throw new Error("Invalid USER transaction progress");
		}
		if (!value.completed.every((id) => attempted.includes(id)))
			throw new Error("USER transaction completion lacks an attempt");
		if (
			value.audit !== null &&
			(!isPlainRecord(value.audit) ||
				typeof value.audit.id !== "string" ||
				!/^audit-[a-f0-9-]{36}$/.test(value.audit.id) ||
				!isPlainRecord(value.audit.data) ||
				value.audit.data.id !== value.audit.id ||
				Buffer.byteLength(JSON.stringify(value.audit)) > 128 * 1024)
		)
			throw new Error("Invalid USER transaction audit reference");
		if (value.receipt !== undefined) {
			const receipt = value.receipt;
			if (
				!isPlainRecord(receipt) ||
				!["complete", "none", "partial", "unknown"].includes(String(receipt.state)) ||
				!isPlainRecord(receipt.report) ||
				typeof receipt.report.persisted !== "boolean" ||
				receipt.report.settledAt !== value.receiptAt ||
				typeof receipt.storageChanged !== "boolean" ||
				!Array.isArray(receipt.evidence) ||
				receipt.evidence.length > MAX_FILES + 1 ||
				!receipt.evidence.every(
					(item) =>
						isPlainRecord(item) &&
						typeof item.path === "string" &&
						["before", "after", "unknown"].includes(String(item.state)) &&
						typeof item.attempted === "boolean",
				) ||
				receipt.report.persisted !== (receipt.state === "complete") ||
				(!receipt.report.persisted &&
					(typeof receipt.report.error !== "string" || receipt.report.error.length > MAX_ERROR_CHARS))
			)
				throw new Error("Invalid USER transaction receipt");
			const record = value as unknown as TransactionRecord;
			const summary = this.summarize(record, record.receipt!.evidence);
			if (
				receipt.state !== summary.state ||
				receipt.storageChanged !== summary.storageChanged ||
				(receipt.state === "complete" || receipt.state === "none"
					? receipt.report.outcome !== undefined || receipt.report.storageChanged !== undefined
					: receipt.report.outcome !== receipt.state || receipt.report.storageChanged !== summary.storageChanged)
			)
				throw new Error("USER receipt contradicts its plan or progress");
		}
		return value as unknown as TransactionRecord;
	}

	/** Derive terminal classification from the exact ordered plan, never from a stored verdict alone. */
	private summarize(
		record: TransactionRecord,
		evidence: MemoryMutationEvidence[],
	): Pick<Receipt, "state" | "storageChanged"> {
		const files = [...record.files, record.user];
		if (evidence.length !== files.length) throw new Error("USER receipt omits planned storage evidence");
		let allAfter = true;
		let allBefore = true;
		let unknown = false;
		let storageChanged = record.completed.length > 0;
		for (const [index, file] of files.entries()) {
			const item = evidence[index];
			const path = file === record.user ? this.ports.userPath : join(this.ports.archiveDir, file.name);
			if (item.path !== path || item.attempted !== record.attempted.includes(file.name))
				throw new Error("USER receipt evidence has a different storage identity");
			if (item.state === "unknown") {
				unknown = true;
				allAfter = allBefore = false;
			} else if (file.before === file.after) {
				if (item.state !== "before") throw new Error("USER receipt claims an effect for unchanged storage");
			} else if (item.state === "after") {
				if (!item.attempted) throw new Error("USER receipt credits an unattempted storage effect");
				allBefore = false;
				storageChanged = true;
			} else {
				if (record.completed.includes(file.name)) throw new Error("Completed USER effect lacks matching bytes");
				allAfter = false;
			}
		}
		return {
			state: unknown ? "unknown" : allAfter ? "complete" : allBefore && !storageChanged ? "none" : "partial",
			storageChanged,
		};
	}

	private async read(): Promise<TransactionRecord | undefined> {
		try {
			return this.decode(JSON.parse(await readBoundedTextFile(this.path, MAX_RECORD_BYTES, "USER transaction")));
		} catch (error) {
			if (isMissingFileError(error)) return undefined;
			throw error;
		}
	}

	private validateCapacity(record: TransactionRecord): void {
		const steps = [...record.files, ...(record.user.before !== record.user.after ? [record.user] : [])];
		const storageChanged = steps.length > 0;
		const envelope: TransactionRecord = {
			...record,
			attempted: steps.map((file) => file.name),
			completed: steps.map((file) => file.name),
			receipt: {
				state: "unknown",
				storageChanged,
				report: {
					persisted: false,
					settledAt: record.receiptAt,
					outcome: "unknown",
					storageChanged,
					// Control characters occupy the maximum six JSON bytes per error character.
					error: "\0".repeat(MAX_ERROR_CHARS),
				},
				evidence: [...record.files, record.user].map((file) => ({
					path: file === record.user ? this.ports.userPath : join(this.ports.archiveDir, file.name),
					state: "unknown",
					attempted: file.before !== file.after,
				})),
			},
		};
		if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_RECORD_BYTES)
			throw new Error("USER transaction lacks capacity for its progress and terminal receipt");
	}

	private async save(record: TransactionRecord, admission?: MemoryMutationAdmission): Promise<void> {
		const text = JSON.stringify(record);
		if (Buffer.byteLength(text) > MAX_RECORD_BYTES)
			throw new Error("USER transaction exceeds its serialized byte limit");
		this.decode(JSON.parse(text));
		this.retained = JSON.parse(text) as TransactionRecord;
		try {
			await writeFileAtomic(this.path, text, { mode: 0o600, beforeCommit: () => admission?.assertPending() });
		} catch (error) {
			if (!isDeepStrictEqual(await this.read(), record)) throw error;
		}
		if (!isDeepStrictEqual(await this.read(), record))
			throw new Error("USER transaction changed while being recorded");
	}

	private receipt(record: TransactionRecord, evidence: MemoryMutationEvidence[], error?: unknown): Receipt {
		const { state, storageChanged } = this.summarize(record, evidence);
		const report: UserPreferenceCommitReport =
			state === "complete"
				? { persisted: true, settledAt: record.receiptAt }
				: {
						persisted: false,
						settledAt: record.receiptAt,
						error:
							state === "none"
								? "USER transaction made no storage changes"
								: String(error ?? "Interrupted USER transaction").slice(0, MAX_ERROR_CHARS),
						...(state === "none" ? {} : { outcome: state, storageChanged }),
					};
		return { state, report, evidence, storageChanged };
	}

	private async assess(record: TransactionRecord, error?: unknown): Promise<Receipt> {
		const evidence: MemoryMutationEvidence[] = [];
		for (const file of [...record.files, record.user]) {
			const user = file === record.user;
			const path = user ? this.ports.userPath : join(this.ports.archiveDir, file.name);
			const attempted = record.attempted.includes(file.name);
			let state: MemoryMutationEvidence["state"] = "unknown";
			try {
				let content: string | null;
				if (user) {
					const inspected = await this.ports.inspectUser();
					if (!inspected.recognized) throw new Error("USER metadata no longer recognizes its content");
					content = inspected.content;
				} else {
					try {
						content = await readBoundedTextFile(path, MAX_FILE_BYTES, "USER transaction archive file");
					} catch (readError) {
						if (!isMissingFileError(readError)) throw readError;
						content = null;
					}
				}
				if (file.before === file.after && content === file.before) {
					state = "before"; // Identity only: this no-op contributes no effect or progress requirement.
				} else if (content === file.after && attempted) {
					state = "after";
				} else if (content === file.before && !record.completed.includes(file.name)) {
					state = "before";
				}
			} catch {
				/* Unreadable or conflicting evidence remains unknown. */
			}
			evidence.push({ path, state, attempted });
		}
		return this.receipt(record, evidence, error);
	}

	private async settle(
		record: TransactionRecord,
		error?: unknown,
		unstarted = false,
	): Promise<{ receipt: Receipt; clear: boolean }> {
		const current = await this.assess(record, error);
		if (!record.receipt) {
			record.receipt = unstarted
				? this.receipt(
						record,
						[...record.files, record.user].map((file) => ({
							path: file === record.user ? this.ports.userPath : join(this.ports.archiveDir, file.name),
							state: "before",
							attempted: false,
						})),
					)
				: current;
			await this.save(record);
		}
		const receipt = record.receipt;
		// Null is an explicit no-audit-owner record; a lost/invalid reference never becomes local custody.
		const acknowledged = record.audit === null || this.ports.settle?.(record.audit, receipt.report) === true;
		const clear =
			acknowledged && (receipt.state === "complete" || receipt.state === "none") && current.state === receipt.state;
		if (clear) {
			try {
				await fs.unlink(this.path);
			} catch (unlinkError) {
				if (!isMissingFileError(unlinkError)) return { receipt, clear: false };
			}
			this.retained = undefined;
		}
		return { receipt, clear };
	}

	async recover(): Promise<{ clear: boolean; message?: string }> {
		try {
			let record = await this.read();
			const retained = this.retained;
			if (retained && retained.id !== record?.id && retained.receipt) {
				const receipt = retained.receipt;
				// No matching disk intent remains to regenerate this receipt after a crash. Transfer
				// its exact outcome before dropping our cache; a peer may already have retired it.
				if (
					(receipt.state === "complete" || receipt.state === "none") &&
					(retained.audit === null || this.ports.settle?.(retained.audit, receipt.report) === true)
				)
					this.retained = undefined;
			}
			if (!record) {
				if (!this.retained) return { clear: true };
				record = this.retained;
				await this.save(record);
			}
			if (this.retained && this.retained.id !== record.id)
				throw new Error("A different USER transaction replaced the retained obligation");
			if (this.retained?.id === record.id && this.retained.receipt) {
				if (record.receipt && !isDeepStrictEqual(record.receipt, this.retained.receipt))
					throw new Error("Conflicting retained USER transaction receipt");
				if (!record.receipt) {
					record = this.retained;
					await this.save(record);
				}
			}
			const result = await this.settle(record);
			return result.clear
				? { clear: true }
				: {
						clear: false,
						message: `USER transaction ${record.id} remains ${result.receipt.state}; evidence retained at ${this.path}. Inspect it before another USER mutation.`,
					};
		} catch (error) {
			return {
				clear: false,
				message: `USER transaction requires inspection at ${this.path}: ${String(error).slice(0, 500)}`,
			};
		}
	}

	async run(
		plan: ArchiveMutationPlan,
		userBefore: string,
		audit: UserPreferenceCommitReference | null,
		admission: MemoryMutationAdmission,
		execute: (progress: UserTransactionProgress) => Promise<string | undefined>,
		takeOwnership: () => void,
	): Promise<{ warning?: string }> {
		if (audit !== null && !this.ports.settle) throw new Error("USER audit settlement owner is unavailable");
		if (await this.read()) throw new Error(`A pending USER transaction exists at ${this.path}`);
		const file = (name: string, before: string | null, after: string | null): StoredFile => ({
			name,
			before,
			after,
			beforeDigest: digest(before),
			afterDigest: digest(after),
		});
		const files = [...plan.shards, ...(plan.index ? [plan.index] : [])].map((change) => {
			if (dirname(change.path) !== this.ports.archiveDir || !isUserArchiveFileName(basename(change.path)))
				throw new Error("USER transaction escaped its archive owner");
			return file(basename(change.path), change.before, change.after);
		});
		const record: TransactionRecord = {
			version: 1,
			id: randomUUID(),
			receiptAt: new Date().toISOString(),
			user: file(USER_STEP, userBefore, plan.userContent),
			files,
			audit,
			attempted: [],
			completed: [],
		};
		// Validate before transferring audit ownership; all earlier failures remain the caller's responsibility.
		this.decode(record);
		this.validateCapacity(record);
		takeOwnership();
		const mark = async (name: string, complete: boolean): Promise<void> => {
			const list = complete ? record.completed : record.attempted;
			if (!list.includes(name)) {
				list.push(name);
				await this.save(record, admission);
			}
		};
		let warning: string | undefined;
		let failure: unknown;
		let executionStarted = false;
		try {
			await this.save(record, admission);
			executionStarted = true;
			warning = await execute({
				before: (change) => mark(basename(change.path), false),
				after: (change) => mark(basename(change.path), true),
				beforeUser: () => mark(USER_STEP, false),
				afterUser: () => mark(USER_STEP, true),
			});
		} catch (error) {
			failure = error;
		}
		let result: { receipt: Receipt; clear: boolean };
		try {
			result = await this.settle(record, failure, !executionStarted);
		} catch (error) {
			const receipt = record.receipt ?? (await this.assess(record, failure ?? error));
			if (receipt.state === "complete")
				return {
					warning: `USER content committed; transaction receipt remains pending at ${this.path}. ${String(error).slice(0, 300)}`,
				};
			if (receipt.state === "none")
				throw new Error(
					`USER transaction made no storage changes; receipt remains pending at ${this.path}. ${String(failure ?? error).slice(0, 300)}`,
				);
			throw new MemoryMutationOutcomeError(error, receipt.state, receipt.storageChanged, receipt.evidence);
		}
		if (result.receipt.state !== "complete") {
			if (result.receipt.state === "none") throw failure ?? new Error("USER transaction made no changes");
			throw new MemoryMutationOutcomeError(
				`USER transaction retained at ${this.path}: ${String(failure ?? "incomplete")}`,
				result.receipt.state,
				result.receipt.storageChanged,
				result.receipt.evidence,
			);
		}
		return {
			warning:
				[
					warning,
					!result.clear
						? `USER content committed; audit or transaction cleanup remains pending at ${this.path}.`
						: undefined,
					failure ? `Commit acknowledgement was reconciled: ${String(failure).slice(0, 300)}` : undefined,
				]
					.filter(Boolean)
					.join(" ") || undefined,
		};
	}
}
