/** Reads one verified version of the shared bot store. Observers skip unchanged bytes; locked mutations always read. */
import { type BigIntStats, closeSync, constants, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { isMissingFileError } from "../../kernel/storage/atomic-file.ts";
import { FileSnapshotChangedError, sameFileVersion } from "../../kernel/storage/bounded-file.ts";

export interface BotStoreRead {
	readonly raw?: string;
	readonly version?: BigIntStats;
}

/** A filesystem that supplies no reliable identity still uses content comparison on every observation. */
function cacheable(version: BigIntStats): boolean {
	return version.isFile() && version.dev > 0n && version.ino > 0n && version.mtimeNs > 0n && version.ctimeNs > 0n;
}

function readVersion(file: string, cached?: BigIntStats): BotStoreRead | "unchanged" {
	const options = { bigint: true } as const;
	const observed = statSync(file, options);
	if (cached && sameFileVersion(cached, observed)) return "unchanged";
	if (!observed.isFile()) throw new Error("Bot and team store must be a regular file.");
	const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
	try {
		const before = fstatSync(fd, options);
		if (!before.isFile() || !sameFileVersion(before, observed))
			throw new FileSnapshotChangedError("Bot and team store changed while opening.");
		const bytes = readFileSync(fd);
		if (
			bytes.length !== Number(before.size) ||
			!sameFileVersion(before, fstatSync(fd, options)) ||
			!sameFileVersion(before, statSync(file, options))
		)
			throw new FileSnapshotChangedError("Bot and team store changed while reading.");
		return { raw: bytes.toString("utf8"), ...(cacheable(before) ? { version: before } : {}) };
	} finally {
		closeSync(fd);
	}
}

export function readBotTeamStore(file: string, cached?: BigIntStats): BotStoreRead | "unchanged" {
	try {
		try {
			return readVersion(file, cached);
		} catch (error) {
			if (!(error instanceof FileSnapshotChangedError)) throw error;
			// Another process published while reading. Try the new file once, without accepting the previous version.
			return readVersion(file);
		}
	} catch (error) {
		if (isMissingFileError(error)) return {};
		throw error;
	}
}
