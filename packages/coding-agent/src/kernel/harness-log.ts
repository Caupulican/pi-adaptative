/**
 * The harness's own log: what it decided and why, so the harness can be improved from evidence. One JSON line per entry in
 * `<agentDir>/logs/harness/harness-<date>.jsonl`, each with a level and a category (a subsystem: `delegation`, `link`, `bots`,
 * `tools`, `readiness`, ...).
 *
 * The level decides what is written: `off`, `error`, `warn` (the default), `info`, `debug`, `trace`; `PI_LOG_LEVEL` and the
 * `logging.level` setting say which, `PI_LOG_CATEGORIES` (comma list) narrows it to named subsystems. Below the level a call
 * costs one comparison: fields may be a function, evaluated only when the line is written. Writes are buffered and flushed
 * off the hot path; files rotate at a size and old ones are deleted. A line never carries a secret: the host installs a
 * redactor, and a line is dropped rather than written unredacted once one is installed and throws.
 */

const hasNode = typeof process !== "undefined" && typeof process.getBuiltinModule === "function";

export const LOG_LEVELS = ["off", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface HarnessLogOptions {
	readonly append: (batch: string, bytes: number) => void;
	readonly level?: LogLevel;
	readonly categories?: readonly string[];
	readonly maxFileBytes?: number;
	/** `main`, `worker` ...: which kind of process wrote the line. */
	readonly role?: string;
}

type Fields = Record<string, unknown>;
type FieldsInput = Fields | (() => Fields);

const DEFAULT_LEVEL: LogLevel = "warn";
const FLUSH_AFTER_MS = 250;
const MAX_BATCH_BYTES = 128 * 1024;
const MAX_BUFFERED_ENTRIES = 128;
const MAX_ENTRY_BYTES = 16 * 1024;
const MAX_FIELD_CHARS = 2000;
const oversizedFields = Symbol("oversized log fields");

const rank = (level: LogLevel): number => LOG_LEVELS.indexOf(level);

export function isLogLevel(value: unknown): value is LogLevel {
	return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

class HarnessLog {
	private level: LogLevel = levelFromEnvironment() ?? DEFAULT_LEVEL;
	private categories: ReadonlySet<string> | undefined = categoriesFromEnvironment();
	private append: HarnessLogOptions["append"] | undefined;
	private maxBatchBytes = MAX_BATCH_BYTES;
	private role = "main";
	private redact: ((text: string) => string) | undefined;
	private buffer: string[] = [];
	private bufferBytes = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private exitHooked = false;
	/** Set once the exit flush ran: later lines (other exit hooks) are written straight away, as no timer will fire. */
	private exiting = false;

	/** Installs the host's sink. Environment filtering takes precedence over settings. */
	configure(options: HarnessLogOptions): void {
		if (!hasNode) return;
		this.flush();
		this.append = options.append;
		this.level = levelFromEnvironment() ?? options.level ?? DEFAULT_LEVEL;
		this.categories =
			categoriesFromEnvironment() ?? (options.categories?.length ? new Set(options.categories) : undefined);
		this.maxBatchBytes = Math.min(MAX_BATCH_BYTES, options.maxFileBytes ?? MAX_BATCH_BYTES);
		this.role = options.role ?? "main";
		if (!this.exitHooked) {
			this.exitHooked = true;
			process.once("exit", () => {
				this.flush();
				this.exiting = true;
			});
		}
	}

	/** The host's secret redactor; text passes through it before it is written. */
	setRedactor(redact: (text: string) => string): void {
		this.redact = redact;
	}

	setLevel(level: LogLevel): void {
		this.level = level;
	}

	getLevel(): LogLevel {
		return this.level;
	}

	/** Whether a line of this level (in this category) would be written: guard work that only feeds a log line with it. */
	enabled(level: Exclude<LogLevel, "off">, category?: string): boolean {
		if (!hasNode) return false;
		if (rank(level) > rank(this.level)) return false;
		return category === undefined || this.categories === undefined || this.categories.has(category);
	}

	log(level: Exclude<LogLevel, "off">, category: string, message: string, fields?: FieldsInput): void {
		if (
			!this.append ||
			!this.enabled(level, category) ||
			this.buffer.length >= MAX_BUFFERED_ENTRIES ||
			this.bufferBytes >= this.maxBatchBytes
		)
			return;
		try {
			const entry = {
				ts: new Date().toISOString(),
				level,
				cat: category.length <= MAX_FIELD_CHARS ? category : "oversized-category",
				pid: process.pid,
				role: this.role.length <= MAX_FIELD_CHARS ? this.role : "oversized-role",
				msg: message.length <= MAX_FIELD_CHARS ? message : "Diagnostic message exceeded its size limit",
			};
			const data = typeof fields === "function" ? fields() : fields;
			const limit = Math.min(MAX_ENTRY_BYTES, this.maxBatchBytes);
			let line: string | undefined;
			try {
				let remaining = limit;
				line = JSON.stringify(
					{
						...entry,
						...(data ? { data } : {}),
						...(message.length > MAX_FIELD_CHARS ? { truncated: true } : {}),
					},
					(key, value: unknown) => {
						if (typeof value === "string" && value.length > MAX_FIELD_CHARS) value = "[oversized field]";
						remaining -= 1 + key.length + (typeof value === "string" ? value.length : 0);
						if (remaining < 0) throw oversizedFields;
						return value;
					},
				);
			} catch (error) {
				if (error !== oversizedFields) return;
			}
			if (line !== undefined && this.write(line, limit)) return;
			this.write(JSON.stringify({ ...entry, truncated: true }), limit);
		} catch {
			// A log line that cannot be built or redacted is dropped: logging never throws into the harness.
		}
	}

	error(category: string, message: string, fields?: FieldsInput): void {
		this.log("error", category, message, fields);
	}
	warn(category: string, message: string, fields?: FieldsInput): void {
		this.log("warn", category, message, fields);
	}
	info(category: string, message: string, fields?: FieldsInput): void {
		this.log("info", category, message, fields);
	}
	debug(category: string, message: string, fields?: FieldsInput): void {
		this.log("debug", category, message, fields);
	}
	trace(category: string, message: string, fields?: FieldsInput): void {
		this.log("trace", category, message, fields);
	}

	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.buffer.length === 0) return;
		const text = `${this.buffer.join("\n")}\n`;
		const bytes = this.bufferBytes;
		this.buffer = [];
		this.bufferBytes = 0;
		try {
			this.append?.(text, bytes);
		} catch {
			// The log's own failures are not the harness's.
		}
	}

	private write(line: string, limit: number): boolean {
		const redacted = this.redact ? this.redact(line) : line;
		const bytes = Buffer.byteLength(redacted) + 1;
		if (bytes > limit) return false;
		if (this.bufferBytes + bytes > this.maxBatchBytes) return true;
		this.buffer.push(redacted);
		this.bufferBytes += bytes;
		if (this.exiting) this.flush();
		else if (!this.timer) {
			this.timer = setTimeout(() => this.flush(), FLUSH_AFTER_MS);
			this.timer.unref();
		}
		return true;
	}
}

function levelFromEnvironment(): LogLevel | undefined {
	if (!hasNode) return undefined;
	const value = process.env.PI_LOG_LEVEL?.trim().toLowerCase();
	return isLogLevel(value) ? value : undefined;
}

function categoriesFromEnvironment(): ReadonlySet<string> | undefined {
	if (!hasNode) return undefined;
	const value = process.env.PI_LOG_CATEGORIES?.trim();
	return value
		? new Set(
				value
					.split(",")
					.map((part) => part.trim())
					.filter(Boolean),
			)
		: undefined;
}

/** The one log of this process. */
export const harnessLog = new HarnessLog();
