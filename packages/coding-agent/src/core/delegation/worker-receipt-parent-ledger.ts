import { type Stats, statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { withSessionFileMutation } from "../../kernel/session/session-file-admission.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { readBoundedTextFileSync, sameFileVersion } from "../../kernel/storage/bounded-file.ts";
import { isPlainRecord } from "../../kernel/utils/value-guards.ts";
import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "../orchestration/contracts.ts";
import {
	decodeWorkerReceiptPublication,
	decodeWorkerReceiptReview,
	type WorkerReceiptAcknowledgement,
	type WorkerReceiptCandidate,
	type WorkerReceiptPublication,
} from "../orchestration/worker-receipt-publication.ts";
import { classifyCustomEntryPersisted, MAX_PERSISTED_CUSTOM_ENTRY_BYTES } from "../session-entry-persistence.ts";
import { isSessionAppendAnchorCurrent } from "../session-snapshot.ts";
import { WORKER_RECEIPTS_CUSTOM_TYPE } from "../work-units.ts";
import { WORKER_CLAIM_CUSTOM_TYPE } from "./session-worker-claim.ts";

const MAX_PARENT_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_PARENT_ENTRIES = 100_000;
const MAX_PARENT_LINE_CHARS = MAX_PARENT_SCAN_BYTES;

interface ParentEntry {
	readonly id: string;
	readonly parentId: string | null;
	readonly customType?: string;
	readonly data?: unknown;
}

/** Strict bounded absence proof: no permissive loader may skip a conflicting or torn receipt. */
function readParentEntries(file: string, sessionId: string): Map<string, ParentEntry> {
	const source = readBoundedTextFileSync(file, MAX_PARENT_SCAN_BYTES, "Worker receipt parent history");
	if (!source.endsWith("\n")) throw new Error("Worker receipt history has an incomplete tail.");
	const entries = new Map<string, ParentEntry>();
	let offset = 0;
	let header = false;
	while (offset < source.length) {
		const end = source.indexOf("\n", offset);
		if (end < 0 || end - offset > MAX_PARENT_LINE_CHARS)
			throw new Error("Worker receipt history exceeds its line bound.");
		const value: unknown = JSON.parse(source.slice(offset, end));
		offset = end + 1;
		if (!isPlainRecord(value)) throw new Error("Worker receipt history contains a malformed record.");
		if (!header) {
			if (
				value.type !== "session" ||
				value.id !== sessionId ||
				typeof value.version !== "number" ||
				value.version < 2
			)
				throw new Error("Worker receipt history has a different session identity.");
			header = true;
			continue;
		}
		if (
			entries.size >= MAX_PARENT_ENTRIES ||
			typeof value.id !== "string" ||
			!value.id ||
			typeof value.type !== "string" ||
			(value.parentId !== null && typeof value.parentId !== "string") ||
			entries.has(value.id)
		)
			throw new Error("Worker receipt history has invalid entry identities.");
		entries.set(value.id, {
			id: value.id,
			parentId: value.parentId,
			...(value.type === "custom" &&
			(value.customType === WORKER_RECEIPTS_CUSTOM_TYPE || value.customType === WORKER_CLAIM_CUSTOM_TYPE)
				? { customType: value.customType, data: value.data }
				: {}),
		});
	}
	return entries;
}

function descendsFrom(entries: ReadonlyMap<string, ParentEntry>, leaf: string | null, ancestor: string): boolean {
	const seen = new Set<string>();
	while (leaf !== null) {
		if (seen.has(leaf)) throw new Error("Worker receipt history contains an ancestry cycle.");
		seen.add(leaf);
		const entry = entries.get(leaf);
		if (!entry) throw new Error("Worker receipt history has missing ancestry.");
		if (leaf === ancestor) return true;
		leaf = entry.parentId;
	}
	return false;
}

function isReview(
	entries: ReadonlyMap<string, ParentEntry>,
	entry: ParentEntry | undefined,
	publication: WorkerReceiptPublication,
): boolean {
	if (
		entry?.customType !== WORKER_CLAIM_CUSTOM_TYPE ||
		!isPlainRecord(entry.data) ||
		entry.data.version !== 1 ||
		!isPlainRecord(entry.data.claim) ||
		typeof entry.data.claim.parentReviewedAt !== "string" ||
		entry.data.claim.terminalAttemptId !== publication.attemptId
	)
		return false;
	const review = decodeWorkerReceiptReview(entry.data.receiptReview);
	return (
		review?.attemptId === publication.attemptId &&
		review.resultId === publication.resultId &&
		review.factsDigest === publication.factsDigest &&
		descendsFrom(entries, entry.id, publication.origin.leafId)
	);
}

function existingPublication(
	entries: ReadonlyMap<string, ParentEntry>,
	candidate: WorkerReceiptCandidate,
): { entry: ParentEntry; publication: WorkerReceiptPublication } | undefined {
	const base = candidate.publication;
	let existing: { entry: ParentEntry; publication: WorkerReceiptPublication } | undefined;
	for (const entry of entries.values()) {
		if (entry.customType !== WORKER_RECEIPTS_CUSTOM_TYPE) continue;
		const decoded = decodeWorkerReceiptPublication(entry.data);
		if (!decoded) {
			if (isPlainRecord(entry.data) && entry.data.version === 2)
				throw new Error("Worker receipt history contains malformed publication evidence.");
			continue;
		}
		if (decoded.receiptId !== base.receiptId) continue;
		if (existing) throw new Error("Worker receipt has duplicate physical publications.");
		existing = { entry, publication: decoded };
	}
	if (existing) {
		const { parentReviewEntryId, ...withoutReview } = existing.publication;
		if (
			!isDeepStrictEqual(withoutReview, base) ||
			!descendsFrom(entries, existing.entry.id, base.origin.leafId) ||
			(candidate.parentReviewRequired
				? !isReview(entries, entries.get(parentReviewEntryId ?? ""), base) ||
					!descendsFrom(entries, existing.entry.id, parentReviewEntryId!)
				: parentReviewEntryId !== undefined)
		)
			throw new Error("Worker receipt publication conflicts with its exact result.");
	}
	return existing;
}

/** One strict index per physical revision, shared by this delivery owner's pending attempts. */
export class WorkerReceiptParentLedger {
	private cached: { file: string; sessionId: string; revision: Stats; entries: Map<string, ParentEntry> } | undefined;

	private read(file: string, sessionId: string): Map<string, ParentEntry> {
		const revision = statSync(file);
		if (
			this.cached?.file === file &&
			this.cached.sessionId === sessionId &&
			sameFileVersion(this.cached.revision, revision)
		)
			return this.cached.entries;
		const entries = readParentEntries(file, sessionId);
		if (!sameFileVersion(revision, statSync(file)))
			throw new Error("Worker receipt history changed during inspection.");
		this.cached = { file, sessionId, revision, entries };
		return entries;
	}

	private entriesFor(session: SessionManager): Map<string, ParentEntry> {
		const file = session.getSessionFile();
		if (file) return this.read(file, session.getSessionId());
		if (session.getEntryCount() > MAX_PARENT_ENTRIES)
			throw new Error("Worker receipt history exceeds its entry bound.");
		return new Map(
			session.getEntries().map((entry) => [
				entry.id,
				{
					id: entry.id,
					parentId: entry.parentId,
					...(entry.type === "custom" ? { customType: entry.customType, data: entry.data } : {}),
				},
			]),
		);
	}

	/** Parent lock is released before the caller acknowledges the orchestration result. */
	publish(
		agentDir: string,
		session: SessionManager,
		candidate: WorkerReceiptCandidate,
		assertCurrent: () => void,
	): WorkerReceiptAcknowledgement | undefined {
		const base = candidate.publication;
		const origin = base.origin;
		if (
			session.getSessionId() !== origin.sessionId ||
			session.getSessionFile() !== origin.sessionFile ||
			!isSessionAppendAnchorCurrent(session, origin)
		)
			return undefined;
		const memoryOnly = !origin.sessionFile;
		if (memoryOnly && session.isPersisted()) return undefined;
		const assertContext = session.captureBranchContext();
		const publish = () => {
			assertCurrent();
			assertContext();
			let entries = this.entriesFor(session);
			if (!descendsFrom(entries, session.getLeafId(), origin.leafId)) return undefined;
			const existing = existingPublication(entries, candidate);
			let publication = base;
			let entryId: string;
			if (existing) {
				publication = existing.publication;
				entryId = existing.entry.id;
			} else {
				if (candidate.parentReviewRequired) {
					const review = [...entries.values()].find(
						(entry) => isReview(entries, entry, base) && descendsFrom(entries, session.getLeafId(), entry.id),
					);
					if (!review) return undefined;
					publication = { ...base, parentReviewEntryId: review.id };
				}
				if (session.isPersistenceStateUncertain()) return undefined;
				assertCurrent();
				assertContext();
				if (!isSessionAppendAnchorCurrent(session, origin)) return undefined;
				// Include the complete enclosing JSONL row in the physical-read limit.
				const maximumRowBytes = Buffer.byteLength(
					JSON.stringify({
						type: "custom",
						id: "x".repeat(MAX_ORCHESTRATION_IDENTIFIER_LENGTH),
						parentId: session.getLeafId(),
						timestamp: new Date().toISOString(),
						customType: WORKER_RECEIPTS_CUSTOM_TYPE,
						data: publication,
					}),
				);
				if (maximumRowBytes > MAX_PERSISTED_CUSTOM_ENTRY_BYTES)
					throw new Error("Worker receipt publication exceeds the physical confirmation bound.");
				if (
					entries.size >= MAX_PARENT_ENTRIES ||
					(origin.sessionFile &&
						(this.cached?.revision.size ?? MAX_PARENT_SCAN_BYTES) + maximumRowBytes + 1 > MAX_PARENT_SCAN_BYTES)
				)
					throw new Error("Worker receipt history has reached its bounded publication capacity.");
				const entryCount = session.getEntryCount();
				const previousBytes = this.cached?.revision.size;
				entryId = session.appendCustomEntry(WORKER_RECEIPTS_CUSTOM_TYPE, publication);
				const appended = session.getEntry(entryId);
				if (
					appended?.type !== "custom" ||
					(!memoryOnly &&
						classifyCustomEntryPersisted(session, entryId, WORKER_RECEIPTS_CUSTOM_TYPE, (data) =>
							isDeepStrictEqual(decodeWorkerReceiptPublication(data), publication),
						) !== "persisted")
				)
					throw new Error("Worker receipt physical append was not confirmed.");
				entries.set(entryId, {
					id: entryId,
					parentId: appended.parentId,
					customType: appended.customType,
					data: appended.data,
				});
				if (origin.sessionFile) {
					const revision = statSync(origin.sessionFile);
					// Keep the index only for our sole observed append. Listener/peer writes force a strict rescan.
					if (
						session.getEntryCount() === entryCount + 1 &&
						previousBytes !== undefined &&
						revision.size === previousBytes + Buffer.byteLength(JSON.stringify(appended)) + 1
					) {
						this.cached = { file: origin.sessionFile, sessionId: origin.sessionId, revision, entries };
					} else this.cached = undefined;
				}
			}
			assertCurrent();
			assertContext();
			if (memoryOnly || !this.cached || (session.getLeafId() && !entries.has(session.getLeafId()!))) {
				entries = this.entriesFor(session);
			}
			const confirmed = existingPublication(entries, candidate);
			if (confirmed?.entry.id !== entryId || !isDeepStrictEqual(confirmed.publication, publication))
				throw new Error("Worker receipt physical publication was not confirmed.");
			// Another process or an uncertain append may own the physical row. Keep it pending until
			// this manager actually sees that branch; never navigate or append a second copy.
			if (!descendsFrom(entries, session.getLeafId(), entryId)) return undefined;
			if (memoryOnly) return undefined;
			return {
				receiptId: publication.receiptId,
				resultId: publication.resultId,
				factsDigest: publication.factsDigest,
				parentEntryId: entryId,
				...(publication.parentReviewEntryId ? { parentReviewEntryId: publication.parentReviewEntryId } : {}),
				...(publication.verifierAttemptId ? { verifierAttemptId: publication.verifierAttemptId } : {}),
			};
		};
		try {
			return origin.sessionFile
				? withSessionFileMutation(agentDir, origin.sessionFile, origin.sessionId, "append", publish)
				: publish();
		} catch (error) {
			this.cached = undefined;
			throw error;
		}
	}
}
