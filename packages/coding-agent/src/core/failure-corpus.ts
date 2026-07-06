import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ClassifiedError } from "@caupulican/pi-agent-core";

export interface FailureCorpusRecord {
	ts: string;
	provider?: string;
	modelId?: string;
	reason: ClassifiedError["reason"];
	retryable: boolean;
	message: string;
}

export interface FailureCorpusStats {
	total: number;
	unknown: number;
}

export interface FailureCorpusFs {
	existsSync(path: string): boolean;
	mkdirSync(path: string, options: { recursive: true }): void;
	appendFileSync(path: string, data: string, encoding: "utf-8"): void;
	readFileSync(path: string, encoding: "utf-8"): string;
	writeFileSync(path: string, data: string, encoding: "utf-8"): void;
	statSync(path: string): { size: number };
}

const DEFAULT_FS: FailureCorpusFs = { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync };
const MAX_MESSAGE_CHARS = 500;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_ROTATED_RECORDS = 1000;

export class FailureCorpusRecorder {
	private total = 0;
	private unknown = 0;
	private readonly filePath: string;
	private readonly fs: FailureCorpusFs;
	private readonly now: () => Date;
	private readonly debug: (message: string) => void;

	constructor(args: { filePath: string; fs?: FailureCorpusFs; now?: () => Date; debug?: (message: string) => void }) {
		this.filePath = args.filePath;
		this.fs = args.fs ?? DEFAULT_FS;
		this.now = args.now ?? (() => new Date());
		this.debug = args.debug ?? (() => {});
	}

	record(args: { provider?: string; modelId?: string; message: string; classified: ClassifiedError }): void {
		this.total += 1;
		if (args.classified.reason === "unknown") this.unknown += 1;
		try {
			this.fs.mkdirSync(dirname(this.filePath), { recursive: true });
			const record: FailureCorpusRecord = {
				ts: this.now().toISOString(),
				provider: args.provider,
				modelId: args.modelId,
				reason: args.classified.reason,
				retryable: args.classified.retryable,
				message: redactSecrets(args.message).slice(0, MAX_MESSAGE_CHARS),
			};
			this.fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
			this.rotateIfNeeded();
		} catch (error) {
			this.debug(`failure corpus write skipped: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	stats(): FailureCorpusStats {
		return { total: this.total, unknown: this.unknown };
	}

	private rotateIfNeeded(): void {
		if (!this.fs.existsSync(this.filePath) || this.fs.statSync(this.filePath).size <= MAX_FILE_BYTES) return;
		const lines = this.fs
			.readFileSync(this.filePath, "utf-8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.slice(-MAX_ROTATED_RECORDS);
		this.fs.writeFileSync(this.filePath, `${lines.join("\n")}\n`, "utf-8");
	}
}

export function redactSecrets(message: string): string {
	return message
		.replace(/sk-[A-Za-z0-9]{8,}/g, "[redacted]")
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
		.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "[redacted]");
}
