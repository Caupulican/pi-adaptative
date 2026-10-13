/**
 * Read-only access to a project's accepted summary nodes while no summary coordinator runs for it (hierarchy
 * off, no summary model, egress not admitted, or a coordinator that is starting or stopped). Approved nodes
 * that already exist stay discoverable and expandable without building anything new.
 *
 * It never takes the writer lease, never applies recovery, never calls a model or the admission evaluator and
 * never writes the store. It loads the store once into one catalog and then follows it: when the store's root moved,
 * it compares the old and new page trees of the accepted-node table (equal pages prune whole subtrees), reads only
 * the node files of the keys that changed, and applies them to the same catalog, without the writer lock and without
 * reading an unchanged table. Anything it cannot follow safely (a legacy or damaged root, pages already cleaned up,
 * a changed forget state, damage in a node file it reads, more changes than a reload would read) takes the full load,
 * which is also how it starts. Node files that did not change are not read again, so damage done to them outside
 * the store's own writes is found at the next full load, as recovery's own start-up check finds it. Every read still goes through the catalog's approval, retention and live-dependency checks.
 * Its delivery fence ({@link TranscriptSummaryReadContext.confirm}) is the same refresh, started after the read's
 * own lineage checks: one root read when nothing changed. Loads go through {@link TranscriptBoundedRead}: at most one runs per view, with at most one more
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
import {
	forgetDenies,
	forgottenNodeIds,
	TranscriptSummaryCatalog,
	type TranscriptSummaryReadContext,
} from "./transcript-summary-catalog.ts";
import type { TranscriptSummaryMetadataRoot } from "./transcript-summary-metadata.ts";
import { type TranscriptSummaryNode, validateParentChildren } from "./transcript-summary-node.ts";
import {
	legacyMarksOf,
	nodeDisagreesWithEntry,
	storeUnavailable,
	type TranscriptSummaryAcceptedNode,
	type TranscriptSummaryRecoveryIssue,
	type TranscriptSummaryStore,
	type TranscriptSummaryTombstone,
} from "./transcript-summary-store.ts";

export interface TranscriptSummaryViewDeps {
	store: TranscriptSummaryStore;
	reader: Pick<TranscriptLineageReader, "listLineageSpans" | "verifyLineageRanges" | "observationCurrent">;
	/** The retention cutoff in force now (from the current history settings); undefined when retention is off. */
	cutoff(): number | undefined;
}

/** The manifest revision of a store that has no manifest yet: nothing was ever accepted. */
const NO_MANIFEST = -1;

/** The cache key of one load: the manifest revision and the permanent forget state's revision. */
function loadKey(manifestRevision: number, forgetRevision: number): string {
	return `${manifestRevision}:${forgetRevision}`;
}

/** What the view needs to follow the store from the state it loaded, instead of loading it again. */
interface FollowCursor {
	/** The root the catalog reflects. */
	root: TranscriptSummaryMetadataRoot;
	/** The permanent forget state's revision the catalog was filtered by. */
	forgetRevision: number;
	/** The legacy `session:` forget markers of the loaded manifest, which the forget state derives part of its answer from. */
	legacy: ReadonlyMap<string, TranscriptSummaryTombstone>;
	/** Accepted nodes the forget state denies: not in the catalog, but a summary built on one is denied through it. */
	denied: Map<string, TranscriptSummaryNode>;
}

/** The store as loaded: its catalog, the detail of damaged retention anchors when they were damaged, and how to follow it. */
interface LoadedSummaries {
	catalog: TranscriptSummaryCatalog;
	anchorsDamaged?: string;
	cursor?: FollowCursor;
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
	private loaded: { ticket: number; revision: string; summaries: LoadedSummaries } | undefined;
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
	 * The catalog for the store as it is now. Following the store mutates the catalog it already holds; a reload builds a
	 * new one, so a read still running on the previous one is judged again against the current one by its delivery fence.
	 */
	private async refresh(ticket: number): Promise<StoreLoad> {
		const held = this.loaded?.summaries;
		const cursor = held?.cursor;
		const followed = await this.deps.store.follow(cursor?.root);
		if (followed.status === "unavailable") return { status: "unavailable", reason: followed.reason };
		if (held && cursor && (followed.status === "unchanged" || followed.status === "changed")) {
			const forget = await this.deps.store.readForgottenSessionsAt(followed.root, cursor.legacy);
			if (forget.status === "unavailable") return { status: "unavailable", reason: forget.reason };
			if (forget.status === "unknown") return forgetUnknown(forget.reason);
			if (forget.revision === cursor.forgetRevision) {
				if (followed.status === "unchanged") return held;
				if (!followed.legacyForgetChanged) {
					try {
						const next = await this.followChanges(
							held,
							cursor,
							followed.root,
							followed.accepted,
							forget.sessions,
						);
						if (next) return this.remember(ticket, loadKey(followed.root.revision, forget.revision), next);
					} catch (error) {
						// An I/O failure while reading changed node files is the store being unavailable, as on any other read.
						const unavailable = storeUnavailable("following the summary store", error);
						if (unavailable) return { status: "unavailable", reason: unavailable.reason };
						throw error;
					}
				}
			}
		}
		return this.reload(ticket);
	}

