import { createHash } from "node:crypto";
import { readWireRecord } from "../../kernel/wire-record.ts";
import { type ClaimReceipts, decodeClaimReceipts } from "./claim-receipts.ts";
import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "./contracts.ts";

/** Leaves room for origin and publication identity in a bounded physical parent receipt. */
export const MAX_WORKER_RECEIPT_FACT_BYTES = 8 * 1024;

export type WorkerReceiptFacts =
	| { readonly status: "captured"; readonly facts: ClaimReceipts; readonly factsDigest: string }
	| { readonly status: "unavailable"; readonly reasonCode: "receipt_facts_invalid" | "receipt_facts_too_large" };

export interface WorkerReceiptAcceptance {
	readonly disposition: "accepted" | "parent_review" | "rejected";
	readonly verificationRequired: boolean;
	readonly reasonCode: string;
}

/** Immutable evidence and requirements, separate from later review and publication acknowledgements. */
export type WorkerResultReceipts = { readonly version: 1 } & (
	| (Extract<WorkerReceiptFacts, { status: "captured" }> & { readonly acceptance: WorkerReceiptAcceptance })
	| Extract<WorkerReceiptFacts, { status: "unavailable" }>
);

const RESULT_KEYS = new Set(["version", "status", "facts", "factsDigest", "acceptance", "reasonCode"]);
const ACCEPTANCE_KEYS = new Set(["disposition", "verificationRequired", "reasonCode"]);

/** Freeze mechanical observations before any awaited review can lose or replace their source slice. */
export function captureWorkerReceiptFacts(value: unknown): WorkerReceiptFacts {
	// UTF-8 JSON cannot be smaller than its input string code units. The shared decoder
	// checks this lower bound before copying paths; escaping below remains bounded.
	const facts = decodeClaimReceipts(value, MAX_WORKER_RECEIPT_FACT_BYTES);
	if (!facts) return { status: "unavailable", reasonCode: "receipt_facts_invalid" };
	const encoded = JSON.stringify(facts);
	if (Buffer.byteLength(encoded, "utf8") > MAX_WORKER_RECEIPT_FACT_BYTES)
		return { status: "unavailable", reasonCode: "receipt_facts_too_large" };
	return { status: "captured", facts, factsDigest: createHash("sha256").update(encoded).digest("hex") };
}

/** Strict result decoding preserves absence in legacy results; no transcript-based reconstruction. */
export function decodeWorkerResultReceipts(value: unknown): WorkerResultReceipts | undefined {
	const record = readWireRecord(value, RESULT_KEYS);
	if (record?.version !== 1) return undefined;
	if (record.status === "unavailable") {
		if (record.facts !== undefined || record.factsDigest !== undefined || record.acceptance !== undefined)
			return undefined;
		return record.reasonCode === "receipt_facts_invalid" || record.reasonCode === "receipt_facts_too_large"
			? { version: 1, status: "unavailable", reasonCode: record.reasonCode }
			: undefined;
	}
	if (record.status !== "captured" || record.reasonCode !== undefined) return undefined;
	const captured = captureWorkerReceiptFacts(record.facts);
	const acceptance = readWireRecord(record.acceptance, ACCEPTANCE_KEYS);
	if (
		captured.status !== "captured" ||
		captured.factsDigest !== record.factsDigest ||
		!acceptance ||
		(acceptance.disposition !== "accepted" &&
			acceptance.disposition !== "parent_review" &&
			acceptance.disposition !== "rejected") ||
		typeof acceptance.verificationRequired !== "boolean" ||
		typeof acceptance.reasonCode !== "string" ||
		acceptance.reasonCode.length === 0 ||
		acceptance.reasonCode.length > MAX_ORCHESTRATION_IDENTIFIER_LENGTH ||
		acceptance.reasonCode.includes("\0")
	)
		return undefined;
	return {
		version: 1,
		...captured,
		acceptance: {
			disposition: acceptance.disposition,
			verificationRequired: acceptance.verificationRequired,
			reasonCode: acceptance.reasonCode,
		},
	};
}
