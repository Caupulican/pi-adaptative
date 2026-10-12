/**
 * Where the warnings of a session that closes go when no live session can show them. The default is stderr, one line per warning.
 * A host that owns the terminal holds them until it releases the terminal; a host with an open stream routes them there.
 */

/**
 * Shows each control character (C0, DEL, C1) as a visible `\xNN` escape, so a warning cannot move the cursor, end its line, or inject
 * a terminal sequence. Only terminal output is escaped; the sinks receive the raw text.
 */
export function neutralizeControls(message: string): string {
	let shown = "";
	for (const char of message) {
		const code = char.codePointAt(0) ?? 0;
		const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
		shown += control ? `\\x${code.toString(16).padStart(2, "0")}` : char;
	}
	return shown;
}

const CAUSE_MAX_DEPTH = 4;
const CAUSE_MAX_LISTED = 8;
const CAUSE_MAX_CHARS = 2_000;

/**
 * One line naming a failure and every cause under it: an aggregate error lists its causes recursively (to {@link CAUSE_MAX_DEPTH}
 * levels, {@link CAUSE_MAX_LISTED} per level, {@link CAUSE_MAX_CHARS} in all, with what is cut named by an elision mark and a
 * count). Used where a host reports a shutdown that failed in several steps.
 */
export function describeCause(cause: unknown): string {
	const describe = (value: unknown, depth: number): string => {
		if (!(value instanceof AggregateError)) return value instanceof Error ? value.message : String(value);
		if (depth >= CAUSE_MAX_DEPTH) return `${value.message} (${value.errors.length} more causes)`;
		const listed = value.errors.slice(0, CAUSE_MAX_LISTED).map((inner) => describe(inner, depth + 1));
		const omitted = value.errors.length - listed.length;
		if (omitted > 0) listed.push(`${omitted} more causes`);
		return `${value.message} (${listed.join("; ")})`;
	};
	const text = describe(cause, 0);
	return text.length <= CAUSE_MAX_CHARS ? text : `${text.slice(0, CAUSE_MAX_CHARS - 1)}…`;
}

/** The default route: stderr, one line per warning, control characters escaped (see neutralizeControls). */
export function writeTerminalWarnings(warnings: readonly string[]): void {
	for (const message of warnings) process.stderr.write(`${neutralizeControls(message)}\n`);
}

export class TerminalWarnings {
	private route: ((warnings: readonly string[]) => void) | undefined;
	private held: string[] | undefined;
	private readonly sink: (warnings: readonly string[]) => void;

	/** Where warnings go when no stream is attached: process stderr by default (see writeTerminalWarnings). */
	constructor(sink: (warnings: readonly string[]) => void = writeTerminalWarnings) {
		this.sink = sink;
	}

	write(warnings: readonly string[]): void {
		if (this.held) this.held.push(...warnings);
		else if (this.route) this.route(warnings);
		else this.sink(warnings);
	}

	/** A host that owns the terminal holds the warnings until `release()`. */
	hold(): void {
		this.held ??= [];
	}

	/** A host with an open stream receives the warnings there. Warnings already held are delivered to it now. */
	attach(route: (warnings: readonly string[]) => void): void {
		this.route = route;
		const held = this.held;
		this.held = undefined;
		if (held && held.length > 0) route(held);
	}

	/** The host restored its terminal or closed its stream: held and later warnings go to stderr. */
	release(): void {
		this.route = undefined;
		const held = this.held;
		this.held = undefined;
		if (held && held.length > 0) this.sink(held);
	}
}
