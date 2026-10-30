import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { parseSessionEntries } from "../../kernel/session/session-manager.ts";
import { readBoundedFile, readBoundedFileSync } from "../../kernel/storage/bounded-file.ts";
import { getSessionEntryUsage } from "../../kernel/usage.ts";
import { validateProviderUsage } from "../orchestration/attempt-usage.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isPlainRecord } from "../util/value-guards.ts";

const MAX_FRAGMENT_BYTES = 64 * 1024 * 1024;

export function accountingFragmentPath(path: string): string {
	return `${path}.accounting-fragment.json`;
}

function fragmentEntries(bytes: Buffer): readonly SessionEntry[] {
	const entries = parseSessionEntries(new TextDecoder("utf-8", { fatal: true }).decode(bytes), {
		requireComplete: true,
		allowFragment: true,
	});
	const ids = new Set<string>();
	for (const entry of entries) {
		if (
			entry.type === "session" ||
			typeof entry.id !== "string" ||
			ids.has(entry.id) ||
			!Number.isFinite(Date.parse(entry.timestamp))
		)
			throw new Error("Invalid or duplicate accounting fragment record.");
		ids.add(entry.id);
		const usage = getSessionEntryUsage(entry);
		if (usage) validateProviderUsage(usage);
	}
	return entries as SessionEntry[];
}

function validateFragmentMarker(text: Buffer, bytes: Buffer, path: string): readonly SessionEntry[] {
	const marker: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(text));
	if (
		!isPlainRecord(marker) ||
		marker.version !== 1 ||
		marker.kind !== "fragment" ||
		marker.path !== path ||
		marker.size !== bytes.length ||
		marker.sha256 !== createHash("sha256").update(bytes).digest("hex")
	)
		throw new Error("Accounting fragment source changed.");
	return fragmentEntries(bytes);
}

export async function readAccountingFragment(path: string): Promise<readonly SessionEntry[] | undefined> {
	try {
		const marker = await readBoundedFile(accountingFragmentPath(path), 4096, "Accounting fragment marker");
		const bytes = await readBoundedFile(path, MAX_FRAGMENT_BYTES, "Accounting fragment");
		return validateFragmentMarker(marker, bytes, path);
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
}

export function readAccountingFragmentSync(path: string): readonly SessionEntry[] | undefined {
	try {
		const marker = readBoundedFileSync(accountingFragmentPath(path), 4096, "Accounting fragment marker");
		return validateFragmentMarker(marker, readBoundedFileSync(path, MAX_FRAGMENT_BYTES, "Accounting fragment"), path);
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
}

/** Headerless evidence remains a fragment, never a newly fabricated session or task. */
export async function reconcileAccountingFragment(path: string): Promise<readonly SessionEntry[]> {
	const before = await stat(path, { bigint: true });
	const bytes = await readBoundedFile(path, MAX_FRAGMENT_BYTES, "Accounting fragment");
	const entries = fragmentEntries(bytes);
	const marker = JSON.stringify({
		version: 1,
		kind: "fragment",
		path,
		size: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	});
	writeFileAtomicSync(accountingFragmentPath(path), marker, {
		beforeCommit: () => {
			const after = statSync(path, { bigint: true });
			if (
				before.dev !== after.dev ||
				before.ino !== after.ino ||
				before.size !== after.size ||
				before.mtimeNs !== after.mtimeNs ||
				before.ctimeNs !== after.ctimeNs
			)
				throw new Error("Accounting fragment changed before publication.");
		},
	});
	return entries;
}
