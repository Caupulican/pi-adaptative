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

/** The default route: stderr, one line per warning, control characters escaped (see neutralizeControls). */
export function writeTerminalWarnings(warnings: readonly string[]): void {
	for (const message of warnings) process.stderr.write(`${neutralizeControls(message)}\n`);
}

export class TerminalWarnings {
	private route: ((warnings: readonly string[]) => void) | undefined;
	private held: string[] | undefined;

	write(warnings: readonly string[]): void {
		if (this.held) this.held.push(...warnings);
		else if (this.route) this.route(warnings);
		else writeTerminalWarnings(warnings);
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
		if (held && held.length > 0) writeTerminalWarnings(held);
	}
}
