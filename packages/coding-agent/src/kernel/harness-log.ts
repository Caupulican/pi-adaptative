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

import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const LOG_LEVELS = ["off", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface HarnessLogOptions {
	readonly dir: string;
	readonly level?: LogLevel;
	readonly categories?: readonly string[];
	readonly maxFileBytes?: number;
	readonly retainDays?: number;
	/** `main`, `worker` ...: which kind of process wrote the line. */
	readonly role?: string;
}

type Fields = Record<string, unknown>;
type FieldsInput = Fields | (() => Fields);

const DEFAULT_LEVEL: LogLevel = "warn";
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RETAIN_DAYS = 14;
const FLUSH_AFTER_LINES = 64;
const FLUSH_AFTER_MS = 250;
const MAX_FIELD_CHARS = 2000;

const rank = (level: LogLevel): number => LOG_LEVELS.indexOf(level);

export function isLogLevel(value: unknown): value is LogLevel {
	return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

class HarnessLog {
	private level: LogLevel = levelFromEnvironment() ?? DEFAULT_LEVEL;
	private categories: ReadonlySet<string> | undefined = categoriesFromEnvironment();
	private dir: string | undefined;
	private maxFileBytes = DEFAULT_MAX_FILE_BYTES;
	private role = "main";
	private redact: ((text: string) => string) | undefined;
	private buffer: string[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private exitHooked = false;
	/** Set once the exit flush ran: later lines (other exit hooks) are written straight away, as no timer will fire. */
	private exiting = false;

	/** Starts writing under `options.dir`; the environment's level and categories win over the settings'. */
	configure(options: HarnessLogOptions): void {
		this.dir = options.dir;
		this.level = levelFromEnvironment() ?? options.level ?? DEFAULT_LEVEL;
		this.categories =
			categoriesFromEnvironment() ?? (options.categories?.length ? new Set(options.categories) : undefined);
		this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
		this.role = options.role ?? "main";
		if (!this.exitHooked) {
			this.exitHooked = true;
			process.once("exit", () => {
				this.flush();
				this.exiting = true;
			});
		}
		this.prune(options.retainDays ?? DEFAULT_RETAIN_DAYS);
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
		if (rank(level) > rank(this.level)) return false;
		return category === undefined || this.categories === undefined || this.categories.has(category);
	}

	log(level: Exclude<LogLevel, "off">, category: string, message: string, fields?: FieldsInput): void {
		if (!this.enabled(level, category)) return;
		try {
			const data = typeof fields === "function" ? fields() : fields;
			const line = JSON.stringify({
				ts: new Date().toISOString(),
				level,
				cat: category,
				pid: process.pid,
				role: this.role,
				msg: message,
				...(data ? { data: this.bound(data) } : {}),
			});
			this.write(this.redact ? this.redact(line) : line);
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
		const dir = this.dir;
		if (!dir || this.buffer.length === 0) {
			this.buffer = [];
			return;
		}
		const text = `${this.buffer.join("\n")}\n`;
		this.buffer = [];
		try {
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `harness-${new Date().toISOString().slice(0, 10)}.jsonl`);
			this.rotate(file);
			appendFileSync(file, text, { mode: 0o600 });
		} catch {
			// The log's own failures are not the harness's.
		}
	}

	/** Strings are cut to a bound so one large value cannot fill a file. */
	private bound(data: Fields): Fields {
		const out: Fields = {};
		for (const [key, value] of Object.entries(data)) {
			out[key] =
				typeof value === "string" && value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}…` : value;
		}
		return out;
	}

	private write(line: string): void {
		if (!this.dir) return;
		this.buffer.push(line);
		if (this.exiting || this.buffer.length >= FLUSH_AFTER_LINES) this.flush();
		else if (!this.timer) {
			this.timer = setTimeout(() => this.flush(), FLUSH_AFTER_MS);
			this.timer.unref();
		}
	}

	private rotate(file: string): void {
		try {
			if (statSync(file).size < this.maxFileBytes) return;
			rmSync(`${file}.1`, { force: true });
			renameSync(file, `${file}.1`);
		} catch {
			// No file yet.
		}
	}

	private prune(retainDays: number): void {
		const dir = this.dir;
		if (!dir) return;
		try {
			const cutoff = Date.now() - retainDays * 86_400_000;
			for (const name of readdirSync(dir)) {
				if (!name.startsWith("harness-")) continue;
				const path = join(dir, name);
				if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
			}
		} catch {
			// Nothing to prune.
		}
	}
}

function levelFromEnvironment(): LogLevel | undefined {
	const value = process.env.PI_LOG_LEVEL?.trim().toLowerCase();
	return isLogLevel(value) ? value : undefined;
}

function categoriesFromEnvironment(): ReadonlySet<string> | undefined {
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
