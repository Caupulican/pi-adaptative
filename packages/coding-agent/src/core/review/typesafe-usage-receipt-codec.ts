import type { Usage } from "@caupulican/pi-ai";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import type { TypeSafeUsageReceipt } from "./system-one-review-port.ts";

/** Every identity string in a persisted receipt fits this many characters. */
export const MAX_RECEIPT_TEXT_CHARS = 200;

const RECEIPT_PAYLOAD_KEYS = [
	"receiptId",
	"provider",
	"model",
	"attempt",
	"usage",
	"costStatus",
	"costProvenance",
] as const;
const RECEIPT_USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const;
const RECEIPT_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;

export function isReceiptCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isReceiptMoney(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function isReceiptText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_RECEIPT_TEXT_CHARS;
}

/**
 * One priced provider response's usage record, as the reviewer produces it and as the usage ledger and the
 * persisted pending journal store it; undefined when malformed. Fails closed: an unknown field, a count that is
 * not a safe integer, or a missing or oversized identity text is not a receipt.
 */
export function parseTypeSafeUsageReceipt(value: unknown): TypeSafeUsageReceipt | undefined {
	if (!isPlainRecord(value) || !hasOnlyKeys(value, RECEIPT_PAYLOAD_KEYS)) return undefined;
	const { receiptId, provider, model, attempt, usage, costStatus, costProvenance } = value;
	if (!isReceiptText(receiptId) || !isReceiptCount(attempt)) return undefined;
	if (!isReceiptText(provider) || !isReceiptText(model)) return undefined;
	if (costStatus !== "catalog_priced" && costStatus !== "unpriced") return undefined;
	let provenance: { provider: string; model: string } | undefined;
	if (costProvenance !== undefined) {
		if (
			!isPlainRecord(costProvenance) ||
			!hasOnlyKeys(costProvenance, ["provider", "model"]) ||
			!isReceiptText(costProvenance.provider) ||
			!isReceiptText(costProvenance.model)
		)
			return undefined;
		provenance = { provider: costProvenance.provider, model: costProvenance.model };
	}
	if (!isPlainRecord(usage) || !hasOnlyKeys(usage, RECEIPT_USAGE_KEYS)) return undefined;
	const { input, output, cacheRead, cacheWrite, totalTokens, cost } = usage;
	if (
		!isReceiptCount(input) ||
		!isReceiptCount(output) ||
		!isReceiptCount(cacheRead) ||
		!isReceiptCount(cacheWrite) ||
		!isReceiptCount(totalTokens)
	)
		return undefined;
	if (!isPlainRecord(cost) || !hasOnlyKeys(cost, RECEIPT_COST_KEYS)) return undefined;
	const costInput = cost.input;
	const costOutput = cost.output;
	const costCacheRead = cost.cacheRead;
	const costCacheWrite = cost.cacheWrite;
	const costTotal = cost.total;
	if (
		!isReceiptMoney(costInput) ||
		!isReceiptMoney(costOutput) ||
		!isReceiptMoney(costCacheRead) ||
		!isReceiptMoney(costCacheWrite) ||
		!isReceiptMoney(costTotal)
	)
		return undefined;
	const priced: Usage = {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens,
		cost: {
			input: costInput,
			output: costOutput,
			cacheRead: costCacheRead,
			cacheWrite: costCacheWrite,
			total: costTotal,
		},
	};
	return {
		receiptId,
		provider,
		model,
		attempt,
		usage: priced,
		costStatus,
		...(provenance ? { costProvenance: provenance } : {}),
	};
}
