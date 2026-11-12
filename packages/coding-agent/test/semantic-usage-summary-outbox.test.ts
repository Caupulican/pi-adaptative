import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type SessionSemanticUsageDelivery, sessionSemanticUsageOf } from "../src/core/cost/semantic-usage-delivery.ts";
import {
	acknowledgeSummarySpend,
	cancelUndispatchedSummarySpend,
	type JournalDocument,
	journalSlotOf,
	readJournal,
	readSummarySpendReceipt,
	requestSummarySpendRecovery,
	retainRecordChange,
	updateJournal,
} from "../src/core/cost/semantic-usage-journal.ts";
import type { SemanticUsageLedgerIdentity } from "../src/core/cost/session-ledger-port.ts";
import { SEMANTIC_USAGE_CUSTOM_TYPE, semanticUsageReportOf } from "../src/core/cost/usage-records.ts";
import type { TypeSafeUsageReceipt } from "../src/core/review/system-one-review-port.ts";
import { parseTypeSafeUsageReceipt } from "../src/core/review/typesafe-usage-receipt-codec.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0, total: 0.25 },
};

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-summary-outbox-"));
	const agentDir = join(directory, "agent"),
		sessionDir = join(directory, "sessions");
	const manager = SessionManager.create(directory, agentDir, sessionDir);
	manager.appendMessage({ role: "user", content: "Summarize history.", timestamp: 1 });
	manager.flushBufferedEntries();
	const delivery = sessionSemanticUsageOf(manager, { now: () => 1, setTimeout: () => 1, clearTimeout: () => {} });
	const identity: SemanticUsageLedgerIdentity = delivery.summarySpendIdentity();
	const receipt: TypeSafeUsageReceipt = {
		receiptId: "summary:receipt-1",
		provider: "test-provider",
		model: "test-model",
		attempt: 1,
		route: "history_summary",
		origin: { sessionId: identity.sessionId, operationId: "summary:receipt-1" },
		usage,
		costStatus: "catalog_priced",
		priceKnown: true,
		summaryAccounting: { observedAtMs: 1234 },
	};
	return { directory, manager, delivery, identity, receipt };
}

function seedReceipt(identity: SemanticUsageLedgerIdentity, receipt: TypeSafeUsageReceipt): void {
	const slot = journalSlotOf(identity);
	if (!slot) throw new Error("fixture identity has no journal slot");
	const now = new Date().toISOString();
	updateJournal(slot, (current) => {
		const base: JournalDocument = current ?? {
			version: 1,
			kind: "semantic-usage-pending",
			sessionId: slot.sessionId,
			sessionFile: slot.sessionFile,
			headerTimestamp: slot.headerTimestamp,
			updatedAt: now,
			records: [],
			conflicts: [],
			droppedConflicts: 0,
		};
		return {
			...base,
			records: [
				...base.records,
				{ reportId: receipt.receiptId, payload: receipt, createdAt: now, summarySpendPending: true },
			],
		};
	});
}

function recordReceipt(delivery: SessionSemanticUsageDelivery, receipt: TypeSafeUsageReceipt) {
	const lease = delivery.beginMaintenance("history_summary", 1, receipt.origin);
	try {
		return lease.record(receipt);
	} finally {
		lease.release();
	}
}

