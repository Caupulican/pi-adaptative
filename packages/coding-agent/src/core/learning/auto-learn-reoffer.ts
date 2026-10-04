/**
 * Durable re-offer of Auto Learn proposals the launching session could not apply.
 *
 * When the session that launched a learner is no longer active at exit, the learner's validated
 * proposal block is kept in its handoff record (`status: parent_session_changed`, attributed to the run
 * id). A later main session offers it again at startup, under exactly the eligibility the original run
 * would have had (`AutoLearnApplyPorts` decides every entry), then finalizes the record: applied or
 * reported, the retained proposals cleared, never offered again.
 *
 * Never applied twice: a record is claimed by an atomic rename before anything is applied, so two
 * sessions cannot both hold it. A claim whose owner died before finalizing is not re-applied (the
 * outcome of a partial apply is unknowable); it is finalized as `apply_failed` with the proposals kept
 * for review and reported.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	AUTO_LEARN_PROPOSAL_TAG,
	type AutoLearnHandoffRecord,
	type AutoLearnProposalSet,
	type AutoLearnReportEntry,
	MAX_AUTO_LEARN_BLOCK_BYTES,
	parseAutoLearnProposals,
} from "./auto-learn-proposals.ts";

export const AUTO_LEARN_REOFFER_CLAIM_SUFFIX = ".reoffer-claimed";
/** A claim older than this has no live owner: its proposals are reported, never applied. */
export const AUTO_LEARN_REOFFER_CLAIM_STALE_MS = 10 * 60 * 1000;
export const MAX_AUTO_LEARN_REOFFER_RECORDS = 32;
/** A handoff record is a few KiB plus at most one proposal block; anything larger is not one of ours. */
const MAX_AUTO_LEARN_REOFFER_FILE_BYTES = MAX_AUTO_LEARN_BLOCK_BYTES + 64 * 1024;

export interface AutoLearnReofferPorts {
	/** Tenant directory holding `<tenant>/handoffs`; only tenants whose name ends with `-<cwdHash>` are offered. */
	tenantsDir: string;
	handoffDirName: string;
	cwdHash: string;
	/** The current (main) session. */
	sessionId: string;
	/** Same eligibility gate as a fresh run (`autoLearn.enabled`); when false, records stay pending. */
	eligible: boolean;
	/** A held record at least this old counts as expiring (the host names its handoff retention minus a margin). */
	expiringAfterMs?: number;
	applyProposals(set: AutoLearnProposalSet, runId: string): Promise<AutoLearnReportEntry[]>;
	/** Persist a final record over `<runId>.json` (same writer the original settle uses). */
	persist(handoffDir: string, record: AutoLearnHandoffRecord): boolean;
	now?: () => number;
}

export interface AutoLearnReofferResult {
	/** Finalized records (applied, reported, failed or interrupted), for the host to announce. */
	finalized: AutoLearnHandoffRecord[];
	/** Eligible-by-shape records left pending because autoLearn is not enabled now. */
	deferred: number;
	/** Of those, records old enough that the handoff retention will soon discard them unapplied. */
	deferredExpiring: number;
}

function readRecord(filePath: string): AutoLearnHandoffRecord | undefined {
	try {
		const stats = fs.lstatSync(filePath);
		if (!stats.isFile() || stats.size > MAX_AUTO_LEARN_REOFFER_FILE_BYTES) return undefined;
		const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const record = parsed as Partial<AutoLearnHandoffRecord>;
		if (record.version !== 1 || typeof record.runId !== "string" || !Array.isArray(record.entries)) return undefined;
		return record as AutoLearnHandoffRecord;
	} catch {
		return undefined;
	}
}

function isPending(record: AutoLearnHandoffRecord): boolean {
	return (
		record.status === "parent_session_changed" &&
		record.verdict === "PASS" &&
		typeof record.unappliedProposals === "string" &&
		record.unappliedProposals.length > 0 &&
		record.reoffered === undefined
	);
}

function listHandoffDirs(ports: AutoLearnReofferPorts): string[] {
	let tenants: string[];
	try {
		tenants = fs.readdirSync(ports.tenantsDir);
	} catch {
		return [];
	}
	return tenants
		.filter((name) => name.endsWith(`-${ports.cwdHash}`))
		.map((name) => path.join(ports.tenantsDir, name, ports.handoffDirName));
}

function listFiles(dir: string, suffix: string): string[] {
	try {
		return fs
			.readdirSync(dir)
			.filter((name) => name.endsWith(suffix))
			.map((name) => path.join(dir, name));
	} catch {
		return [];
	}
}

