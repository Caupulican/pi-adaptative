import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isPositiveSafePid, probeProcessLiveness } from "../../kernel/reliability/process-tree.ts";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../util/bounded-file.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import { type AutoLearnHandoffRecord, MAX_AUTO_LEARN_BLOCK_BYTES } from "./auto-learn-proposals.ts";

const OWNED_SUFFIX = ".reoffer-owned";
const JOURNAL_SUFFIX = ".reoffer-journal";
const LEGACY_SUFFIX = ".reoffer-claimed";
const NOTICE_SUFFIX = ".notice-pending";
// A retained raw JSON string may double its escaping, while parsed forwarded evidence is also
// retained. Reserve another block for report/rationale fields; bound the actual serialized bytes.
const MAX_RECORD_BYTES = 4 * MAX_AUTO_LEARN_BLOCK_BYTES + 64 * 1024;
const MAX_JOURNAL_BYTES = MAX_RECORD_BYTES + 8 * 1024;
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_RETAINED_CLAIMS = 64;

export interface AutoLearnClaim {
	readonly directory: string;
	readonly runId: string;
	readonly id: string;
	readonly sourceDigest: string;
}

interface ClaimJournal {
	version: 1;
	id: string;
	runId: string;
	sourceDigest: string;
	owner: { host: string; pid: number; sessionId: string };
	phase: "applying" | "completed";
	completion?: AutoLearnHandoffRecord;
}

interface RetainedClaim {
	journal: ClaimJournal;
	completion?: AutoLearnHandoffRecord;
}

export type AutoLearnPublication =
	| { status: "persisted"; record: AutoLearnHandoffRecord }
	| { status: "acknowledged" }
	| { status: "held" | "conflict"; reason: string };

const SCAN_BATCH_SIZE = 128;

interface ScanCursor {
	tenant: string;
	runId: string;
}

interface HandoffBatch {
	records: Array<{ directory: string; runId: string }>;
	issues: string[];
}

export type AutoLearnHandoffInspection =
	| { kind: "pending"; mtimeMs: number }
	| { kind: "recovery" }
	| { kind: "final" };

function validRunId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);
}

function optionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isHandoffRecord(value: unknown): value is AutoLearnHandoffRecord {
	if (!isPlainRecord(value) || value.version !== 1 || !validRunId(value.runId)) return false;
	if (
		typeof value.sessionId !== "string" ||
		typeof value.childSessionId !== "string" ||
		(value.kind !== "auto" && value.kind !== "reflection") ||
		![
			"reported",
			"child_failed",
			"unparseable",
			"learner_not_pass",
			"parent_session_changed",
			"apply_failed",
		].includes(String(value.status)) ||
		!isPlainRecord(value.exit) ||
		(value.exit.code !== null && !Number.isSafeInteger(value.exit.code)) ||
		(value.exit.signal !== null && typeof value.exit.signal !== "string") ||
		(value.verdict !== undefined && !["PASS", "BLOCKED", "FAIL"].includes(String(value.verdict))) ||
		!optionalString(value.rationale) ||
		!optionalString(value.detail) ||
		!optionalString(value.unappliedProposals) ||
		typeof value.completedAt !== "string" ||
		!Array.isArray(value.entries) ||
		!Array.isArray(value.forwarded)
	)
		return false;
	if (
		value.reoffered !== undefined &&
		(!isPlainRecord(value.reoffered) ||
			typeof value.reoffered.sessionId !== "string" ||
			typeof value.reoffered.at !== "string")
	)
		return false;
	return (
		value.entries.every(
			(entry) =>
				isPlainRecord(entry) &&
				Number.isSafeInteger(entry.index) &&
				typeof entry.kind === "string" &&
				["applied", "proposed", "ineligible", "failed", "rejected", "forwarded"].includes(String(entry.outcome)) &&
				typeof entry.reasonCode === "string" &&
				optionalString(entry.subject) &&
				optionalString(entry.detail) &&
				optionalString(entry.proposalId),
		) &&
		value.forwarded.every(
			(entry) =>
				isPlainRecord(entry) &&
				Number.isSafeInteger(entry.index) &&
				(entry.kind === "extension_spec" || entry.kind === "source_patch") &&
				typeof entry.title === "string" &&
				typeof entry.detail === "string",
		)
	);
}

function isPending(record: AutoLearnHandoffRecord): boolean {
	return (
		record.status === "parent_session_changed" &&
		record.verdict === "PASS" &&
		typeof record.unappliedProposals === "string" &&
		record.unappliedProposals.length > 0 &&
		record.reoffered === undefined
	);
}

