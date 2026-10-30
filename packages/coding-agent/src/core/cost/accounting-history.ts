import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { withSessionBundleAdmission } from "../../kernel/session/session-bundle-lifecycle.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { parseSessionEntries } from "../../kernel/session/session-manager.ts";
import { FileSnapshotChangedError, readBoundedFile, readBoundedFileSync } from "../../kernel/storage/bounded-file.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";
import {
	type AccountingEvidenceGroup,
	type AccountingSourceRevision,
	accountingProjectionPath,
} from "./accounting-evidence.ts";
import { readAccountingFragment, readAccountingFragmentSync } from "./accounting-fragments.ts";
import { type HistoricalAccountingProjection, projectHistoricalAccounting } from "./accounting-projection.ts";
import { decodeAccountingProjection } from "./accounting-projection-codec.ts";
import { readSemanticAccountingEvidence } from "./semantic-accounting-evidence.ts";
import { SEMANTIC_USAGE_CUSTOM_TYPE, type SemanticUsageReport } from "./usage-records.ts";
import { collectWorkerAccountingEvidence } from "./worker-usage-history.ts";

const MAX_ACCOUNTING_BYTES = 32 * 1024 * 1024;
const MAX_ACCOUNTING_SOURCE_BYTES = 512 * 1024 * 1024;

interface VerifiedProjection {
	projection: HistoricalAccountingProjection;
	versions: readonly { path: string; signature: string; allowAbsent?: boolean }[];
	bytes: number;
}
const verifiedProjections = new Map<string, VerifiedProjection>();
let verifiedBytes = 0;
const MAX_VERIFIED_BYTES = 32 * 1024 * 1024;

async function sourceVersion(path: string, allowAbsent = false): Promise<string> {
	try {
		const version = await stat(path, { bigint: true });
		return `${version.dev}:${version.ino}:${version.size}:${version.mtimeNs}:${version.ctimeNs}`;
	} catch (error) {
		if (allowAbsent && isMissingFileError(error)) return "absent-after-reconciliation";
		throw error;
	}
}

async function versionsMatch(versions: VerifiedProjection["versions"]): Promise<boolean> {
	for (const version of versions)
		if ((await sourceVersion(version.path, version.allowAbsent)) !== version.signature) return false;
	return true;
}

function decodeBytes(bytes: Buffer): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function matchesBytes(source: AccountingSourceRevision, bytes: Buffer, appendOnly = false): boolean {
	return (
		(appendOnly ? bytes.length >= source.size : bytes.length === source.size) &&
		createHash("sha256").update(bytes.subarray(0, source.size)).digest("hex") === source.sha256
	);
}

function revisions(projection: HistoricalAccountingProjection): AccountingSourceRevision[] {
	return [
		...new Map(
			projection.groups
				.flatMap((group) => group.evidence)
				.map((source) => [`${source.path}:${source.size}:${source.sha256}`, source]),
		).values(),
	];
}

function annotateEvidence(
	projection: HistoricalAccountingProjection,
	states: ReadonlyMap<string, string>,
): HistoricalAccountingProjection {
	return {
		...projection,
		groups: projection.groups.map((group) => {
			const changed = group.evidence.filter((source) => states.has(source.path));
			const base = group.diagnostic?.split("\nEvidence status:")[0]?.slice(0, 3500) ?? "";
			const absent = changed.filter((source) => states.get(source.path)?.startsWith("absent")).length;
			const status = changed.length
				? `\nEvidence status: ${absent} absent, ${changed.length - absent} changed after reconciliation; retained parent accounting.`
				: "";
			return { ...group, diagnostic: base + status || undefined };
		}),
	};
}

function capturedEntries(
	projection: HistoricalAccountingProjection,
	bytes: Buffer,
	sessionFile: string,
): readonly SessionEntry[] | undefined {
	if (projection.source.path !== sessionFile || !matchesBytes(projection.source, bytes, true)) return undefined;
	const loaded = parseSessionEntries(decodeBytes(bytes), { requireComplete: true });
	if (loaded[0]?.type !== "session" || loaded[0].id !== projection.sessionId)
		throw new Error("Accounting projection belongs to a different session identity.");
	return loaded.filter((entry): entry is SessionEntry => entry.type !== "session");
}

async function loadProjection(sessionFile: string): Promise<
	| {
			projection: HistoricalAccountingProjection;
			entries?: readonly SessionEntry[];
			versions: VerifiedProjection["versions"];
	  }
	| undefined
