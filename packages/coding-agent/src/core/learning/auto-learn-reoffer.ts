/** Reoffer retained proposals through the handoff store's single-claim application protocol. */
import { isMissingFileError } from "../util/atomic-file.ts";
import type { AutoLearnHandoffStore, AutoLearnPublication } from "./auto-learn-handoff-store.ts";
import {
	AUTO_LEARN_PROPOSAL_TAG,
	type AutoLearnHandoffRecord,
	type AutoLearnProposalSet,
	type AutoLearnReportEntry,
	parseAutoLearnProposals,
} from "./auto-learn-proposals.ts";

export const MAX_AUTO_LEARN_REOFFER_RECORDS = 32;
const MAX_REOFFER_DIAGNOSTICS = 32;

export interface AutoLearnReofferPorts {
	tenantsDir: string;
	handoffDirName: string;
	cwdHash: string;
	sessionId: string;
	/** Losing the captured session stops admission of further records. */
	isCurrent?(): boolean;
	eligible: boolean;
	retentionWarningAfterMs?: number;
	handoffs: AutoLearnHandoffStore;
	applyProposals(set: AutoLearnProposalSet, runId: string): Promise<AutoLearnReportEntry[]>;
	now?: () => number;
}

export interface AutoLearnReofferResult {
	/** Only exact records acknowledged by the storage owner appear here. */
	finalized: Array<{ directory: string; record: AutoLearnHandoffRecord }>;
	deferred: number;
	deferredNearRetention: number;
	/** Bounded diagnostics for claims/receipts requiring another publication attempt or inspection. */
	unresolved: string[];
}

export async function reofferAutoLearnProposals(ports: AutoLearnReofferPorts): Promise<AutoLearnReofferResult> {
	const now = ports.now ?? Date.now;
	const result: AutoLearnReofferResult = { finalized: [], deferred: 0, deferredNearRetention: 0, unresolved: [] };
	const recordProblem = (reason: string) => {
		if (result.unresolved.length < MAX_REOFFER_DIAGNOSTICS) result.unresolved.push(reason);
	};
	const recordPublication = (directory: string, runId: string, publication: AutoLearnPublication) => {
		if (publication.status === "persisted") {
			result.finalized.push({ directory, record: publication.record });
		} else if (publication.status !== "acknowledged") recordProblem(`${runId}: ${publication.reason}`);
	};
	let selected: Array<{ directory: string; runId: string }>;
	try {
		const batch = ports.handoffs.scanProject(ports.tenantsDir, ports.cwdHash, ports.handoffDirName);
		selected = batch.records;
		for (const issue of batch.issues) recordProblem(issue);
	} catch (error) {
		if (!isMissingFileError(error))
			recordProblem(`Cannot inspect Auto Learn tenants: ${String(error).slice(0, 512)}`);
		return result;
	}
	const candidates: Array<{ handoffDir: string; runId: string; mtimeMs: number }> = [];
	for (const { directory, runId } of selected) {
		try {
			const item = ports.handoffs.inspect(directory, runId);
			if (item.kind === "pending") candidates.push({ handoffDir: directory, runId, mtimeMs: item.mtimeMs });
			else if (item.kind === "recovery" && result.finalized.length < MAX_AUTO_LEARN_REOFFER_RECORDS) {
				const publication = ports.handoffs.recover(directory, runId, ports.sessionId, now());
				const ready = publication.status === "persisted" ? ports.handoffs.inspect(directory, runId) : undefined;
				if (ready?.kind === "pending") candidates.push({ handoffDir: directory, runId, mtimeMs: ready.mtimeMs });
				else recordPublication(directory, runId, publication);
			}
		} catch (error) {
			if (!isMissingFileError(error)) recordProblem(`${runId}: ${String(error).slice(0, 512)}`);
		}
	}
	candidates.sort((a, b) => a.mtimeMs - b.mtimeMs);
	// Pending notices have their own bound; cleanup/delivery retries never consume fresh apply capacity.
	let offered = 0;
	for (const { handoffDir, runId, mtimeMs } of candidates) {
		if (ports.isCurrent?.() === false) break;
		if (!ports.eligible || offered >= MAX_AUTO_LEARN_REOFFER_RECORDS) {
			result.deferred++;
			if (ports.retentionWarningAfterMs !== undefined && now() - mtimeMs >= ports.retentionWarningAfterMs)
				result.deferredNearRetention++;
			continue;
		}
		let owned: ReturnType<AutoLearnHandoffStore["claim"]>;
		try {
			owned = ports.handoffs.claim(handoffDir, runId, ports.sessionId);
		} catch (error) {
			recordProblem(`${runId}: claim not acquired (${String(error).slice(0, 512)})`);
			continue;
		}
		if (!owned) continue;
		offered++;
		const record = owned.record;
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
				record.entries = await ports.applyProposals(parsed.set, runId);
				record.status = "reported";
				record.detail = `re-offered at the startup of session ${ports.sessionId}${wasDetail ? ` (originally: ${wasDetail})` : ""}`;
				delete record.unappliedProposals;
			} catch (error) {
				record.status = "apply_failed";
				record.detail = `re-offered proposals failed to apply: ${String(error).slice(0, 512)}`;
			}
		}
		record.reoffered = { sessionId: ports.sessionId, at: new Date(now()).toISOString() };
		record.completedAt = record.reoffered.at;
		recordPublication(handoffDir, runId, ports.handoffs.complete(owned.claim, record));
	}
	return result;
}