function encode(value: unknown, limit: number): string {
	const text = JSON.stringify(value);
	if (Buffer.byteLength(text, "utf8") > limit) throw new Error("Auto Learn handoff exceeds its storage bound");
	return text;
}

function recordText(record: AutoLearnHandoffRecord): string {
	if (!isHandoffRecord(record)) throw new Error("Invalid Auto Learn handoff record");
	return encode(record, MAX_RECORD_BYTES);
}

function digest(record: AutoLearnHandoffRecord): string {
	return createHash("sha256").update(recordText(record)).digest("hex");
}

function sameOrigin(source: AutoLearnHandoffRecord, result: AutoLearnHandoffRecord): boolean {
	return (
		["version", "runId", "sessionId", "childSessionId", "kind", "exit", "verdict", "rationale", "forwarded"] as const
	).every((key) => isDeepStrictEqual(source[key], result[key]));
}

function readRecord(file: string): AutoLearnHandoffRecord {
	const value: unknown = JSON.parse(readBoundedTextFileSync(file, MAX_RECORD_BYTES, "Auto Learn handoff"));
	if (!isHandoffRecord(value)) throw new Error("Invalid Auto Learn handoff record");
	return value;
}

function readJournal(file: string): ClaimJournal {
	const value: unknown = JSON.parse(readBoundedTextFileSync(file, MAX_JOURNAL_BYTES, "Auto Learn claim"));
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["version", "id", "runId", "sourceDigest", "owner", "phase", "completion"]) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		!/^[a-f0-9-]{36}$/.test(value.id) ||
		!validRunId(value.runId) ||
		typeof value.sourceDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.sourceDigest) ||
		!isPlainRecord(value.owner) ||
		!hasOnlyKeys(value.owner, ["host", "pid", "sessionId"]) ||
		typeof value.owner.host !== "string" ||
		!isPositiveSafePid(value.owner.pid) ||
		typeof value.owner.sessionId !== "string" ||
		(value.phase !== "applying" && value.phase !== "completed") ||
		(value.phase === "applying" ? value.completion !== undefined : !isHandoffRecord(value.completion)) ||
		(value.completion !== undefined &&
			(!isHandoffRecord(value.completion) || value.completion.runId !== value.runId || isPending(value.completion)))
	) {
		throw new Error("Invalid Auto Learn claim journal");
	}
	return value as unknown as ClaimJournal;
}

/** Claims, recovery, retention and publication share one short filesystem transaction owner. */
export class AutoLearnHandoffStore {
	private readonly retentionMs: number;
	private readonly retained = new Map<string, RetainedClaim>();

	constructor(retentionMs: number) {
		this.retentionMs = retentionMs;
	}

	private locked<T>(directory: string, operation: (directory: string) => T): T {
		mkdirSync(directory, { recursive: true });
		const canonical = realpathSync(directory);
		return withFileLockSync(canonical, () => operation(canonical), { retries: 0, realpath: true });
	}

	private file(directory: string, runId: string): string {
		if (!validRunId(runId)) throw new Error("Invalid Auto Learn run identity");
		return join(directory, `${runId}.json`);
	}

	private protected(file: string, includeNotice = true): boolean {
		return (
			[OWNED_SUFFIX, JOURNAL_SUFFIX, LEGACY_SUFFIX].some((suffix) => existsSync(`${file}${suffix}`)) ||
			(includeNotice && existsSync(`${file}${NOTICE_SUFFIX}`))
		);
	}

	private prune(directory: string, now: number, publishedFile: string): void {
		for (const name of readBoundedDirectoryNamesSync(directory, MAX_DIRECTORY_ENTRIES, "Auto Learn handoffs")) {
			if (!name.endsWith(".json")) continue;
			const file = join(directory, name);
			if (file === publishedFile) continue;
			if (this.protected(file)) continue;
			const stat = lstatSync(file);
			if (stat.isFile() && now - stat.mtimeMs > this.retentionMs) unlinkSync(file);
		}
	}

	publish(directory: string, record: AutoLearnHandoffRecord): AutoLearnPublication {
		try {
			const text = recordText(record);
			return this.locked(directory, (canonical) => {
				const file = this.file(canonical, record.runId);
				if (this.protected(file, false)) return { status: "conflict", reason: "run_has_reoffer_claim" };
				if (!this.writePublication(file, text)) return { status: "conflict", reason: "publication_conflict" };
				// A retention fault cannot erase an already acknowledged publication.
				try {
					this.prune(canonical, Date.now(), file);
				} catch {
					/* Retry retention on a later publication. */
				}
				return { status: "persisted", record: JSON.parse(text) as AutoLearnHandoffRecord };
			});
		} catch (error) {
			return { status: "held", reason: String(error).slice(0, 512) };
		}
	}