> {
	try {
		const cached = verifiedProjections.get(sessionFile);
		if (cached && (await versionsMatch(cached.versions))) return cached;
		const markerVersion = await sourceVersion(accountingProjectionPath(sessionFile));
		const serialized = await readBoundedFile(
			accountingProjectionPath(sessionFile),
			MAX_ACCOUNTING_BYTES,
			"Accounting projection",
		);
		let projection = decodeAccountingProjection(JSON.parse(decodeBytes(serialized)));
		const paths = [
			...new Set([
				accountingProjectionPath(sessionFile),
				sessionFile,
				...revisions(projection).map((source) => source.path),
			]),
		];
		const versions = [];
		for (const path of paths) {
			const allowAbsent = path !== sessionFile && path !== accountingProjectionPath(sessionFile);
			versions.push({ path, allowAbsent, signature: await sourceVersion(path, allowAbsent) });
		}
		if (versions[0]?.signature !== markerVersion)
			throw new FileSnapshotChangedError("Accounting projection changed while loading.");
		const raw = await readBoundedFile(sessionFile, MAX_ACCOUNTING_SOURCE_BYTES, "Accounting session source");
		const entries = capturedEntries(projection, raw, sessionFile);
		if (!entries) return undefined;
		const evidenceStates = new Map<string, string>();
		for (const source of revisions(projection)) {
			if (source.path === sessionFile) {
				if (!matchesBytes(source, raw, true)) return undefined;
			} else {
				const evidence = await readBoundedFile(
					source.path,
					MAX_ACCOUNTING_SOURCE_BYTES,
					"Accounting evidence",
				).catch((error: unknown) => {
					if (isMissingFileError(error)) return undefined;
					throw error;
				});
				if (!evidence) evidenceStates.set(source.path, "absent after reconciliation; retained parent accounting");
				else if (!matchesBytes(source, evidence))
					evidenceStates.set(source.path, "changed after reconciliation; retained parent accounting");
			}
		}
		projection = annotateEvidence(projection, evidenceStates);
		if (!(await versionsMatch(versions)))
			throw new FileSnapshotChangedError("Accounting sources changed while loading.");
		if (cached) {
			verifiedProjections.delete(sessionFile);
			verifiedBytes -= cached.bytes;
		}
		const retainedBytes = Buffer.byteLength(JSON.stringify(projection));
		if (retainedBytes <= MAX_VERIFIED_BYTES) {
			while (verifiedBytes + retainedBytes > MAX_VERIFIED_BYTES || verifiedProjections.size >= 256) {
				const oldest = verifiedProjections.keys().next().value;
				if (!oldest) break;
				verifiedBytes -= verifiedProjections.get(oldest)!.bytes;
				verifiedProjections.delete(oldest);
			}
			verifiedProjections.set(sessionFile, { projection, versions, bytes: retainedBytes });
			verifiedBytes += retainedBytes;
		}
		return { projection, entries, versions };
	} catch (error) {
		if (isMissingFileError(error)) return undefined;
		throw error;
	}
}

export async function readAccountingProjection(
	sessionFile: string,
): Promise<HistoricalAccountingProjection | undefined> {
	return (await loadProjection(sessionFile))?.projection;
}

/** Small revision identity; consumers must not retain the bounded owner's projection payload. */
export async function readAccountingRevision(sessionFile: string): Promise<string | undefined> {
	const loaded = await loadProjection(sessionFile);
	return loaded ? createHash("sha256").update(JSON.stringify(loaded.versions)).digest("hex") : undefined;
}

export async function readProjectedSessionEntries(sessionFile: string): Promise<readonly SessionEntry[] | undefined> {
	return (await readAccountedSession(sessionFile))?.entries ?? (await readAccountingFragment(sessionFile));
}

export async function readAccountedSession(
	sessionFile: string,
): Promise<{ projection: HistoricalAccountingProjection; entries: readonly SessionEntry[] } | undefined> {
	const loaded = await loadProjection(sessionFile);
	if (!loaded) return undefined;
	const entries =
		loaded.entries ??
		capturedEntries(
			loaded.projection,
			await readBoundedFile(sessionFile, MAX_ACCOUNTING_SOURCE_BYTES, "Accounting session source"),
			sessionFile,
		);
	if (!entries || !(await versionsMatch(loaded.versions)))
		throw new FileSnapshotChangedError("Accounting source changed before projection.");
	return { projection: loaded.projection, entries: projectHistoricalAccounting(entries, loaded.projection) };
}

/** The synchronous API retains the same captured-byte validation for non-interactive callers. */
export function readProjectedSessionEntriesSync(sessionFile: string): readonly SessionEntry[] | undefined {
	try {
		let projection = decodeAccountingProjection(
			JSON.parse(
				decodeBytes(
					readBoundedFileSync(
						accountingProjectionPath(sessionFile),
						MAX_ACCOUNTING_BYTES,
						"Accounting projection",
					),
				),
			),
		);
		const raw = readBoundedFileSync(sessionFile, MAX_ACCOUNTING_SOURCE_BYTES, "Accounting session source");
		const entries = capturedEntries(projection, raw, sessionFile);
		if (!entries) return undefined;
		const evidenceStates = new Map<string, string>();
		for (const source of revisions(projection)) {
			try {
				const bytes =
					source.path === sessionFile
						? raw
						: readBoundedFileSync(source.path, MAX_ACCOUNTING_SOURCE_BYTES, "Accounting evidence");
				if (!matchesBytes(source, bytes, source.path === sessionFile)) {
					if (source.path === sessionFile) return undefined;
					evidenceStates.set(source.path, "changed after reconciliation; retained parent accounting");
				}
			} catch (error) {
				if (!isMissingFileError(error) || source.path === sessionFile) throw error;
				evidenceStates.set(source.path, "absent after reconciliation; retained parent accounting");
			}
		}
		projection = annotateEvidence(projection, evidenceStates);
		return projectHistoricalAccounting(entries, projection);
	} catch (error) {
		if (isMissingFileError(error)) return readAccountingFragmentSync(sessionFile);
		throw error;
	}
}

