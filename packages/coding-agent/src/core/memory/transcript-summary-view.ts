/**
 * Read-only access to a project's accepted summary nodes while no summary coordinator runs for it (hierarchy
 * off, no summary model, egress not admitted, or a coordinator that is starting or stopped). Approved nodes
 * that already exist stay discoverable and expandable without building anything new.
 *
 * It never takes the writer lease, never applies recovery, never calls a model or the admission evaluator and
 * never writes the store. It loads the store once into one catalog and loads again only when the manifest
 * revision moved; every read still goes through the catalog's approval, retention and live-dependency checks.
 * Its delivery fence ({@link TranscriptSummaryReadContext.confirm}) is the same load, started after the read's
 * own lineage checks: one manifest read when nothing changed, and one full `store.load()` (every accepted node
 * file read locally) when the revision moved, since retention ages rest on anchors that live outside the
 * manifest. Loads go through {@link TranscriptBoundedRead}: at most one runs per view, with at most one more
 * queued for fences; the running one is shared and runs under no caller's deadline, and its wait for the store
 * lock ends after the lock's default retry window (`DEFAULT_FILE_LOCK_RETRY_WINDOW_MS`) as a typed busy status.
 * Each caller waits only until its own deadline (typed timeout); a file read already started is not cancelled.
 * Store I/O and lock failures arrive typed from the store and are answered as the read's typed status, so a
 * search keeps its exact hits.
 * Damage the coordinator's recovery would repair is never served around: damaged nodes and every ancestor
 * built on them are left out (recovery revokes exactly those), and damaged retention anchors refuse summary
 * reads while retention is on (ages that rest on them cannot be established).
 */

import { DEFAULT_FILE_LOCK_RETRY_WINDOW_MS } from "../util/atomic-file.ts";
import type {
	TranscriptLineageReader,
	TranscriptReadUnavailable,
	TranscriptSourceRef,
} from "./transcript-memory-contracts.ts";
import type {
	TranscriptNodeExpander,
	TranscriptNodeExpansion,
	TranscriptSummaryLookup,
	TranscriptSummaryLookupResult,
	TranscriptSummaryReadOptions,
} from "./transcript-source-tools.ts";
import { TranscriptBoundedRead } from "./transcript-summary-bounded-read.ts";
import { TranscriptSummaryCatalog, type TranscriptSummaryReadContext } from "./transcript-summary-catalog.ts";
import type { TranscriptSummaryNode } from "./transcript-summary-node.ts";
import type { TranscriptSummaryRecoveryIssue, TranscriptSummaryStore } from "./transcript-summary-store.ts";

export interface TranscriptSummaryViewDeps {
	store: TranscriptSummaryStore;
	reader: Pick<TranscriptLineageReader, "listLineageSpans" | "verifyLineageRanges" | "observationCurrent">;
	/** The retention cutoff in force now (from the current history settings); undefined when retention is off. */
	cutoff(): number | undefined;
}

/** The manifest revision of a store that has no manifest yet: nothing was ever accepted. */
const NO_MANIFEST = -1;

/** The store as loaded: its catalog, and the detail of damaged retention anchors when they were damaged. */
interface LoadedSummaries {
	catalog: TranscriptSummaryCatalog;
	anchorsDamaged?: string;
}

/** One load of the store: its summaries, or the typed reason it could not be read. */
type StoreLoad = LoadedSummaries | TranscriptReadUnavailable;

/** Node damage the coordinator's recovery revokes (with every ancestor), as `applyRecovery` classifies it. */
function damagedNodeId(issue: TranscriptSummaryRecoveryIssue): string | undefined {
	return issue.kind === "node_missing" ||
		issue.kind === "node_corrupt" ||
		issue.kind === "node_mismatch" ||
		issue.kind === "child_missing"
		? issue.nodeId
		: undefined;
}

export class TranscriptSummaryView implements TranscriptNodeExpander, TranscriptSummaryLookup {
	private readonly deps: TranscriptSummaryViewDeps;
	private loaded: { ticket: number; revision: number; summaries: LoadedSummaries } | undefined;
	/** Store loads: one running plus one queued for fences, each caller settled by its own deadline. */
	private readonly loads = new TranscriptBoundedRead<LoadedSummaries>((ticket) => this.refresh(ticket));

	constructor(deps: TranscriptSummaryViewDeps) {
		this.deps = deps;
	}

	async expand(handle: string, options: TranscriptSummaryReadOptions = {}): Promise<TranscriptNodeExpansion> {
		const ready = await this.readable(this.loads.join(options.deadlineAt));
		// A store that cannot be read still answers a malformed handle as malformed: the catalog orders the checks.
		const catalog = "status" in ready ? new TranscriptSummaryCatalog() : ready.catalog;
		return catalog.expand(handle, {
			...this.readContext(options),
			...("status" in ready ? { unavailable: ready } : {}),
			unapprovedReason: (node) => unapprovedReason(catalog, node),
		});
	}

