import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { sessionSemanticUsageOf } from "../src/core/cost/semantic-usage-delivery.ts";
import {
	acknowledgeSummarySpend,
	cancelUndispatchedSummarySpend,
	journalSlotOf,
	readJournal,
	readSummarySpendReceipt,
	requestSummarySpendRecovery,
	retainRecordChange,
	updateJournal,
} from "../src/core/cost/semantic-usage-journal.ts";
import { SEMANTIC_USAGE_CUSTOM_TYPE, semanticUsageReportOf } from "../src/core/cost/usage-records.ts";
import type { TypeSafeUsageReceipt } from "../src/core/review/system-one-review-port.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

const scanControl = vi.hoisted(() => ({
	afterScan: undefined as undefined | ((path: string) => Promise<void>),
	afterFailure: undefined as undefined | ((path: string, error: unknown) => void),
}));
vi.mock("../src/kernel/session/session-file-reading.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/kernel/session/session-file-reading.ts")>();
	return {
		...original,
		visitSessionEntriesAsync: async (...args: Parameters<typeof original.visitSessionEntriesAsync>) => {
			try {
				const header = await original.visitSessionEntriesAsync(...args);
				await scanControl.afterScan?.(args[0]);
				return header;
			} catch (error) {
				scanControl.afterFailure?.(args[0], error);
				throw error;
			}
		},
	};
});

function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-summary-recovery-race-"));
	const manager = SessionManager.create(directory, join(directory, "agent"), join(directory, "sessions"));
	manager.appendMessage({ role: "user", content: "Account for a summary.", timestamp: 1 });
	manager.flushBufferedEntries();
	const delivery = sessionSemanticUsageOf(manager, { now: () => 1, setTimeout: () => 1, clearTimeout: () => {} });
	const identity = delivery.summarySpendIdentity();
	const receipt: TypeSafeUsageReceipt = {
		receiptId: `receipt:${randomUUID()}`,
		provider: "fixture",
		model: "summary",
		attempt: 1,
		route: "history_summary",
		origin: { sessionId: identity.sessionId },
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0, total: 0.25 },
		},
		costStatus: "catalog_priced",
		priceKnown: true,
		summaryAccounting: { observedAtMs: 1 },
	};
	manager.appendCustomEntry(SEMANTIC_USAGE_CUSTOM_TYPE, semanticUsageReportOf(receipt));
	manager.flushBufferedEntries();
	delivery.dispose();
	const slot = journalSlotOf(identity)!;
	const createdAt = new Date().toISOString();
	updateJournal(slot, () => ({
		version: 1,
		kind: "semantic-usage-pending",
		sessionId: slot.sessionId,
		sessionFile: slot.sessionFile,
		headerTimestamp: slot.headerTimestamp,
		updatedAt: createdAt,
		records: [],
		conflicts: [],
		droppedConflicts: 0,
		unresolved: [
			{
				requestId: receipt.receiptId,
				provider: receipt.provider,
				model: receipt.model,
				route: "history_summary",
				origin: receipt.origin!,
				startedAt: createdAt,
				summarySpendPending: true,
			},
		],
	}));
	const scanned = Promise.withResolvers<void>();
	const failed = Promise.withResolvers<unknown>();
	const release = Promise.withResolvers<void>();
	scanControl.afterScan = async (path) => {
		if (path !== identity.sessionFile) return;
		scanned.resolve();
		await release.promise;
	};
	scanControl.afterFailure = (path, error) => {
		if (path === identity.sessionFile) failed.resolve(error);
	};
	return { directory, manager, identity, receipt, slot, createdAt, scanned, failed, release };
}

describe("asynchronous canonical summary proof", () => {
	it("rejects a valid but different session header after the strict scan", async () => {
		const h = fixture();
		try {
			const lines = readFileSync(h.identity.sessionFile!, "utf8").split("\n");
			lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), id: randomUUID() });
			writeFileSync(h.identity.sessionFile!, lines.join("\n"));
			const before = readFileSync(h.slot.path, "utf8");
			requestSummarySpendRecovery(h.identity, h.receipt.receiptId);
			await h.scanned.promise;
			h.release.resolve();
			await setImmediate();
			expect(readSummarySpendReceipt(h.identity, h.receipt.receiptId).kind).toBe("unresolved");
			expect(readFileSync(h.slot.path, "utf8")).toBe(before);
		} finally {
			h.release.resolve();
			scanControl.afterScan = undefined;
			scanControl.afterFailure = undefined;
			rmSync(h.directory, { recursive: true, force: true });
		}
	});

	it("rejects conflicting canonical rows for the exact receipt token", async () => {
		const h = fixture();
		try {
			const changed = {
				...h.receipt,
				usage: { ...h.receipt.usage, cost: { ...h.receipt.usage.cost, output: 0.4, total: 0.5 } },
			};
			h.manager.appendCustomEntry(SEMANTIC_USAGE_CUSTOM_TYPE, semanticUsageReportOf(changed));
			h.manager.flushBufferedEntries();
			const before = readFileSync(h.slot.path, "utf8");
			// The strict visitor reaches the conflicting second candidate before it can return its header.
			scanControl.afterScan = undefined;
			requestSummarySpendRecovery(h.identity, h.receipt.receiptId);
			// Wait for the real strict visitor to reject, including its descriptor cleanup.
			expect(await h.failed.promise).toMatchObject({ message: expect.stringMatching(/conflict/) });
			await setImmediate();
			expect(readJournal(h.slot)!.records).toEqual([]);
			expect(readFileSync(h.slot.path, "utf8")).toBe(before);
		} finally {
			scanControl.afterScan = undefined;
			scanControl.afterFailure = undefined;
			rmSync(h.directory, { recursive: true, force: true });
		}
	});

	it.each(["acknowledge", "cancel"] as const)("does not resurrect the receipt after concurrent %s", async (action) => {
		const h = fixture();
		try {
			requestSummarySpendRecovery(h.identity, h.receipt.receiptId);
			await h.scanned.promise;
			if (action === "acknowledge") {
				updateJournal(
					h.slot,
					retainRecordChange(
						h.slot,
						{
							reportId: h.receipt.receiptId,
							payload: h.receipt,
							createdAt: h.createdAt,
							summarySpendPending: true,
							canonicalConfirmed: true,
						},
						{},
					),
				);
				acknowledgeSummarySpend(h.identity, h.receipt.receiptId);
			} else cancelUndispatchedSummarySpend(h.identity, h.receipt.receiptId);
			expect(readSummarySpendReceipt(h.identity, h.receipt.receiptId).kind).toBe("missing");
			h.release.resolve();
			await setImmediate();
			expect(readSummarySpendReceipt(h.identity, h.receipt.receiptId).kind).toBe("missing");
		} finally {
			h.release.resolve();
			scanControl.afterScan = undefined;
			scanControl.afterFailure = undefined;
			rmSync(h.directory, { recursive: true, force: true });
		}
	});
});
