import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Masks the text a tool saves to its full-output file. It is called with blocks of complete lines in output order, so
 * it may keep state from one block to the next (an open key block, a search group).
 */
export type PersistedOutputMask = (lines: string) => string;

interface PersistedOutputScope {
	readonly createMask: () => PersistedOutputMask;
	readonly toolStreamsDirectory?: string;
}

const scopes = new AsyncLocalStorage<PersistedOutputScope>();

/**
 * Runs `run` so that every output file opened inside it (an `OutputAccumulator` constructed in its async scope) is
 * written through a fresh mask from `create`, into `toolStreamsDirectory` when bound. Inside an enclosing scope the
 * enclosing mask is applied after this one, the order in which nested wrappers mask a tool's result.
 */
export function runWithPersistedOutputMask<T>(
	create: () => PersistedOutputMask,
	run: () => T,
	toolStreamsDirectory?: string,
): T {
	const enclosing = scopes.getStore();
	return scopes.run(
		{
			createMask: enclosing
				? () => {
						const inner = create();
						const outer = enclosing.createMask();
						return (lines) => outer(inner(lines));
					}
				: create,
			toolStreamsDirectory: toolStreamsDirectory ?? enclosing?.toolStreamsDirectory,
		},
		run,
	);
}

/** A fresh mask for one output file in the current scope; undefined outside every scope (the file is written as is). */
export function createScopedPersistedOutputMask(): PersistedOutputMask | undefined {
	return scopes.getStore()?.createMask();
}

/** The active session's private tool-streams run directory, when bound in the current tool scope. */
export function getScopedToolStreamsDirectory(): string | undefined {
	return scopes.getStore()?.toolStreamsDirectory;
}

/** A line longer than this is masked in parts rather than held whole. */
const MAX_PENDING_LINE_CHARS = 1024 * 1024;
/** A key block still open after this much text is replaced whole, together with the rest of it. */
const MAX_HELD_BLOCK_CHARS = 1024 * 1024;
const BLOCK_BEGIN_RE = /-----BEGIN [A-Z0-9 ]+-----/u;
const BLOCK_END_RE = /-----END [A-Z0-9 ]+-----/u;
const HELD_BLOCK_REPLACEMENT = "[REDACTED]\n";

/**
 * Feeds decoded output text to a `PersistedOutputMask` in blocks of complete lines and returns what to write. A line
 * is held until its line break arrives (or it outgrows `MAX_PENDING_LINE_CHARS`), and an armored block
 * (`-----BEGIN ...-----` to `-----END ...-----`, such as a private key) until its end line arrives, so a mask that
 * matches the whole block sees it in one call; a block that never ends within `MAX_HELD_BLOCK_CHARS` is replaced by
 * one `[REDACTED]` line, and its remaining lines up to the end line are dropped. `end()` releases what is left.
 */
export class MaskedOutputStream {
	private readonly mask: PersistedOutputMask;
	private pending = "";
	private held = "";
	private dropping = false;

	constructor(mask: PersistedOutputMask) {
		this.mask = mask;
	}

	write(text: string): string {
		this.pending += text;
		const lineEnd = this.pending.lastIndexOf("\n");
		if (lineEnd < 0 && this.pending.length <= MAX_PENDING_LINE_CHARS) return "";
		const complete = lineEnd < 0 ? this.pending : this.pending.slice(0, lineEnd + 1);
		this.pending = this.pending.slice(complete.length);
		return this.release(complete, false);
	}

	end(): string {
		const rest = this.pending;
		this.pending = "";
		return this.release(rest, true);
	}

	private release(text: string, final: boolean): string {
		let written = "";
		let ready = "";
		for (const line of text.split(/(?<=\n)/u)) {
			if (line.length === 0) continue;
			if (this.dropping) {
				if (BLOCK_END_RE.test(line)) this.dropping = false;
				continue;
			}
			if (this.held.length > 0) {
				this.held += line;
				if (BLOCK_END_RE.test(line)) {
					ready += this.held;
					this.held = "";
				} else if (this.held.length > MAX_HELD_BLOCK_CHARS) {
					if (ready.length > 0) written += this.mask(ready);
					ready = "";
					written += HELD_BLOCK_REPLACEMENT;
					this.held = "";
					this.dropping = true;
				}
				continue;
			}
			const begin = BLOCK_BEGIN_RE.exec(line);
			if (begin && !BLOCK_END_RE.test(line.slice(begin.index))) this.held = line;
			else ready += line;
		}
		if (final && this.held.length > 0) {
			ready += this.held;
			this.held = "";
		}
		return ready.length > 0 ? written + this.mask(ready) : written;
	}
}
