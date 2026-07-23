import type { ClassifiedError } from "@caupulican/pi-agent-core";
import { redactKnownSecrets } from "./security/secret-text.ts";
import { appendBoundedJsonLineSync, type BoundedJsonlLimits } from "./util/bounded-jsonl.ts";

export interface ProviderFailureCorpusRecord {
	ts: string;
	provider?: string;
	modelId?: string;
	reason: ClassifiedError["reason"];
	retryable: boolean;
	message: string;
}

export interface ToolValidationFailureShapeEntry {
	path: string;
	expectedType: string;
	receivedType: string;
	keyword?: string;
}

export interface ToolValidationFailureCorpusRecord {
	kind: "tool_validation";
	ts: string;
	provider?: string;
	modelId?: string;
	tool: string;
	failureModes: string[];
	shape: ToolValidationFailureShapeEntry[];
	errorKeywords: string[];
}

export type FailureCorpusRecord = ProviderFailureCorpusRecord | ToolValidationFailureCorpusRecord;

export interface FailureCorpusStats {
	total: number;
	unknown: number;
}

const MAX_MESSAGE_CHARS = 500;
const MAX_DETAIL_ITEMS = 50;
const MAX_DETAIL_CHARS = 256;
const FAILURE_CORPUS_LIMITS: BoundedJsonlLimits = {
	maxBytes: 512 * 1024,
	targetBytes: Math.floor(512 * 1024 * 0.75),
	maxRecords: 1_000,
};

export function createToolValidationFailureCorpusRecord(args: {
	provider?: string;
	modelId?: string;
	tool: string;
	failureModes: readonly string[];
	shape: readonly ToolValidationFailureShapeEntry[];
	errorKeywords?: readonly string[];
	ts: string;
}): ToolValidationFailureCorpusRecord {
	return {
		kind: "tool_validation",
		ts: args.ts,
		provider: args.provider?.slice(0, MAX_DETAIL_CHARS),
		modelId: args.modelId?.slice(0, MAX_DETAIL_CHARS),
		tool: args.tool.slice(0, MAX_DETAIL_CHARS),
		failureModes: [...new Set(args.failureModes)]
			.sort()
			.slice(0, MAX_DETAIL_ITEMS)
			.map((value) => value.slice(0, MAX_DETAIL_CHARS)),
		shape: sanitizeToolValidationShape(args.shape),
		errorKeywords: [...new Set(args.errorKeywords ?? [])]
			.sort()
			.slice(0, MAX_DETAIL_ITEMS)
			.map((value) => value.slice(0, MAX_DETAIL_CHARS)),
	};
}

export function writeFailureCorpusRecord(filePath: string, record: FailureCorpusRecord): void {
	appendBoundedJsonLineSync(filePath, record, FAILURE_CORPUS_LIMITS);
}

export class FailureCorpusRecorder {
	private total = 0;
	private unknown = 0;
	private readonly filePath: string;
	private readonly now: () => Date;
	private readonly debug: (message: string) => void;

	constructor(args: { filePath: string; now?: () => Date; debug?: (message: string) => void }) {
		this.filePath = args.filePath;
		this.now = args.now ?? (() => new Date());
		this.debug = args.debug ?? (() => {});
	}

	record(args: { provider?: string; modelId?: string; message: string; classified: ClassifiedError }): void {
		this.total += 1;
		if (args.classified.reason === "unknown") this.unknown += 1;
		this.appendRecord({
			ts: this.now().toISOString(),
			provider: args.provider,
			modelId: args.modelId,
			reason: args.classified.reason,
			retryable: args.classified.retryable,
			message: redactSecrets(args.message).slice(0, MAX_MESSAGE_CHARS),
		});
	}

	recordToolValidation(args: {
		provider?: string;
		modelId?: string;
		tool: string;
		failureModes: readonly string[];
		shape: readonly ToolValidationFailureShapeEntry[];
		errorKeywords?: readonly string[];
	}): void {
		this.appendRecord(createToolValidationFailureCorpusRecord({ ...args, ts: this.now().toISOString() }));
	}

	stats(): FailureCorpusStats {
		return { total: this.total, unknown: this.unknown };
	}

	private appendRecord(record: FailureCorpusRecord): void {
		try {
			writeFailureCorpusRecord(this.filePath, record);
		} catch (error) {
			this.debug(`failure corpus write skipped: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

function sanitizeToolValidationShape(
	shape: readonly ToolValidationFailureShapeEntry[],
): ToolValidationFailureShapeEntry[] {
	return shape.slice(0, MAX_DETAIL_ITEMS).map((entry) => ({
		path: entry.path.slice(0, MAX_DETAIL_CHARS),
		expectedType: entry.expectedType.slice(0, MAX_DETAIL_CHARS),
		receivedType: entry.receivedType.slice(0, MAX_DETAIL_CHARS),
		...(entry.keyword ? { keyword: entry.keyword.slice(0, MAX_DETAIL_CHARS) } : {}),
	}));
}

export function redactSecrets(message: string): string {
	return redactKnownSecrets(message).replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[REDACTED]");
}