	/** Reserve a bounded round-robin batch before reading records; held and malformed items advance too. */
	scanProject(tenantsDir: string, cwdHash: string, handoffDirName: string): HandoffBatch {
		if (!/^[a-f0-9]{8}$/.test(cwdHash)) throw new Error("Invalid Auto Learn project identity");
		if (!existsSync(tenantsDir)) return { records: [], issues: [] };
		return this.locked(tenantsDir, (root) => {
			const cursorFile = join(root, `.reoffer-${cwdHash}.cursor`);
			let cursor: ScanCursor | undefined;
			try {
				const value: unknown = JSON.parse(readBoundedTextFileSync(cursorFile, 1024, "Auto Learn scan cursor"));
				if (
					!isPlainRecord(value) ||
					!hasOnlyKeys(value, ["tenant", "runId"]) ||
					typeof value.tenant !== "string" ||
					!validRunId(value.runId)
				)
					throw new Error("Invalid Auto Learn scan cursor");
				cursor = { tenant: value.tenant, runId: value.runId };
			} catch (error) {
				if (!isMissingFileError(error)) throw error;
			}
			const tenants = readBoundedDirectoryNamesSync(root, MAX_DIRECTORY_ENTRIES, "Auto Learn tenants")
				.filter((name) => name.endsWith(`-${cwdHash}`))
				.sort();
			const batch: Array<{ directory: string; runId: string }> = [];
			const issues: string[] = [];
			let nextCursor: ScanCursor | undefined;
			// Two disjoint ranges cover one cycle, starting strictly after the saved position.
			for (const wrap of cursor ? [false, true] : [false]) {
				for (const tenant of tenants) {
					if (cursor && (wrap ? tenant > cursor.tenant : tenant < cursor.tenant)) continue;
					const directory = join(root, tenant, handoffDirName);
					let names: string[];
					try {
						names = readBoundedDirectoryNamesSync(directory, MAX_DIRECTORY_ENTRIES, "Auto Learn handoffs");
					} catch (error) {
						if (!isMissingFileError(error) && issues.length < 32)
							issues.push(`${tenant}: ${String(error).slice(0, 512)}`);
						continue;
					}
					const runIds = new Set<string>();
					for (const name of names) {
						const suffix = ["", JOURNAL_SUFFIX, OWNED_SUFFIX, LEGACY_SUFFIX, NOTICE_SUFFIX].find((ending) =>
							name.endsWith(`.json${ending}`),
						);
						if (suffix === undefined) continue;
						const runId = name.slice(0, -`.json${suffix}`.length);
						if (validRunId(runId)) runIds.add(runId);
					}
					for (const [file] of this.retained)
						if (dirname(file) === directory) runIds.add(file.slice(directory.length + 1, -5));
					for (const runId of [...runIds].sort()) {
						if (cursor && tenant === cursor.tenant && (wrap ? runId > cursor.runId : runId <= cursor.runId))
							continue;
						batch.push({ directory, runId });
						nextCursor = { tenant, runId };
						if (batch.length === SCAN_BATCH_SIZE) break;
					}
					if (batch.length === SCAN_BATCH_SIZE) break;
				}
				if (batch.length === SCAN_BATCH_SIZE) break;
			}
			if (nextCursor) writeFileAtomicSync(cursorFile, JSON.stringify(nextCursor), { mode: 0o600 });
			return { records: batch, issues };
		});
	}

	inspect(directory: string, runId: string): AutoLearnHandoffInspection {
		return this.locked(directory, (canonical) => {
			const file = this.file(canonical, runId);
			if (this.protected(file, false) || this.retained.has(file)) return { kind: "recovery" };
			if (existsSync(`${file}${NOTICE_SUFFIX}`) && !existsSync(file)) return { kind: "recovery" };
			const record = readRecord(file);
			if (record.runId !== runId) throw new Error("Auto Learn file identity mismatch");
			if (existsSync(`${file}${NOTICE_SUFFIX}`)) {
				if (recordText(readRecord(`${file}${NOTICE_SUFFIX}`)) !== recordText(record))
					throw new Error("Auto Learn notice identity mismatch");
				// A pending proposal's status notice is superseded by its resulting application notice.
				if (!isPending(record)) return { kind: "recovery" };
			}
			return isPending(record) ? { kind: "pending", mtimeMs: lstatSync(file).mtimeMs } : { kind: "final" };
		});
	}