/** Offer every pending record of this project once; see the module header for the guarantees. */
export async function reofferAutoLearnProposals(ports: AutoLearnReofferPorts): Promise<AutoLearnReofferResult> {
	const now = ports.now ?? Date.now;
	const result: AutoLearnReofferResult = { finalized: [], deferred: 0, deferredExpiring: 0 };
	const handoffDirs = listHandoffDirs(ports);

	// Claims whose owner is gone: report, never re-apply.
	for (const handoffDir of handoffDirs) {
		for (const claimed of listFiles(handoffDir, AUTO_LEARN_REOFFER_CLAIM_SUFFIX)) {
			let age: number;
			try {
				age = now() - fs.lstatSync(claimed).mtimeMs;
			} catch {
				continue;
			}
			if (age <= AUTO_LEARN_REOFFER_CLAIM_STALE_MS) continue;
			const record = readRecord(claimed);
			if (!record) continue;
			record.status = "apply_failed";
			record.detail =
				"a re-offer of the retained proposals was interrupted after they were claimed; they were not re-applied (applying twice is never done). Review unappliedProposals in this record.";
			record.completedAt = new Date(now()).toISOString();
			if (ports.persist(handoffDir, record)) {
				fs.rmSync(claimed, { force: true });
				result.finalized.push(record);
			}
		}
	}

	const candidates: Array<{ handoffDir: string; filePath: string; mtimeMs: number }> = [];
	for (const handoffDir of handoffDirs) {
		for (const filePath of listFiles(handoffDir, ".json")) {
			try {
				candidates.push({ handoffDir, filePath, mtimeMs: fs.lstatSync(filePath).mtimeMs });
			} catch {
				// A record that vanished is another session's finalization.
			}
		}
	}
	candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);

	let offered = 0;
	for (const { handoffDir, filePath, mtimeMs } of candidates) {
		const peek = readRecord(filePath);
		if (!peek || !isPending(peek)) continue;
		if (!ports.eligible) {
			result.deferred++;
			if (ports.expiringAfterMs !== undefined && now() - mtimeMs >= ports.expiringAfterMs) result.deferredExpiring++;
			continue;
		}
		if (offered >= MAX_AUTO_LEARN_REOFFER_RECORDS) {
			result.deferred++;
			continue;
		}
		offered++;
		const claimed = `${filePath}${AUTO_LEARN_REOFFER_CLAIM_SUFFIX}`;
		try {
			fs.renameSync(filePath, claimed);
			// A rename keeps the record's own mtime; staleness must measure the age of the claim.
			const claimedAt = new Date(now());
			fs.utimesSync(claimed, claimedAt, claimedAt);
		} catch {
			continue;
		}
		const record = readRecord(claimed);
		if (!record || !isPending(record)) {
			// Another session finalized it between the peek and the claim; give the final record back.
			try {
				if (!fs.existsSync(filePath)) fs.renameSync(claimed, filePath);
			} catch {
				// Nothing more to restore.
			}
			continue;
		}
		const wasDetail = record.detail;
		const parsed = parseAutoLearnProposals(
			`<${AUTO_LEARN_PROPOSAL_TAG}>${record.unappliedProposals}</${AUTO_LEARN_PROPOSAL_TAG}>`,
		);
		if (!parsed.ok) {
			record.status = "unparseable";
			record.detail = `retained proposals could not be re-read (${parsed.reason}: ${parsed.detail}); not applied`;
		} else if (parsed.set.verdict !== "PASS") {
			record.status = "learner_not_pass";
			record.detail = `retained proposals report ${parsed.set.verdict}; not applied`;
		} else {
			try {
				record.entries = await ports.applyProposals(parsed.set, record.runId);
				record.status = "reported";
				record.detail = `re-offered at the startup of session ${ports.sessionId}${wasDetail ? ` (originally: ${wasDetail})` : ""}`;
				delete record.unappliedProposals;
			} catch (error: unknown) {
				record.status = "apply_failed";
				record.detail = `re-offered proposals failed to apply: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		record.reoffered = { sessionId: ports.sessionId, at: new Date(now()).toISOString() };
		record.completedAt = record.reoffered.at;
		// Finalizing replaces the pending record, then the claim is released; a failed write leaves the claim
		// for the stale-claim report above rather than reopening the record.
		if (ports.persist(handoffDir, record)) fs.rmSync(claimed, { force: true });
		result.finalized.push(record);
	}
	return result;
}
