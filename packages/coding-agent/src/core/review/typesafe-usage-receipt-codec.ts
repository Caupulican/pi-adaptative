import type { Usage } from "@caupulican/pi-ai";
import type { AccountingOrigin } from "../cost/accounting-evidence.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";
import type { TypeSafeUsageReceipt } from "./system-one-review-port.ts";

/** Every identity string in a persisted receipt fits this many characters. */
export const MAX_RECEIPT_TEXT_CHARS = 200;
/** Five receipt/pricing identities, six origin identities and one response timestamp, each possibly JSON-escaped. */
export const MAX_TYPESAFE_USAGE_RECEIPT_BYTES = 12 * MAX_RECEIPT_TEXT_CHARS * 6 + 512;

const RECEIPT_PAYLOAD_KEYS = [
	"receiptId",
	"provider",
	"model",
	"attempt",
	"usage",
	"costStatus",
	"costProvenance",
	"route",
	"origin",
	"responseTimestamp",
] as const;
const RECEIPT_USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"] as const;
const RECEIPT_COST_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total", "estimate"] as const;

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
	const { receiptId, provider, model, attempt, usage, costStatus, costProvenance, route } = value;
	const responseTimestamp = value.responseTimestamp;
	if (
		responseTimestamp !== undefined &&
		(!isReceiptText(responseTimestamp) || !Number.isFinite(Date.parse(responseTimestamp)))
	)
		return undefined;
	const origin = value.origin === undefined ? undefined : parseAccountingOrigin(value.origin);
	if (value.origin !== undefined && !origin) return undefined;
	if (!isReceiptText(receiptId) || !isReceiptCount(attempt)) return undefined;
	if (
		route !== undefined &&
		route !== "system_one_tool" &&
		route !== "history_summary" &&
		route !== "compaction" &&
		route !== "branch_summary"
	)
		return undefined;
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
	// The one estimate a provider reports: a tier priced at base model rates. Any other value is not a receipt.
	const costEstimate = cost.estimate;
	if (costEstimate !== undefined && costEstimate !== "base-rates") return undefined;
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
			...(costEstimate !== undefined ? { estimate: costEstimate } : {}),
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
		...(route !== undefined ? { route } : {}),
		...(origin ? { origin } : {}),
		...(responseTimestamp !== undefined ? { responseTimestamp } : {}),
	};
}

export function parseAccountingOrigin(value: unknown): AccountingOrigin | undefined {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["sessionId", "entryId", "goalId", "taskId", "toolCallId", "operationId"])
	)
		return undefined;
	if (!isReceiptText(value.sessionId)) return undefined;
	for (const key of ["entryId", "goalId", "taskId", "toolCallId", "operationId"] as const) {
		if (value[key] !== undefined && !isReceiptText(value[key])) return undefined;
	}
	return {
		sessionId: value.sessionId,
		...(value.entryId !== undefined ? { entryId: value.entryId as string } : {}),
		...(value.goalId !== undefined ? { goalId: value.goalId as string } : {}),
		...(value.taskId !== undefined ? { taskId: value.taskId as string } : {}),
		...(value.toolCallId !== undefined ? { toolCallId: value.toolCallId as string } : {}),
		...(value.operationId !== undefined ? { operationId: value.operationId as string } : {}),
	};
}
