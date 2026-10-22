import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { probeProcessLiveness } from "../../kernel/reliability/process-tree.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { stateFile } from "../agent-paths.ts";
import { classifyCustomEntryPersisted } from "../session-entry-persistence.ts";
import { isSessionAppendAnchorCurrent, type SessionAppendAnchor } from "../session-snapshot.ts";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedDirectoryNamesSync, readBoundedTextFileSync } from "../util/bounded-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { appendLearningAuditSnapshot, LEARNING_AUDIT_CUSTOM_TYPE, type LearningAuditRecord } from "./learning-audit.ts";

import { LearningReceiptStore } from "./learning-receipt-store.ts";
import {
	canonicalLearningWriteRecord as canonicalRecord,
	type LearningWriteRecord as JournalRecord,
	MAX_LEARNING_WRITE_RECORD_BYTES as MAX_RECORD_BYTES,
	parseLearningWriteRecord,
	sameLearningWriteIntent,
	sameLearningWriteOutcome as sameOutcome,
} from "./learning-write-record.ts";

export type LearningApplicationGuard = () => "session_disposed" | "learning_context_changed" | undefined;

interface CapturedContext {
	manager: SessionManager;
	sessionFile: string | undefined;
	anchor: SessionAppendAnchor;
	generation: number | undefined;
}

interface PendingWrite {
	record: JournalRecord;
	guard: LearningApplicationGuard;
	context: CapturedContext;
	intentEntryId?: string;
}

export interface LearningWriteTicket {
	readonly id: string;
}

interface JournalDeps {
	getAgentDir(): string;
	getSessionManager(): SessionManager;
	getContextGeneration?(): number;
	isDisposed(): boolean;
	warn?(message: string): void;
}

const INTENT_TYPE = "learning_write_intent";
const MAX_PENDING = 64;
function cachedReceipts(manager: SessionManager, auditId: string): Array<{ id: string; data: unknown }> {
	return manager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" &&
			entry.customType === LEARNING_AUDIT_CUSTOM_TYPE &&
			isPlainRecord(entry.data) &&
			isPlainRecord(entry.data.record) &&
			entry.data.record.id === auditId
				? [{ id: entry.id, data: entry.data }]
				: [],
		);
}

/** Separates irreversible effect admission from retryable, branch-bound audit publication. */
export class LearningWriteJournal {
	private readonly deps: JournalDeps;
	private readonly contexts = new WeakMap<LearningApplicationGuard, CapturedContext>();
	private readonly pending = new Map<string, PendingWrite>();
	private readonly receipts: LearningReceiptStore;
	private readonly publisher = { host: hostname(), pid: process.pid, ownerId: randomUUID() };
	private recovering = false;
	private recoveryOffset = 0;
	private directory: string | undefined;

	constructor(deps: JournalDeps) {
		this.deps = deps;
		this.receipts = new LearningReceiptStore(deps.getAgentDir(), (message) => this.warn("terminal-history", message));
	}

	capture(): LearningApplicationGuard {
		const manager = this.deps.getSessionManager();
		const context: CapturedContext = {
			manager,
			sessionFile: manager.getSessionFile(),
			anchor: { sessionId: manager.getSessionId(), leafId: manager.getLeafId() },
			generation: this.deps.getContextGeneration?.(),
		};
		const guard: LearningApplicationGuard = () => {
			if (this.deps.isDisposed()) return "session_disposed";
			if (
				this.deps.getSessionManager() !== manager ||
				manager.getSessionFile() !== context.sessionFile ||
				this.deps.getContextGeneration?.() !== context.generation ||
				!isSessionAppendAnchorCurrent(manager, context.anchor)
			)
				return "learning_context_changed";
			return undefined;
		};
		this.contexts.set(guard, context);
		return guard;
	}

	private root(): string {
		if (this.directory) return this.directory;
		const directory = stateFile(this.deps.getAgentDir(), "learning", "write-journal");
		mkdirSync(directory, { recursive: true });
		this.directory = realpathSync(directory);
		return this.directory;
	}

