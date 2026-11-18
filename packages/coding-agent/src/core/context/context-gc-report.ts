/** Per-pass context GC records and the indexes used to join them with tool-result policy rows. */
import type { SentPrefixRewriteVerdict } from "../compaction/early-compaction-economics.ts";
import type { SentPrefixRewriteBatch } from "../context-gc.ts";

export interface ContextGcPackedRecord {
	toolName: string;
	toolCallId: string;
	messageIndex: number;
	reason: "superseded-read" | "stale-tool-result" | "stale-semantic-memory" | "superseded-transient-record";
	originalChars: number;
	originalTokens: number;
	packedTokens: number;
	storagePath?: string;
	/** True only when the context original is readable now; a planned path is not availability. */
	retrievalAvailable: boolean;
	path?: string;
	command?: string;
	key?: string;
	/**
	 * The result is an `artifact_retrieve` slice of an original already stored under `key`: the stub
	 * points at that original and nothing new is stored.
	 */
	retrieved?: boolean;
	/** Brain-curator semantic digest of the packed content (model-generated; advisory only). Arrives
	 * already fenced in the untrusted-content boundary (see ContextGcCurationHooks.resolveDigest) —
	 * render verbatim, never re-wrap. */
	digest?: string;
}

export interface ContextGcReport {
	enabled: boolean;
	packedCount: number;
	originalTokens: number;
	packedTokens: number;
	savedTokens: number;
	records: ContextGcPackedRecord[];
	/** The crossing's already-sent batch and the host's verdict on it, when one was offered. */
	sentPrefixRewrite?: SentPrefixRewriteBatch & SentPrefixRewriteVerdict;
}

// A pass owns its report until it returns. Publish the fields used for shadow correlation
// alongside each record so that request planning needs no second walk over retained packs.
const packReasons = new WeakMap<ContextGcReport, Map<string, ContextGcPackedRecord["reason"]>>();

export function recordPack(report: ContextGcReport, record: ContextGcPackedRecord): void {
	report.records.push(record);
	let reasons = packReasons.get(report);
	if (!reasons) {
		reasons = new Map();
		packReasons.set(report, reasons);
	}
	reasons.set(record.toolCallId, record.reason);
}

/** A completed packer report already owns its immutable reason index. External records must be captured. */
export function contextGcPackReasons(
	report: ContextGcReport,
	usePublished: boolean,
): ReadonlyMap<string, ContextGcPackedRecord["reason"]> {
	const published = usePublished ? packReasons.get(report) : undefined;
	if (published) return published;
	const reasons = new Map<string, ContextGcPackedRecord["reason"]>();
	for (const record of report.records) reasons.set(record.toolCallId, record.reason);
	return reasons;
}

// A caller may supply repeated or mismatched GC rows. Match both identities and keep the
// first record, as the original ordered lookup did.
export function packedRecordLookup(records: readonly ContextGcPackedRecord[]) {
	const sourceKey = (index: number, toolCallId: string) => `${index}:${toolCallId}`;
	const indexed = new Map<string, ContextGcPackedRecord>();
	for (const record of records) {
		const key = sourceKey(record.messageIndex, record.toolCallId);
		if (!indexed.has(key)) indexed.set(key, record);
	}
	return (index: number, toolCallId: string) => indexed.get(sourceKey(index, toolCallId));
}
