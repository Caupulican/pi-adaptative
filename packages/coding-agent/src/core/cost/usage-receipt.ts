/**
 * A usage receipt: what a process the host cannot meter reported it spent, as a cost and a token total, each absent when that
 * process did not know it (a remote job's executor, `JobOutcome.usage`). It is charged as received: no token split or price is
 * made up for it, so it is its own row beside `spawned_usage`, whose readers need a whole `Usage`. A reader adds its cost and
 * token total and counts each report id once, in the same namespace as the spawned reports.
 */
import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { createEmptyUsage } from "../../kernel/usage.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export const USAGE_RECEIPT_CUSTOM_TYPE = "usage_receipt";

/** What a process reported it spent; a field it did not know is absent, never zero. */
export interface UsageReceipt {
	readonly costUsd?: number;
	readonly totalTokens?: number;
}

export interface UsageReceiptReport extends UsageReceipt {
	/** The charge's identity: a receipt recorded again under the same id is the same charge. */
	readonly reportId: string;
	readonly label: string;
}

function isCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The receipt itself, its fields checked: a cost that is no finite non-negative number, or a token total that is no count, throws. */
export function validUsageReceipt(receipt: UsageReceipt): UsageReceipt {
	if (receipt.costUsd !== undefined && !isCost(receipt.costUsd))
		throw new Error("A usage receipt's cost must be a finite non-negative number.");
	if (receipt.totalTokens !== undefined && !isTokenCount(receipt.totalTokens))
		throw new Error("A usage receipt's token total must be a non-negative safe integer.");
	return {
		...(receipt.costUsd !== undefined ? { costUsd: receipt.costUsd } : {}),
		...(receipt.totalTokens !== undefined ? { totalTokens: receipt.totalTokens } : {}),
	};
}

/** The receipt a session entry records; undefined for any other entry, or a receipt whose fields this build cannot read. */
export function usageReceiptOf(entry: SessionEntry): UsageReceiptReport | undefined {
	if (entry.type !== "custom" || entry.customType !== USAGE_RECEIPT_CUSTOM_TYPE || !isPlainRecord(entry.data))
		return undefined;
	const { reportId, label, costUsd, totalTokens } = entry.data;
	if (typeof reportId !== "string" || reportId.length === 0 || typeof label !== "string") return undefined;
	if ((costUsd !== undefined && !isCost(costUsd)) || (totalTokens !== undefined && !isTokenCount(totalTokens)))
		return undefined;
	return {
		reportId,
		label,
		...(costUsd !== undefined ? { costUsd } : {}),
		...(totalTokens !== undefined ? { totalTokens } : {}),
	};
}

/**
 * The receipt as a share of a cumulative usage: its cost in the total cost and its tokens in the token total. No category
 * holds any of it, since the receipt names none (a cumulative total need not equal the sum of its categories).
 */
export function usageOfReceipt(receipt: UsageReceipt): Usage {
	const usage = createEmptyUsage();
	usage.totalTokens = receipt.totalTokens ?? 0;
	usage.cost.total = receipt.costUsd ?? 0;
	return usage;
}

/**
 * Records `report` in the session once: a report id the session already holds a receipt for (a terminal applied again after a
 * failure) records nothing more.
 */
export function recordUsageReceipt(
	session: Pick<SessionManager, "getEntries" | "appendCustomEntry">,
	report: UsageReceiptReport,
): void {
	if (session.getEntries().some((entry) => usageReceiptOf(entry)?.reportId === report.reportId)) return;
	session.appendCustomEntry(USAGE_RECEIPT_CUSTOM_TYPE, {
		reportId: report.reportId,
		label: report.label,
		...validUsageReceipt(report),
	});
}