	private file(id: string): string {
		if (!/^audit-[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid learning write identity");
		return join(this.root(), `${id}.json`);
	}

	private locked<T>(operation: () => T): T {
		return withFileLockSync(this.root(), operation, { retries: 0, realpath: true });
	}

	private names(): string[] {
		return readBoundedDirectoryNamesSync(this.root(), MAX_PENDING + 16, "learning write journal").filter((name) =>
			name.endsWith(".json"),
		);
	}

	private read(id: string): JournalRecord {
		const value: unknown = JSON.parse(
			readBoundedTextFileSync(this.file(id), MAX_RECORD_BYTES, "learning write journal"),
		);
		return parseLearningWriteRecord(value, id);
	}

	private write(record: JournalRecord, create = false): void {
		const text = JSON.stringify(canonicalRecord(record));
		if (existsSync(this.file(record.id))) {
			const previous = this.read(record.id);
			if (isDeepStrictEqual(previous, record)) return;
			if (
				(previous.phase === "settled" || previous.phase === "publishing") &&
				record.phase === "publishing" &&
				sameOutcome(previous, record)
			) {
				// One publication attempt is reserved durably before the append.
			} else if (
				previous.phase !== "intent" ||
				previous.sessionFile !== record.sessionFile ||
				previous.anchor.sessionId !== record.anchor.sessionId ||
				!isDeepStrictEqual(previous.planned, record.planned)
			)
				throw new Error("Learning journal transition conflicts with its retained identity");
		} else if (!create) throw new Error("Learning journal disappeared; publication cannot recreate it");
		writeFileAtomicSync(this.file(record.id), text, { mode: 0o600 });
		if (!isDeepStrictEqual(this.read(record.id), JSON.parse(text))) throw new Error("Learning write journal changed");
	}

	private warn(id: string, error: unknown): void {
		try {
			this.deps.warn?.(`Learning audit ${id} retained: ${String(error).slice(0, 400)}`);
		} catch {
			/* Retention does not depend on observers. */
		}
	}

	begin(guard: LearningApplicationGuard, planned: LearningAuditRecord): LearningWriteTicket | undefined {
		const context = this.contexts.get(guard);
		if (!context || guard()) return undefined;
		let pending: PendingWrite | undefined;
		try {
			pending = {
				guard,
				context,
				record: canonicalRecord({
					version: 1,
					id: planned.id,
					sessionFile: context.sessionFile ?? null,
					anchor: { ...context.anchor },
					phase: "intent",
					planned,
				}),
			};
			const admitted = pending;
			this.locked(() => {
				if (this.names().length >= MAX_PENDING || this.pending.size >= MAX_PENDING)
					throw new Error("Learning write journal capacity reached");
				if (existsSync(this.file(planned.id))) throw new Error("Learning audit identity already exists");
				this.pending.set(planned.id, admitted);
				this.write(admitted.record, true);
			});
			if (guard()) {
				this.cancel(pending);
				return undefined;
			}
			const marker = { version: 1, auditId: planned.id };
			const entryId = context.manager.appendCustomEntry(INTENT_TYPE, marker);
			pending.intentEntryId = entryId;
			// A first owned append establishes an otherwise empty branch. Never renew its generation.
			if (context.anchor.leafId === null && context.manager.getEntry(entryId)?.parentId === null)
				context.anchor = { ...context.anchor, leafId: entryId };
			if (guard() || !this.confirm(context.manager, entryId, INTENT_TYPE, marker)) {
				this.cancel(pending);
				return undefined;
			}
			pending.record = { ...pending.record, anchor: { ...context.anchor, leafId: entryId } };
			this.locked(() => this.write(admitted.record));
			if (guard()) {
				this.cancel(pending);
				return undefined;
			}
			return { id: planned.id };
		} catch (error) {
			this.warn(planned.id, error);
			if (pending && this.pending.has(planned.id)) this.cancel(pending);
			return undefined;
		}
	}

	private cancel(pending: PendingWrite): void {
		pending.record = { ...pending.record, phase: "cancelled" };
		try {
			this.locked(() => {
				if (existsSync(this.file(pending.record.id))) {
					this.write(pending.record);
					unlinkSync(this.file(pending.record.id));
				}
			});
			this.pending.delete(pending.record.id);
		} catch (error) {
			this.warn(pending.record.id, error);
		}
	}

	settle(ticket: LearningWriteTicket, receipt: LearningAuditRecord): boolean {
		const pending = this.pending.get(ticket.id);
		if (!pending || receipt.id !== ticket.id) return false;
		try {
			const settled = canonicalRecord({ ...pending.record, phase: "settled", publisher: undefined, receipt });
			if (
				(pending.record.phase === "settled" || pending.record.phase === "publishing") &&
				!sameOutcome(pending.record, settled)
			)
				throw new Error("Learning write completion changed");
			// Keep the actual result before any fallible I/O. A publication retry never executes a write.
			pending.record = settled;
			this.persistOutcome(pending);
			const published = this.publish(pending);
			if (!published) this.warn(ticket.id, "receipt publication awaits its original branch or physical persistence");
			return published;
		} catch (error) {
			this.warn(ticket.id, error);
			return false;
		}
	}

	/** Frozen admission identity for receipt-only recovery; never a renewed mutation permit. */
	reference(ticket: LearningWriteTicket): unknown {
		const record = this.pending.get(ticket.id)?.record;
		if (record?.phase !== "intent" || !record.anchor.leafId) throw new Error("Learning intent is not admitted");
		return canonicalRecord(record);
	}

	/** Accept durable custody independently of branch publication. The caller freezes the report first. */
	acceptExternal(reference: unknown, buildReceipt: (planned: LearningAuditRecord) => LearningAuditRecord): boolean {
		try {
			if (!isPlainRecord(reference) || typeof reference.id !== "string")
				throw new Error("Invalid learning receipt reference");
			const intent = parseLearningWriteRecord(reference, reference.id);
			if (intent.phase !== "intent" || !intent.anchor.leafId || intent.receipt || intent.publisher)
				throw new Error("Expected an admitted learning intent reference");
			const settled = canonicalRecord({ ...intent, phase: "settled", receipt: buildReceipt(intent.planned) });
			if (settled.receipt?.id !== intent.id) throw new Error("Learning receipt changed audit identity");
			const retained = this.pending.get(intent.id);
			if (retained) {
				if (
					!sameLearningWriteIntent(retained.record, intent) ||
					(retained.record.receipt !== undefined && !sameOutcome(retained.record, settled))
				)
					throw new Error("Conflicting retained learning receipt");
				// Retain the actual live outcome before any fallible lock or I/O, as settle() does.
				retained.record = settled;
			}
			this.locked(() => {
				let current: JournalRecord | undefined;
				try {
					current = this.read(intent.id);
				} catch (error) {
					if (!isMissingFileError(error)) throw error;
				}
				const terminal = this.receipts.get(intent.id);
				if (terminal && !sameOutcome(terminal, settled)) throw new Error("Conflicting terminal learning receipt");
				if (
					current &&
					(!sameLearningWriteIntent(current, intent) ||
						current.phase === "cancelled" ||
						(current.receipt !== undefined && !sameOutcome(current, settled)))
				)
					throw new Error("Conflicting pending learning receipt");
				if (
					retained &&
					(!sameLearningWriteIntent(retained.record, intent) ||
						(retained.record.receipt !== undefined && !sameOutcome(retained.record, settled)))
				)
					throw new Error("Conflicting retained learning receipt");
				// A physical conflict is fatal even when a cached terminal receipt happens to agree.
				const published =
					intent.sessionFile !== null && existsSync(intent.sessionFile)
						? this.findPublishedReceipt(this.deps.getSessionManager(), settled)
						: false;
				if (!current && !published && this.names().length >= MAX_PENDING)
					throw new Error("Learning publication capacity reached");
				this.receipts.put(settled);
				// The sole reconstruction exception restores a settled receipt obligation, never an intent.
				if (!published && !current) this.write(settled, true);
				else if (current?.phase === "intent") this.write(settled);
				if (retained) retained.record = current?.phase === "publishing" ? current : settled;
			});
			this.recover();
			return true;
		} catch (error) {
			this.warn("external-receipt", error);
			return false;
		}
	}

	private persistOutcome(pending: PendingWrite): void {
		this.locked(() => {
			const terminal = this.receipts.get(pending.record.id);
			if (terminal && !sameOutcome(terminal, pending.record))
				throw new Error("Conflicting terminal learning receipt");
			const current = this.read(pending.record.id);
			if (current.phase === "publishing" && sameOutcome(current, pending.record)) {
				pending.record = current;
				return;
			}
			this.write(pending.record);
			this.receipts.put(pending.record);
		});
	}

	private confirm(manager: SessionManager, id: string, customType: string, data: unknown): boolean {
		if (!manager.isPersisted()) return true;
		const disposition = classifyCustomEntryPersisted(manager, id, customType, (stored) =>
			isDeepStrictEqual(stored, data),
		);
		if (disposition === "conflict") throw new Error("Learning publication conflicts with the session ledger");
		return disposition === "persisted";
	}

	private publish(pending: PendingWrite): boolean {
		const { record, context, guard } = pending;
		const receipt = record.receipt;
		if ((record.phase !== "settled" && record.phase !== "publishing") || !receipt || guard()) return false;
		const intent = record.anchor.leafId ? context.manager.getEntry(record.anchor.leafId) : undefined;
		const marker = { version: 1, auditId: record.id };
		if (
			intent?.type !== "custom" ||
			intent.customType !== INTENT_TYPE ||
			!isDeepStrictEqual(intent.data, marker) ||
			!this.confirm(context.manager, intent.id, INTENT_TYPE, marker)
		)
			throw new Error("Learning receipt has no matching persisted intent");
		return this.locked(() => {
			let ownsAttempt = false;
			try {
				const current = this.read(record.id);
				if (!sameOutcome(current, record)) throw new Error("Learning publication no longer owns its exact journal");
				if (guard()) return false;
				let acknowledged = false;
				if (current.phase === "publishing") {
					acknowledged = this.findPublishedReceipt(context.manager, current);
					if (
						!acknowledged &&
						current.publisher?.active &&
						(current.publisher.host !== hostname() || current.publisher.pid !== process.pid) &&
						current.publisher?.ownerId !== this.publisher.ownerId &&
						(current.publisher?.host !== hostname() ||
							!current.publisher ||
							probeProcessLiveness(current.publisher.pid) !== "dead")
					)
						return false;
				}
				if (!acknowledged) {
					const entries = cachedReceipts(context.manager, record.id);
					if (entries.length > 1) throw new Error("Ambiguous learning audit identity");
					const expected = { version: 1, record: receipt };
					const existing = entries[0];
					if (existing && !isDeepStrictEqual(existing.data, expected))
						throw new Error("Learning audit identity conflict");
					if (guard()) return false;
					const publishing: JournalRecord = {
						...current,
						phase: "publishing",
						publisher: { ...this.publisher, active: true },
					};
					ownsAttempt = true;
					this.write(publishing);
					pending.record = publishing;
					if (guard()) return false;
					const id = existing?.id ?? appendLearningAuditSnapshot(context.manager, receipt);
					const ancestry = context.manager.getBranch(id);
					if (
						!record.anchor.leafId ||
						!ancestry.some((entry) => entry.id === record.anchor.leafId) ||
						!this.confirm(context.manager, id, LEARNING_AUDIT_CUSTOM_TYPE, expected)
					)
						return false;
				}
				// Memory-only publication is process-local. Transfer to durable terminal history first.
				this.receipts.put(current);
				unlinkSync(this.file(record.id));
				this.pending.delete(record.id);
				return true;
			} finally {
				// A failed synchronous attempt is no longer an active publisher. Keep its result, not its process lifetime.
				if (ownsAttempt && existsSync(this.file(record.id))) {
					try {
						const held = this.read(record.id);
						if (held.phase === "publishing" && held.publisher?.ownerId === this.publisher.ownerId)
							this.write({ ...held, publisher: { ...held.publisher, active: false } });
					} catch (error) {
						this.warn(record.id, error);
					}
				}
			}
		});
	}

	/** A prior uncertain append is resolved from canonical bytes, never another manager's cached entries. */
	private findPublishedReceipt(manager: SessionManager, record: JournalRecord): boolean {
		const expected = { version: 1, record: record.receipt };
		if (record.sessionFile === null) {
			if (manager.getSessionId() !== record.anchor.sessionId) return false;
			const entries = cachedReceipts(manager, record.id);
			if (entries.length === 0) return false;
			if (
				entries.length !== 1 ||
				!isDeepStrictEqual(entries[0].data, expected) ||
				!manager.getBranch(entries[0].id).some((entry) => entry.id === record.anchor.leafId)
			)
				throw new Error("Learning receipt identity or lineage conflicts with its intent");
			return true;
		}
		if (!record.sessionFile) return false;
		const source = readBoundedTextFileSync(record.sessionFile, 64 * 1024 * 1024, "learning receipt session");
		if (!source.endsWith("\n")) throw new Error("Learning receipt session has an incomplete row");
		const rows = source.split("\n", 100_003);
		if (rows.length > 100_001) throw new Error("Learning receipt session exceeds its row bound");
		const header: unknown = JSON.parse(rows[0]);
		if (!isPlainRecord(header) || header.type !== "session" || header.id !== record.anchor.sessionId)
			throw new Error("Learning receipt session identity changed");
		const parents = new Map<string, string | null>();
		let receiptId: string | undefined;
		let intentFound = false;
		for (const row of rows.slice(1)) {
			if (!row) continue;
			const entry: unknown = JSON.parse(row);
			if (
				!isPlainRecord(entry) ||
				typeof entry.id !== "string" ||
				(entry.parentId !== null && typeof entry.parentId !== "string") ||
				parents.has(entry.id)
			)
				throw new Error("Invalid learning receipt session entry");
			parents.set(entry.id, entry.parentId);
			if (entry.id === record.anchor.leafId) {
				if (
					entry.type !== "custom" ||
					entry.customType !== INTENT_TYPE ||
					!isDeepStrictEqual(entry.data, { version: 1, auditId: record.id })
				)
					throw new Error("Learning receipt intent changed");
				intentFound = true;
			}
			if (
				entry.type !== "custom" ||
				entry.customType !== LEARNING_AUDIT_CUSTOM_TYPE ||
				!isPlainRecord(entry.data) ||
				!isPlainRecord(entry.data.record) ||
				entry.data.record.id !== record.id
			)
				continue;
			if (receiptId || !isDeepStrictEqual(entry.data, expected))
				throw new Error("Conflicting persisted learning receipts");
			receiptId = entry.id;
		}
		const seen = new Set<string>();
		if (!intentFound) throw new Error("Learning receipt intent is missing");
		if (receiptId === undefined) return false;
		while (receiptId && !seen.has(receiptId)) {
			if (receiptId === record.anchor.leafId) return true;
			seen.add(receiptId);
			receiptId = parents.get(receiptId) ?? undefined;
		}
		throw new Error("Persisted learning receipt left its intent lineage");
	}

	/** Recover only audit publication on the current intent lineage; mutation permits are never renewed. */
	recover(): void {
		if (this.deps.isDisposed() || this.recovering) return;
		this.recovering = true;
		try {
			const guard = this.capture();
			const context = this.contexts.get(guard)!;
			const names = this.locked(() =>
				[...new Set([...this.names(), ...[...this.pending.keys()].map((id) => `${id}.json`)])].sort(),
			);
			if (names.length === 0) return;
			// Bounded round-robin recovery never repeatedly scans every pending session at an input boundary.
			const start = this.recoveryOffset % names.length;
			const count = Math.min(4, names.length);
			this.recoveryOffset = (start + count) % names.length;
			for (let index = 0; index < count; index++) {
				const name = names[(start + index) % names.length];
				if (guard()) return;
				const id = name.slice(0, -5);
				try {
					let record = this.pending.get(id)?.record ?? this.locked(() => this.read(id));
					const retained = this.pending.get(id);
					const terminal = this.receipts.get(id);
					if (terminal) {
						if (!sameLearningWriteIntent(record, terminal) || (record.receipt && !sameOutcome(record, terminal)))
							throw new Error("Terminal receipt conflicts with pending work");
						if (!existsSync(this.file(id))) {
							// A peer can publish and retire the pending file before this controller observes it.
							// Exact terminal custody is still durable; check any physical record for conflicts.
							if (terminal.sessionFile && existsSync(terminal.sessionFile))
								this.findPublishedReceipt(context.manager, terminal);
							this.pending.delete(id);
							continue;
						}
						if (record.phase === "intent") {
							record = this.locked(() => {
								const current = this.read(id);
								if (current.phase === "intent") {
									this.write(terminal);
									return terminal;
								}
								if (!sameOutcome(current, terminal))
									throw new Error("Learning transfer conflicts with current publication");
								return current;
							});
							if (retained) retained.record = record;
						}
					}
					if (retained && !existsSync(this.file(id))) {
						if (
							record.phase === "cancelled" ||
							((record.phase === "settled" || record.phase === "publishing") &&
								this.findPublishedReceipt(retained.context.manager, record))
						)
							this.pending.delete(id);
						else this.warn(id, "journal missing without a confirmed receipt; retained for reconciliation");
						continue;
					}
					if (record.phase === "cancelled") {
						this.locked(() => {
							this.write(record);
							unlinkSync(this.file(id));
						});
						this.pending.delete(id);
						continue;
					}
					if (
						record.anchor.sessionId !== context.anchor.sessionId ||
						record.sessionFile !== (context.sessionFile ?? null) ||
						!isSessionAppendAnchorCurrent(context.manager, record.anchor)
					)
						continue;
					if (record.phase === "intent") {
						if (!this.pending.has(id)) this.warn(id, "effect outcome unknown; no mutation replay is permitted");
						continue;
					}
					if (retained && record.phase === "settled") {
						this.persistOutcome(retained);
						record = retained.record;
					}
					this.publish({ record, context, guard });
				} catch (error) {
					if (!isMissingFileError(error)) this.warn(id, error);
				}
			}
		} catch (error) {
			this.warn("recovery", error);
		} finally {
			this.recovering = false;
		}
	}
}