	async summariesFor(
		refs: readonly TranscriptSourceRef[],
		limits: { maxNodes: number },
		options: TranscriptSummaryReadOptions = {},
	): Promise<TranscriptSummaryLookupResult> {
		const ready = await this.readable(this.loads.join(options.deadlineAt));
		if ("status" in ready) return ready;
		return ready.catalog.approvedSummariesCovering(refs, limits, this.readContext(options));
	}

	/**
	 * One read's context. The fence asks for a load that starts after the fence itself
	 * ({@link TranscriptBoundedRead.fence}), never one that began before the read's lineage checks, so it sees every
	 * revision written while the read ran.
	 */
	private readContext(options: TranscriptSummaryReadOptions): TranscriptSummaryReadContext {
		return {
			reader: this.deps.reader,
			cutoff: () => this.deps.cutoff(),
			priority: "foreground",
			...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}),
			confirm: () => this.readable(this.loads.fence(options.deadlineAt)),
		};
	}

	/** The catalog to read through, or the typed reason summary reads cannot be served. */
	private async readable(
		loading: Promise<StoreLoad>,
	): Promise<{ catalog: TranscriptSummaryCatalog } | TranscriptReadUnavailable> {
		const current = await loading;
		if ("status" in current) return current;
		if (current.anchorsDamaged !== undefined && this.deps.cutoff() !== undefined) {
			return {
				status: "unavailable",
				reason: `the retention anchors are damaged (${current.anchorsDamaged}), so summary ages cannot be established while retention is on; a running summary hierarchy rebuilds them, and exact history recall is unaffected`,
			};
		}
		return { catalog: current.catalog };
	}

	/**
	 * The catalog for the store as it is now. A reload builds a new catalog, so a read still running on the
	 * previous one keeps a consistent mirror until its delivery fence re-resolves against the current one.
	 */
	private async refresh(ticket: number): Promise<StoreLoad> {
		const read = await this.deps.store.readManifest();
		if (read.status === "unavailable") return { status: "unavailable", reason: read.reason };
		if (read.status === "corrupt") return damaged(read.detail);
		const revision = read.status === "ok" ? read.manifest.revision : NO_MANIFEST;
		if (this.loaded?.revision === revision) return this.loaded.summaries;
		const catalog = new TranscriptSummaryCatalog();
		if (read.status === "missing") return this.remember(ticket, revision, { catalog });
		// The shared load runs under no caller's deadline, but its wait for the store lock is bounded by the lock's own
		// default retry window: a long same-process holder gives a typed "busy" here instead of an endless queue. The
		// file reads after admission are not bounded (and not preemptible).
		const state = await this.deps.store.load({
			lockAdmissionDeadlineAt: Date.now() + DEFAULT_FILE_LOCK_RETRY_WINDOW_MS,
		});
		if ("status" in state) return { status: "unavailable", reason: state.reason };
		const corrupt = state.issues.find((issue) => issue.kind === "manifest_corrupt");
		if (corrupt) return damaged(corrupt.detail);
		// Damaged nodes and every ancestor built on them are left out, as recovery would revoke them.
		const left = new Set(state.issues.map(damagedNodeId).filter((id): id is string => id !== undefined));
		for (let grew = left.size > 0; grew; ) {
			grew = false;
			for (const node of state.nodes.values()) {
				if (!left.has(node.id) && node.children?.some((child) => left.has(child))) {
					left.add(node.id);
					grew = true;
				}
			}
		}
		catalog.replace(
			[...state.nodes.values()].filter((node) => !left.has(node.id)),
			state.retentionAnchors,
		);
		const anchors = state.issues.find((issue) => issue.kind === "anchors_corrupt");
		// The revision the nodes were loaded at, not the one read before: a publication in between reloads next time.
		return this.remember(ticket, state.manifest?.revision ?? NO_MANIFEST, {
			catalog,
			...(anchors ? { anchorsDamaged: anchors.detail } : {}),
		});
	}

	/**
	 * Keep a load as the cached one only when it STARTED after the cached load (a greater ticket). Concurrent
	 * refreshes finish in any order, and a later-finishing load that began earlier read an older manifest, so it
	 * must not replace a newer one. Ordering by start rather than by revision value also adopts a store whose
	 * revision restarted lower after a corrupt-manifest rebuild. The caller answers from what it loaded either way.
	 */
	private remember(ticket: number, revision: number, summaries: LoadedSummaries): LoadedSummaries {
		if (this.loaded === undefined || ticket > this.loaded.ticket) this.loaded = { ticket, revision, summaries };
		return summaries;
	}
}

function damaged(detail: string): TranscriptReadUnavailable {
	return {
		status: "unavailable",
		reason: `the summary store manifest is damaged (${detail}); a running summary hierarchy recovers it, and exact history recall is unaffected`,
	};
}

/** Why a stored node is not approved, as far as a reader that runs no admission can tell. */
function unapprovedReason(catalog: TranscriptSummaryCatalog, node: TranscriptSummaryNode): string {
	const approval = catalog.approval(node);
	switch (approval.approved ? undefined : approval.reason) {
		case "child_not_approved":
			return "a child summary is not approved";
		case "text_changed":
			return "its text no longer matches the admission it carries";
		default:
			return "it has no admission under the current contract, and no summary hierarchy is running to judge it";
	}
}