describe("semantic summary receipt outbox", () => {
	it("preserves an exact observation time only for history-summary receipts", () => {
		const valid = parseTypeSafeUsageReceipt({ ...fixtureReceipt(), summaryAccounting: { observedAtMs: 0 } });
		expect(valid?.summaryAccounting).toEqual({ observedAtMs: 0 });
		expect(
			parseTypeSafeUsageReceipt({
				...fixtureReceipt(),
				route: "compaction",
				summaryAccounting: { observedAtMs: 1 },
			}),
		).toBeUndefined();
		expect(
			parseTypeSafeUsageReceipt({
				...fixtureReceipt(),
				summaryAccounting: { observedAtMs: Number.MAX_SAFE_INTEGER + 1 },
			}),
		).toBeUndefined();
	});

	it("holds a catalog-labelled receipt when the dispatched price was not proven", () => {
		const state = fixture();
		try {
			const { priceKnown: _priceKnown, ...unproven } = state.receipt;
			seedReceipt(state.identity, unproven);
			expect(readSummarySpendReceipt(state.identity, unproven.receiptId)).toEqual({
				kind: "unknown",
				reason: "summary_price_unavailable",
			});
			expect(() => acknowledgeSummarySpend(state.identity, unproven.receiptId)).toThrow();
			expect(readSummarySpendReceipt(state.identity, unproven.receiptId).kind).toBe("unknown");
		} finally {
			state.delivery.dispose();
			rmSync(state.directory, { recursive: true, force: true });
		}
	});

	it("keeps the receipt until canonical and spend acknowledgments arrive, in either order", () => {
		const first = fixture();
		try {
			seedReceipt(first.identity, first.receipt);
			expect(() => cancelUndispatchedSummarySpend(first.identity, first.receipt.receiptId)).toThrow();
			expect(readSummarySpendReceipt(first.identity, first.receipt.receiptId)).toMatchObject({
				kind: "known",
				costUsd: 0.25,
				observedAtMs: 1234,
				summarySpendPending: true,
			});
			acknowledgeSummarySpend(first.identity, first.receipt.receiptId);
			expect(readSummarySpendReceipt(first.identity, first.receipt.receiptId)).toMatchObject({
				kind: "known",
				summarySpendPending: false,
			});
			expect(recordReceipt(first.delivery, first.receipt).kind).toBe("physically_recorded");
			expect(readSummarySpendReceipt(first.identity, first.receipt.receiptId).kind).toBe("missing");
		} finally {
			first.delivery.dispose();
			rmSync(first.directory, { recursive: true, force: true });
		}

		const second = fixture();
		try {
			expect(recordReceipt(second.delivery, second.receipt).kind).toBe("physically_recorded");
			expect(readSummarySpendReceipt(second.identity, second.receipt.receiptId)).toMatchObject({
				kind: "known",
				summarySpendPending: true,
			});
			acknowledgeSummarySpend(second.identity, second.receipt.receiptId);
			expect(readSummarySpendReceipt(second.identity, second.receipt.receiptId).kind).toBe("missing");
			// A stale duplicate after both proofs cannot recreate the acknowledged outbox record.
			expect(recordReceipt(second.delivery, second.receipt).kind).toBe("physically_recorded");
			expect(readSummarySpendReceipt(second.identity, second.receipt.receiptId).kind).toBe("missing");
		} finally {
			second.delivery.dispose();
			rmSync(second.directory, { recursive: true, force: true });
		}
	});

	it("distinguishes unresolved from missing and leaves malformed evidence untouched", () => {
		const state = fixture();
		try {
			const requestId = "summary:unresolved";
			const slot = journalSlotOf(state.identity)!;
			const now = new Date().toISOString();
			updateJournal(slot, (current) => ({
				...(current ?? {
					version: 1,
					kind: "semantic-usage-pending",
					sessionId: slot.sessionId,
					sessionFile: slot.sessionFile,
					headerTimestamp: slot.headerTimestamp,
					updatedAt: now,
					records: [],
					conflicts: [],
					droppedConflicts: 0,
				}),
				unresolved: [
					{
						requestId,
						provider: "test-provider",
						model: "test-model",
						route: "history_summary",
						origin: { sessionId: state.identity.sessionId, operationId: requestId },
						startedAt: now,
						summarySpendPending: true,
					},
				],
			}));
			expect(readSummarySpendReceipt(state.identity, requestId).kind).toBe("unresolved");
			expect(readSummarySpendReceipt(state.identity, "summary:missing").kind).toBe("missing");
			cancelUndispatchedSummarySpend(state.identity, requestId);
			cancelUndispatchedSummarySpend(state.identity, requestId);
			expect(readSummarySpendReceipt(state.identity, requestId).kind).toBe("missing");
			writeFileSync(slot.path, "{invalid journal", "utf8");
			expect(readSummarySpendReceipt(state.identity, requestId)).toMatchObject({ kind: "unknown" });
			expect(readFileSync(slot.path, "utf8")).toBe("{invalid journal");
		} finally {
			state.delivery.dispose();
			rmSync(state.directory, { recursive: true, force: true });
		}
	});

	it("recovers a pinned canonical summary without reopening its original session", async () => {
		const state = fixture();
		try {
			const slot = journalSlotOf(state.identity)!;
			const now = new Date().toISOString();
			updateJournal(slot, () => ({
				version: 1,
				kind: "semantic-usage-pending",
				sessionId: slot.sessionId,
				sessionFile: slot.sessionFile,
				headerTimestamp: slot.headerTimestamp,
				updatedAt: now,
				records: [],
				conflicts: [],
				droppedConflicts: 0,
				unresolved: [
					{
						requestId: state.receipt.receiptId,
						provider: state.receipt.provider,
						model: state.receipt.model,
						route: "history_summary",
						origin: state.receipt.origin!,
						startedAt: now,
						summarySpendPending: true,
					},
				],
			}));
			state.manager.appendCustomEntry(SEMANTIC_USAGE_CUSTOM_TYPE, semanticUsageReportOf(state.receipt));
			state.manager.flushBufferedEntries();
			state.delivery.dispose();
			requestSummarySpendRecovery(state.identity, state.receipt.receiptId);
			await vi.waitFor(() => {
				expect(readSummarySpendReceipt(state.identity, state.receipt.receiptId)).toMatchObject({
					kind: "known",
					costUsd: 0.25,
					observedAtMs: 1234,
					summarySpendPending: true,
				});
			});
			const recovered = readJournal(slot)!;
			expect(recovered.unresolved).toBeUndefined();
			expect(recovered.records).toMatchObject([
				{ reportId: state.receipt.receiptId, summarySpendPending: true, canonicalConfirmed: true },
			]);
			acknowledgeSummarySpend(state.identity, state.receipt.receiptId);
			expect(readSummarySpendReceipt(state.identity, state.receipt.receiptId).kind).toBe("missing");
		} finally {
			state.delivery.dispose();
			rmSync(state.directory, { recursive: true, force: true });
		}
	});

	it("merges replayed canonical proof without restoring an acknowledged spend", () => {
		const state = fixture();
		try {
			seedReceipt(state.identity, state.receipt);
			acknowledgeSummarySpend(state.identity, state.receipt.receiptId);
			const slot = journalSlotOf(state.identity)!;
			updateJournal(
				slot,
				retainRecordChange(
					slot,
					{
						reportId: state.receipt.receiptId,
						payload: state.receipt,
						createdAt: new Date().toISOString(),
						summarySpendPending: true,
						canonicalConfirmed: true,
					},
					{},
				),
			);
			expect(readSummarySpendReceipt(state.identity, state.receipt.receiptId).kind).toBe("missing");
		} finally {
			state.delivery.dispose();
			rmSync(state.directory, { recursive: true, force: true });
		}
	});
});

function fixtureReceipt() {
	return {
		receiptId: "summary:codec",
		provider: "test-provider",
		model: "test-model",
		attempt: 1,
		route: "history_summary",
		origin: { sessionId: "session-id", operationId: "summary:codec" },
		usage,
		costStatus: "catalog_priced",
	};
}
