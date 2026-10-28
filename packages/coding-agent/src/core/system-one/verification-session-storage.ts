import { isDeepStrictEqual } from "node:util";
import type { SessionManager } from "../../kernel/node.ts";
import type { CustomEntry } from "../../kernel/session/session-entries.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	normalizeSnapshot,
	type SemanticVerificationSnapshot,
	VERIFICATION_OBLIGATIONS_CUSTOM_TYPE,
	type VerificationStoragePort,
} from "./verification-obligations.ts";

/** A checkpoint and at most 31 deltas bound cold reconstruction to 32 records. */
const MAX_DELTA_DEPTH = 31;

interface VerificationDelta extends Omit<SemanticVerificationSnapshot, "version"> {
	version: 2;
	baseEntryId: string;
	depth: number;
	/** Exact resulting receipt order. `receipts` contains only new or changed bodies. */
	receiptIds: string[];
}

interface DecodedDelta {
	baseEntryId: string;
	depth: number;
	receiptIds: string[];
	changes: SemanticVerificationSnapshot;
}

interface CachedSnapshot {
	manager: SessionManager;
	entry: CustomEntry;
	snapshot: SemanticVerificationSnapshot;
	depth: number;
}

function invalidDelta(): never {
	throw new Error("Invalid semantic verification delta; refusing to replace durable state.");
}

function decodeDelta(value: unknown): DecodedDelta {
	if (
		!isPlainRecord(value) ||
		value.version !== 2 ||
		typeof value.branchKey !== "string" ||
		typeof value.baseEntryId !== "string" ||
		value.baseEntryId.length === 0 ||
		typeof value.depth !== "number" ||
		!Number.isSafeInteger(value.depth) ||
		value.depth < 1 ||
		value.depth > MAX_DELTA_DEPTH ||
		!Array.isArray(value.receiptIds) ||
		!value.receiptIds.every((id) => typeof id === "string") ||
		new Set(value.receiptIds).size !== value.receiptIds.length
	) {
		return invalidDelta();
	}
	const receiptIds = value.receiptIds;
	// The existing owner validates every field and every changed receipt, including its bounds.
	const changes = normalizeSnapshot({ ...value, version: 1 }, value.branchKey);
	if (changes.receipts.some((receipt) => !receiptIds.includes(receipt.id))) return invalidDelta();
	return {
		baseEntryId: value.baseEntryId,
		depth: value.depth,
		receiptIds,
		changes,
	};
}

/**
 * Session-journal adapter. Full v1 checkpoints remain readable; v2 deltas avoid copying the retained
 * receipt bodies after every tool call. The tracker still reads and writes complete validated snapshots.
 * Old readers reject version 2 rather than silently dropping an active verification obligation.
 */
export function createSessionVerificationStorage(getManager: () => SessionManager): VerificationStoragePort {
	let cached: CachedSnapshot | undefined;
	const readLatest = (manager: SessionManager): CachedSnapshot | undefined => {
		const entry = manager.getLatestCustomEntryOnBranch(VERIFICATION_OBLIGATIONS_CUSTOM_TYPE);
		if (entry === undefined) {
			cached = undefined;
			return undefined;
		}
		// Reload and branch replacement can preserve IDs while replacing their entry objects.
		if (cached?.manager === manager && cached.entry === entry) return cached;
		const deltas: DecodedDelta[] = [];
		let checkpoint = entry;
		while (isPlainRecord(checkpoint.data) && checkpoint.data.version === 2) {
			if (deltas.length >= MAX_DELTA_DEPTH) return invalidDelta();
			const delta = decodeDelta(checkpoint.data);
			// Undefined would restart lookup at the current leaf, so a null parent is explicitly invalid.
			if (checkpoint.parentId === null) return invalidDelta();
			const previous = manager.getLatestCustomEntryOnBranch(
				VERIFICATION_OBLIGATIONS_CUSTOM_TYPE,
				checkpoint.parentId,
			);
			if (previous === undefined || previous.id !== delta.baseEntryId) return invalidDelta();
			deltas.push(delta);
			checkpoint = previous;
		}
		if (!isPlainRecord(checkpoint.data) || typeof checkpoint.data.branchKey !== "string") {
			return invalidDelta();
		}
		let snapshot = normalizeSnapshot(checkpoint.data, checkpoint.data.branchKey);
		let depth = 0;
		for (const delta of deltas.reverse()) {
			const changes = delta.changes;
			if (
				changes.branchKey !== snapshot.branchKey ||
				changes.sequence !== snapshot.sequence + 1 ||
				changes.evidenceRevision < snapshot.evidenceRevision ||
				changes.evidenceRevision > snapshot.evidenceRevision + 1 ||
				delta.depth !== depth + 1
			) {
				return invalidDelta();
			}
			const receipts = new Map(snapshot.receipts.map((receipt) => [receipt.id, receipt]));
			for (const receipt of changes.receipts) receipts.set(receipt.id, receipt);
			const ordered = delta.receiptIds.map((id) => {
				const receipt = receipts.get(id);
				if (receipt === undefined) return invalidDelta();
				return receipt;
			});
			snapshot = normalizeSnapshot({ ...changes, receipts: ordered }, changes.branchKey);
			depth = delta.depth;
		}
		cached = { manager, entry, snapshot, depth };
		return cached;
	};
	return {
		getBranchKey: () => getManager().getSessionId(),
		getInheritedBranchKeys: () => getManager().getSessionLineageIds().slice(1),
		getReceiverId: () => getManager().getSessionId(),
		readRecords: (branch) => {
			const manager = getManager();
			if (manager.getSessionId() !== branch) throw new Error("Verification session changed");
			return readLatest(manager)?.snapshot;
		},
		appendRecord: (branch, record) => {
			const manager = getManager();
			if (manager.getSessionId() !== branch) throw new Error("Verification session changed");
			const snapshot = normalizeSnapshot(record, branch);
			const previous = readLatest(manager);
			if (previous && snapshot.sequence !== previous.snapshot.sequence + 1) return invalidDelta();
			let data: SemanticVerificationSnapshot | VerificationDelta = snapshot;
			let depth = 0;
			if (previous && previous.snapshot.branchKey === branch && previous.depth < MAX_DELTA_DEPTH) {
				const receipts = new Map(previous.snapshot.receipts.map((receipt) => [receipt.id, receipt]));
				depth = previous.depth + 1;
				data = {
					...snapshot,
					version: 2,
					baseEntryId: previous.entry.id,
					depth,
					receiptIds: snapshot.receipts.map((receipt) => receipt.id),
					receipts: snapshot.receipts.filter((receipt) => !isDeepStrictEqual(receipts.get(receipt.id), receipt)),
				};
			}
			const id = manager.appendCustomEntry(VERIFICATION_OBLIGATIONS_CUSTOM_TYPE, data);
			const entry = manager.getEntry(id);
			cached =
				getManager() === manager && manager.getSessionId() === branch && entry?.type === "custom"
					? { manager, entry, snapshot, depth }
					: undefined;
		},
	};
}