	claim(
		directory: string,
		runId: string,
		sessionId: string,
	): { claim: AutoLearnClaim; record: AutoLearnHandoffRecord } | undefined {
		return this.locked(directory, (canonical) => {
			const file = this.file(canonical, runId);
			if (this.protected(file, false)) return undefined;
			if (this.retained.size >= MAX_RETAINED_CLAIMS) throw new Error("Auto Learn retained claim capacity reached");
			let record: AutoLearnHandoffRecord;
			try {
				record = readRecord(file);
			} catch (error) {
				if (isMissingFileError(error)) return undefined;
				throw error;
			}
			if (record.runId !== runId || !isPending(record)) return undefined;
			if (
				existsSync(`${file}${NOTICE_SUFFIX}`) &&
				recordText(readRecord(`${file}${NOTICE_SUFFIX}`)) !== recordText(record)
			)
				throw new Error("Auto Learn pending notice changed");
			const journal: ClaimJournal = {
				version: 1,
				id: randomUUID(),
				runId,
				sourceDigest: digest(record),
				owner: { host: hostname(), pid: process.pid, sessionId },
				phase: "applying",
			};
			// Hide the source from older readers before any effect is authorized. A crash here leaves
			// an identity-free orphan for inspection, never a pending record that can be reapplied.
			renameSync(file, `${file}${OWNED_SUFFIX}`);
			writeFileAtomicSync(`${file}${JOURNAL_SUFFIX}`, encode(journal, MAX_JOURNAL_BYTES), { mode: 0o600 });
			const confirmed = readJournal(`${file}${JOURNAL_SUFFIX}`);
			if (encode(confirmed, MAX_JOURNAL_BYTES) !== encode(journal, MAX_JOURNAL_BYTES))
				throw new Error("Auto Learn claim changed");
			this.retained.set(file, { journal });
			return { claim: { directory: canonical, runId, id: journal.id, sourceDigest: journal.sourceDigest }, record };
		});
	}

	complete(claim: AutoLearnClaim, record: AutoLearnHandoffRecord): AutoLearnPublication {
		const file = this.file(claim.directory, claim.runId);
		const retained = this.retained.get(file);
		if (!retained || retained.journal.id !== claim.id || retained.journal.sourceDigest !== claim.sourceDigest) {
			return { status: "conflict", reason: "claim_not_owned" };
		}
		try {
			if (!retained.completion) {
				const text = recordText(record);
				if (record.runId !== claim.runId || isPending(record)) throw new Error("Invalid Auto Learn completion");
				retained.completion = JSON.parse(text) as AutoLearnHandoffRecord;
			}
			return this.locked(claim.directory, () => this.finish(file, retained));
		} catch (error) {
			return { status: "held", reason: String(error).slice(0, 512) };
		}
	}

	private finish(file: string, retained: RetainedClaim): AutoLearnPublication {
		if (
			!existsSync(`${file}${JOURNAL_SUFFIX}`) &&
			!existsSync(`${file}${OWNED_SUFFIX}`) &&
			retained.completion &&
			existsSync(file) &&
			recordText(readRecord(file)) === recordText(retained.completion)
		) {
			this.retained.delete(file);
			if (!existsSync(`${file}${NOTICE_SUFFIX}`)) return { status: "acknowledged" };
			return {
				status: "persisted",
				record: JSON.parse(recordText(retained.completion)) as AutoLearnHandoffRecord,
			};
		}
		let journal = readJournal(`${file}${JOURNAL_SUFFIX}`);
		const expected = retained.journal;
		if (
			journal.id !== expected.id ||
			journal.runId !== expected.runId ||
			journal.sourceDigest !== expected.sourceDigest ||
			encode(journal.owner, 1024) !== encode(expected.owner, 1024)
		)
			return { status: "conflict", reason: "claim_identity_changed" };
		if (!retained.completion) return { status: "held", reason: "application_still_running" };
		const text = recordText(retained.completion);
		if (journal.phase === "completed") {
			if (!journal.completion || recordText(journal.completion) !== text)
				return { status: "conflict", reason: "completion_changed" };
		} else {
			journal = { ...journal, phase: "completed", completion: retained.completion };
			writeFileAtomicSync(`${file}${JOURNAL_SUFFIX}`, encode(journal, MAX_JOURNAL_BYTES), { mode: 0o600 });
		}
		const owned = `${file}${OWNED_SUFFIX}`;
		if (existsSync(owned)) {
			const source = readRecord(owned);
			if (digest(source) !== expected.sourceDigest || !sameOrigin(source, retained.completion))
				return { status: "conflict", reason: "source_changed" };
			// The completed claim owns replacement of this source's initial pending-status notice.
			const notice = `${file}${NOTICE_SUFFIX}`;
			if (existsSync(notice) && recordText(readRecord(notice)) === recordText(source)) unlinkSync(notice);
		} else if (!existsSync(file) || recordText(readRecord(file)) !== text)
			return { status: "conflict", reason: "source_missing" };
		if (!this.writePublication(file, text)) return { status: "conflict", reason: "publication_conflict" };
		this.retained.delete(file);
		return { status: "persisted", record: JSON.parse(text) as AutoLearnHandoffRecord };
	}