	/**
	 * Apply the accepted-node changes since the cursor to the held catalog, or undefined when they cannot be followed
	 * safely (the caller reloads). Everything is read and checked before the catalog is touched, and the catalog then
	 * changes in one synchronous step.
	 */
	private async followChanges(
		held: LoadedSummaries,
		cursor: FollowCursor,
		root: TranscriptSummaryMetadataRoot,
		changes: ReadonlyMap<string, TranscriptSummaryAcceptedNode | undefined>,
		forgotten: ReadonlySet<string>,
	): Promise<LoadedSummaries | undefined> {
		const { store } = this.deps;
		const { catalog } = held;
		const fetched = new Map<string, TranscriptSummaryNode>();
		for (const [id, entry] of changes) {
			if (!entry) continue;
			const read = await store.readNode(id);
			if (read.status !== "ok" || nodeDisagreesWithEntry(read.node, entry)) return undefined;
			fetched.set(id, read.node);
		}
		const lookup = (id: string): TranscriptSummaryNode | undefined =>
			fetched.get(id) ?? (changes.has(id) ? undefined : (catalog.get(id) ?? cursor.denied.get(id)));
		const ascending = [...fetched.values()].sort((left, right) => left.level - right.level);
		const denied = new Set<string>();
		for (const node of ascending) {
			if (node.children) {
				const left = lookup(node.children[0]);
				const right = lookup(node.children[1]);
				if (!left || !right || !validateParentChildren(node, left, right).ok) return undefined;
			}
			// A new summary with a parent already in the mirror is a state this cannot have come to by following.
			if (!catalog.has(node.id) && !cursor.denied.has(node.id) && catalog.parentsOf(node.id).size > 0)
				return undefined;
			if (forgetDenies(node, forgotten, lookup)) denied.add(node.id);
		}
		// A summary leaving while one built on it stays is not something the writer does (it revokes ancestors with it).
		for (const [id, entry] of changes) {
			if (
				!entry &&
				[...catalog.parentsOf(id)].some((parent) => changes.get(parent) !== undefined || !changes.has(parent))
			) {
				return undefined;
			}
		}
		const issues: TranscriptSummaryRecoveryIssue[] = [];
		const anchors = await store.readAnchors(issues);
		const nextDenied = new Map(cursor.denied);
		for (const [id, entry] of changes) {
			if (entry) continue;
			catalog.unindex(id);
			nextDenied.delete(id);
		}
		for (const node of ascending) {
			if (denied.has(node.id)) {
				catalog.unindex(node.id);
				nextDenied.set(node.id, node);
			} else {
				nextDenied.delete(node.id);
				catalog.index(node);
			}
		}
		catalog.replaceAnchors(anchors);
		const damaged = issues.find((issue) => issue.kind === "anchors_corrupt");
		return {
			catalog,
			...(damaged ? { anchorsDamaged: damaged.detail } : {}),
			cursor: { root, forgetRevision: cursor.forgetRevision, legacy: cursor.legacy, denied: nextDenied },
		};
	}

	/** Load the whole store into a new catalog: how the view starts, and the way back from anything it cannot follow. */
	private async reload(ticket: number): Promise<StoreLoad> {
		const read = await this.deps.store.readManifest();
		if (read.status === "unavailable") return { status: "unavailable", reason: read.reason };
		if (read.status === "corrupt") return damaged(read.detail);
		// The permanent forget state is part of what a load reflects: a session forgotten since is denied at once, and an
		// unknown state serves no summaries (it never reads as "nothing was forgotten").
		const forget = await this.deps.store.readForgottenSessions();
		if (forget.status === "unknown") return forgetUnknown(forget.reason);
		if (forget.status === "unavailable") return { status: "unavailable", reason: forget.reason };
		const revision = loadKey(read.status === "ok" ? read.manifest.revision : NO_MANIFEST, forget.revision);
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
		// The one permanent-forget rule (shared with the coordinator's catalog): the nodes naming a forgotten session and every
		// summary built on them. The state the load itself read is the one the nodes are filtered by.
		const forgottenNow = state.forgotten.status === "ok" ? state.forgotten : forget;
		const denied = forgottenNodeIds(state.nodes.values(), forgottenNow.sessions);
		catalog.replace(
			[...state.nodes.values()].filter((node) => !left.has(node.id) && !denied.has(node.id)),
			state.retentionAnchors,
		);
		const anchors = state.issues.find((issue) => issue.kind === "anchors_corrupt");
		// The revision the nodes were loaded at, not the one read before: a publication in between reloads next time.
		const loadedAt = loadKey(state.manifest?.revision ?? NO_MANIFEST, forgottenNow.revision);
		// Only an undamaged paged state can be followed; anything else reloads on every change, as it always did.
		const followable = state.root !== undefined && left.size === 0 && state.forgotten.status === "ok";
		return this.remember(ticket, loadedAt, {
			catalog,
			...(anchors ? { anchorsDamaged: anchors.detail } : {}),
			...(followable
				? {
						cursor: {
							root: state.root as TranscriptSummaryMetadataRoot,
							forgetRevision: forgottenNow.revision,
							legacy: legacyMarksOf(state.manifest?.tombstones ?? {}),
							denied: new Map([...state.nodes].filter(([id]) => denied.has(id))),
						},
					}
				: {}),
		});
	}

	/**
	 * Keep a load as the cached one only when it STARTED after the cached load (a greater ticket). Concurrent
	 * refreshes finish in any order, and a later-finishing load that began earlier read an older manifest, so it
	 * must not replace a newer one. Ordering by start rather than by revision value also adopts a store whose
	 * revision restarted lower after a corrupt-manifest rebuild. The caller answers from what it loaded either way.
	 */
	private remember(ticket: number, revision: string, summaries: LoadedSummaries): LoadedSummaries {
		if (this.loaded === undefined || ticket > this.loaded.ticket) this.loaded = { ticket, revision, summaries };
		return summaries;
	}
}

function forgetUnknown(reason: string): TranscriptReadUnavailable {
	return {
		status: "unavailable",
		reason: `the permanent forget state is unknown (${reason}); summaries stay unavailable and exact history recall is unaffected`,
	};
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
