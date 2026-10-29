import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";

const MAX_BYTES = 1024 * 1024;
const MAX_TRANSITIONS = 256;
const transitions: { path: string; before: string; after: string; at: number }[] = [];

/** Exact, bounded regular-file identity. Missing and unreadable are deliberately distinct. */
export function hostFileIdentity(path: string): string | undefined {
	let fd: number | undefined;
	try {
		const stat = lstatSync(path, { bigint: true });
		if (!stat.isFile() || stat.size > BigInt(MAX_BYTES)) return undefined;
		fd = openSync(path, "r");
		const signature = (value: typeof stat): string =>
			`${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
		const identity = signature(stat);
		if (signature(fstatSync(fd, { bigint: true })) !== identity) return undefined;
		const buffer = Buffer.alloc(Number(stat.size));
		let offset = 0;
		while (offset < buffer.length) {
			const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
			if (count === 0) return undefined;
			offset += count;
		}
		if (
			signature(fstatSync(fd, { bigint: true })) !== identity ||
			signature(lstatSync(path, { bigint: true })) !== identity
		)
			return undefined;
		return `file:${identity}:${createHash("sha256").update(buffer).digest("hex")}`;
	} catch (error) {
		return fd === undefined && (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Attribution is observational; a close failure must not fail a settings write.
			}
		}
	}
}

/** Attribution observes an already-authorized write; bookkeeping never changes its outcome. */
export function withHostFileWrite<T>(path: string, expected: string, write: () => T): T {
	const before = hostFileIdentity(path);
	const result = write();
	try {
		const after = hostFileIdentity(path);
		const digest = createHash("sha256").update(expected).digest("hex");
		if (before !== undefined && after?.endsWith(`:${digest}`)) {
			transitions.push({ path: resolve(path), before, after, at: Date.now() });
			if (transitions.length > MAX_TRANSITIONS) transitions.shift();
		}
	} catch {
		// Missing attribution remains visible to the protected-path watch.
	}
	return result;
}

/** Only an uninterrupted chain of exact host writes explains a watched change. */
export function hostExplainsFileChange(path: string, before: string, after: string, from: number, to: number): boolean {
	let current = before;
	const target = resolve(path);
	for (const transition of transitions) {
		if (transition.path !== target || transition.at < from || transition.at > to) continue;
		if (transition.before !== current) return false;
		current = transition.after;
	}
	return current !== before && current === after;
}