	private retainNotice(file: string, text: string): void {
		const notice = `${file}${NOTICE_SUFFIX}`;
		if (existsSync(notice)) {
			if (recordText(readRecord(notice)) !== text) throw new Error("Auto Learn notice conflicts with publication");
		} else writeFileAtomicSync(notice, text, { mode: 0o600 });
	}

	private writePublication(file: string, text: string): boolean {
		if (existsSync(file) && recordText(readRecord(file)) !== text) return false;
		this.retainNotice(file, text);
		if (!existsSync(file)) writeFileAtomicSync(file, text, { mode: 0o600 });
		return recordText(readRecord(file)) === text;
	}

	/** A queued parent notice acknowledges delivery; until then recovery retains the exact receipt. */
	acknowledge(directory: string, record: AutoLearnHandoffRecord): boolean {
		try {
			return this.locked(directory, (canonical) => {
				const file = this.file(canonical, record.runId);
				const text = recordText(record);
				if (recordText(readRecord(file)) !== text || recordText(readRecord(`${file}${NOTICE_SUFFIX}`)) !== text)
					return false;
				const journalFile = `${file}${JOURNAL_SUFFIX}`;
				if (existsSync(journalFile)) {
					const journal = readJournal(journalFile);
					if (journal.phase !== "completed" || !journal.completion || recordText(journal.completion) !== text)
						return false;
					const owned = `${file}${OWNED_SUFFIX}`;
					if (existsSync(owned)) {
						if (digest(readRecord(owned)) !== journal.sourceDigest) return false;
						unlinkSync(owned);
					}
					unlinkSync(journalFile);
				}
				unlinkSync(`${file}${NOTICE_SUFFIX}`);
				this.retained.delete(file);
				return true;
			});
		} catch {
			return false;
		}
	}

	recover(directory: string, runId: string, sessionId: string, now: number): AutoLearnPublication {
		try {
			return this.locked(directory, (canonical) => {
				const file = this.file(canonical, runId);
				const retained = this.retained.get(file);
				if (retained) return this.finish(file, retained);
				if (existsSync(`${file}${LEGACY_SUFFIX}`))
					return { status: "held", reason: "legacy_claim_requires_inspection" };
				if (!existsSync(`${file}${JOURNAL_SUFFIX}`)) {
					if (existsSync(`${file}${OWNED_SUFFIX}`))
						return { status: "held", reason: "orphan_claim_requires_inspection" };
					if (!existsSync(`${file}${NOTICE_SUFFIX}`)) return { status: "held", reason: "notice_not_found" };
					const record = readRecord(`${file}${NOTICE_SUFFIX}`);
					if (record.runId !== runId) return { status: "conflict", reason: "notice_run_mismatch" };
					const text = recordText(record);
					if (!this.writePublication(file, text)) return { status: "conflict", reason: "publication_conflict" };
					return { status: "persisted", record };
				}
				const journal = readJournal(`${file}${JOURNAL_SUFFIX}`);
				if (journal.runId !== runId) return { status: "conflict", reason: "claim_run_mismatch" };
				if (journal.phase === "completed") return this.finish(file, { journal, completion: journal.completion });
				if (journal.owner.host !== hostname() || probeProcessLiveness(journal.owner.pid) !== "dead") {
					return { status: "held", reason: "claim_owner_not_proven_dead" };
				}
				const source = readRecord(`${file}${OWNED_SUFFIX}`);
				if (source.runId !== runId || digest(source) !== journal.sourceDigest)
					return { status: "conflict", reason: "source_changed" };
				const at = new Date(now).toISOString();
				const completion: AutoLearnHandoffRecord = {
					...source,
					status: "apply_failed",
					completedAt: at,
					reoffered: { sessionId, at },
					detail:
						"outcome_unknown: the reoffer owner exited before recording completion. Retained proposals require inspection and were not reapplied.",
				};
				return this.finish(file, { journal, completion });
			});
		} catch (error) {
			return { status: "held", reason: String(error).slice(0, 512) };
		}
	}
}