/** Reconcile existing evidence only. No transcript writes, runtime creation or execution recovery. */
export async function reconcileSessionAccounting(
	agentDir: string,
	sessionFile: string,
): Promise<HistoricalAccountingProjection> {
	const previous = await readAccountingProjection(sessionFile);
	const before = await stat(sessionFile, { bigint: true });
	const raw = await readBoundedFile(sessionFile, MAX_ACCOUNTING_SOURCE_BYTES, "Accounting session source");
	const loaded = parseSessionEntries(decodeBytes(raw), { requireComplete: true });
	const header = loaded[0];
	if (header?.type !== "session") throw new Error("Historical accounting requires an existing session header.");
	if (previous && (previous.sessionId !== header.id || !matchesBytes(previous.source, raw, true)))
		throw new FileSnapshotChangedError("Parent accounting source changed before reconciliation.");
	const entries = loaded.filter((entry): entry is SessionEntry => entry.type !== "session");
	const reports = entries.flatMap((entry) =>
		entry.type === "custom" && entry.customType === SEMANTIC_USAGE_CUSTOM_TYPE
			? [entry.data as SemanticUsageReport]
			: [],
	);
	let groups: AccountingEvidenceGroup[] = (
		await Promise.all([
			collectWorkerAccountingEvidence(agentDir, header.id, entries),
			readSemanticAccountingEvidence({ agentDir, sessionId: header.id, reports, entries }),
		])
	).flat();
	const publicationSources = revisions({
		version: 1,
		sessionId: header.id,
		source: { path: sessionFile, size: raw.length, sha256: createHash("sha256").update(raw).digest("hex") },
		createdAt: "",
		groups,
	});
	// A missing child file cannot erase facts already conserved against this parent's receipts.
	// Discovery revisions are capture fences; already conserved parent facts remain durable.
	for (const old of previous?.groups ?? []) {
		if (old.directEntries?.length) {
			const directEntries = old.directEntries.filter(
				(entry) => !groups.some((group) => group.directEntries?.some((fresh) => fresh.entryId === entry.entryId)),
			);
			if (directEntries.length) groups.push({ ...old, directEntries });
			continue;
		}
		const replaced = groups.some(
			(group) => (!old.components || group.components) && old.reportIds.every((id) => group.reportIds.includes(id)),
		);
		if (replaced) continue;
		const ids = new Set(old.reportIds);
		groups = groups.flatMap((group) => {
			const remaining = group.reportIds.filter((id) => !ids.has(id));
			if (remaining.length === group.reportIds.length) return [group];
			if (!remaining.length) return [];
			return [
				{
					...group,
					reportIds: remaining,
					components: undefined,
					pendingReports: group.pendingReports?.filter((report) => !ids.has(report.reportId)),
				},
			];
		});
		groups.push(old);
	}
	const projection: HistoricalAccountingProjection = decodeAccountingProjection({
		version: 1,
		sessionId: header.id,
		createdAt: new Date().toISOString(),
		source: { path: sessionFile, size: raw.length, sha256: createHash("sha256").update(raw).digest("hex") },
		groups,
	});
	projectHistoricalAccounting(entries, projection);
	const serialized = JSON.stringify(projection);
	if (Buffer.byteLength(serialized) > MAX_ACCOUNTING_BYTES)
		throw new Error("Accounting projection exceeds its size limit.");
	withSessionBundleAdmission(agentDir, header.id, () => {
		const current = statSync(sessionFile, { bigint: true });
		if (
			current.dev !== before.dev ||
			current.ino !== before.ino ||
			current.size !== before.size ||
			current.mtimeNs !== before.mtimeNs ||
			current.ctimeNs !== before.ctimeNs
		)
			throw new FileSnapshotChangedError("Session changed before historical accounting publication.");
		for (const source of publicationSources) {
			if (
				!matchesBytes(source, readBoundedFileSync(source.path, MAX_ACCOUNTING_SOURCE_BYTES, "Accounting evidence"))
			)
				throw new FileSnapshotChangedError("Accounting evidence changed before publication.");
		}
		writeFileAtomicSync(accountingProjectionPath(sessionFile), serialized);
	});
	return projection;
}
