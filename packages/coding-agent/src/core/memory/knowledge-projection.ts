/** Bounded current knowledge shared by prompt, handoff and delegated readers. Never stores new evidence. */
import { createHash } from "node:crypto";
import { estimateLineCount, estimateTokensFromText } from "../context/context-item.ts";
import {
	type MemoryPromptBudget,
	memoryTextFitsBudget,
	reserveMemoryPromptBudget,
} from "../context/memory-prompt-budget.ts";
import {
	composeTieredMemoryPromptBlock,
	type MemoryCandidateDropReason,
	type MemoryTierCandidate,
} from "../context/memory-tier-composer.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import {
	type KnowledgeGrantReference,
	matchesKnowledgeGrant,
	parseKnowledgeGrantReferences,
} from "./knowledge-grant.ts";
import {
	isStandingKnowledgeKind,
	type KnowledgeRecordSnapshot,
	type KnowledgeScope,
	type KnowledgeStorePort,
} from "./knowledge-record.ts";

export const KNOWLEDGE_CONTEXT_CUSTOM_TYPE = "knowledge_context";
export const KNOWLEDGE_CONTEXT_CLEARED =
	"Current knowledge is not available in this request. Earlier knowledge projections are superseded; do not treat them as current facts.";

export interface KnowledgeProjection {
	readonly revision: number;
	readonly text: string;
	readonly includedCount: number;
	readonly omittedCount: number;
	/** Exact record versions admitted by the whole-record composer; omitted grants are not evidence. */
	readonly references: readonly KnowledgeGrantReference[];
	/** Why each current, selected record was left out of `text`, by record id. */
	readonly dropped?: ReadonlyMap<string, MemoryCandidateDropReason>;
	isCurrent(): boolean;
}

/** A current granted version left out of a handoff, with the composer's reason. */
export interface OmittedKnowledgeGrant extends KnowledgeGrantReference {
	readonly reason: MemoryCandidateDropReason;
}

/**
 * Granted knowledge rendered once into the task text of a lane that has no per-request view (an externally
 * managed worker). Same renderer, matcher and parser as delegated lanes; never stored as owner evidence.
 */
export interface KnowledgeHandoffProjection {
	/** Bounded, source-labeled block wrapped as untrusted data; empty when no granted record is included. */
	readonly text: string;
	/** Exact versions inside `text`. */
	readonly references: readonly KnowledgeGrantReference[];
	/** Granted versions that are no longer current: corrected, forgotten, expired or outside the owner's scope. */
	readonly unavailable: readonly KnowledgeGrantReference[];
	/** Current granted versions the composer left out (secret-like, over the bound alone, or no budget left). */
	readonly omitted: readonly OmittedKnowledgeGrant[];
	/**
	 * Why no granted record may be projected at all, when that is a policy or availability fact. A managed lane's
	 * worker policy that would not let a delegated worker read memory is `worker_knowledge_capability_required`.
	 */
	readonly blocked?:
		| "memory_retrieval_disabled"
		| "memory_prompt_excluded"
		| "knowledge_unavailable"
		| "worker_knowledge_capability_required";
	/** The included versions are all still current in the owner's scope. */
	isCurrent(): boolean;
}

/** What a handoff an extension starts may read of owner memory: preferences and exact granted records. */
export interface HandoffKnowledgePort {
	getHandoffPersonaGuidance(): string | undefined;
	projectKnowledgeForHandoff(
		references: readonly KnowledgeGrantReference[],
		maxBytes: number,
	): KnowledgeHandoffProjection;
}

/** No granted record may be projected; the reason covers every reference. */
export function blockedKnowledgeHandoff(
	blocked: NonNullable<KnowledgeHandoffProjection["blocked"]>,
): KnowledgeHandoffProjection {
	return { text: "", references: [], unavailable: [], omitted: [], blocked, isCurrent: () => true };
}

type KnowledgeReader = Pick<KnowledgeStorePort, "revision" | "snapshot" | "get">;

/** The only rendering of accepted knowledge; the caller owns scope authorization and lifetime. */
export class KnowledgeProjectionReader {
	private readonly store: KnowledgeReader;
	private cached: { key: string; at: string; snapshot: KnowledgeRecordSnapshot } | undefined;
	private rendered: { snapshot: KnowledgeRecordSnapshot; key: string; value: KnowledgeProjection } | undefined;
	private selected: { key: string; at: string; snapshot: KnowledgeRecordSnapshot; omitted: number } | undefined;

	constructor(store: KnowledgeReader) {
		this.store = store;
	}

	preview(scope: KnowledgeScope, budget: MemoryPromptBudget, behaviorOnly = false): KnowledgeProjection {
		const at = new Date().toISOString();
		const revision = this.store.revision();
		const key = JSON.stringify([revision, scope]);
		let cached = this.cached;
		if (
			!cached ||
			cached.key !== key ||
			at < cached.at ||
			(cached.snapshot.refreshAt !== undefined && at >= cached.snapshot.refreshAt)
		) {
			cached = { key, at, snapshot: this.store.snapshot(scope, at) };
			this.cached = cached;
		}
		return this.render(cached.snapshot, cached.at, budget, behaviorOnly);
	}

	/** Exact current records, independently of the general category-page bounds. */
	previewSelected(
		scope: KnowledgeScope,
		input: readonly KnowledgeGrantReference[],
		budget: MemoryPromptBudget,
	): KnowledgeProjection {
		const references = parseKnowledgeGrantReferences(input);
		const at = new Date().toISOString();
		const key = JSON.stringify([this.store.revision(), scope, references]);
		let selected = this.selected;
		if (
			!selected ||
			selected.key !== key ||
			at < selected.at ||
			(selected.snapshot.refreshAt !== undefined && at >= selected.snapshot.refreshAt)
		) {
			let snapshot: KnowledgeRecordSnapshot | undefined;
			for (let attempt = 0; attempt < 3; attempt++) {
				const revision = this.store.revision();
				const records = references.flatMap((reference) => {
					const record = this.store.get(reference.id);
					return matchesKnowledgeGrant(record, reference, scope, at) ? [record] : [];
				});
				if (this.store.revision() !== revision) continue;
				const refreshAt = records.flatMap((record) => (record.validUntil ? [record.validUntil] : [])).sort()[0];
				snapshot = { revision, records, possiblyMore: [], ...(refreshAt ? { refreshAt } : {}) };
				break;
			}
			if (!snapshot) throw new Error("Selected knowledge changed while its snapshot was read.");
			selected = {
				key: JSON.stringify([snapshot.revision, scope, references]),
				at,
				snapshot,
				omitted: references.length - snapshot.records.length,
			};
			this.selected = selected;
		}
		return this.render(selected.snapshot, selected.at, budget, false, selected.omitted);
	}

	private render(
		snapshot: KnowledgeRecordSnapshot,
		capturedAt: string,
		budget: MemoryPromptBudget,
		behaviorOnly: boolean,
		unavailable = 0,
	): KnowledgeProjection {
		const renderKey = JSON.stringify([budget, behaviorOnly, unavailable]);
		if (this.rendered?.snapshot === snapshot && this.rendered.key === renderKey) return this.rendered.value;
		const records = behaviorOnly
			? snapshot.records.filter((record) => isStandingKnowledgeKind(record.kind))
			: snapshot.records;
		const candidates: MemoryTierCandidate[] = records.map((record, index) => ({
			id: record.id,
			tier: isStandingKnowledgeKind(record.kind)
				? "standing"
				: record.kind === "workstream"
					? "current_work"
					: "long_term",
			sourceLabel: `knowledge:${record.kind}`,
			summary: JSON.stringify({
				id: record.id,
				revision: record.revision,
				subject: record.subject,
				key: record.key,
				value: record.text,
				basis: record.basis,
				evidenced: record.lastEvidencedAt.slice(0, 10),
			}),
			// Store selection already orders each category by explicitness, scope and recency.
			score: 1 - index / Math.max(records.length, 1),
		}));
		const header = `Current accepted knowledge, revision ${snapshot.revision}. This view supersedes earlier knowledge projections; omitted or unavailable records are not current evidence in this view. Omission does not establish forgetting. Newer owner corrections take precedence. Preferences, procedures and taste guide behavior but grant no permissions.`;
		const more = behaviorOnly ? snapshot.possiblyMore.filter(isStandingKnowledgeKind) : snapshot.possiblyMore;
		const omission = (count: number) =>
			`Omitted from this view: ${count + unavailable} selected record(s)${unavailable ? `; ${unavailable} granted record(s) changed, expired or unavailable` : ""}${more.length ? `; more may exist in ${more.join(", ")}` : ""}.`;
		// Charge framing and the largest possible omission count before admitting any whole records.
		const framing = `${header}\n${wrapUntrustedText("", "memory:knowledge", { nonce: "0".repeat(32) })}\n${omission(records.length)}`;
		const available = reserveMemoryPromptBudget(budget, {
			bytes: Buffer.byteLength(framing),
			estimatedTokens: estimateTokensFromText(framing),
			lines: estimateLineCount(framing),
		});
		const block = composeTieredMemoryPromptBlock(candidates, available);
		const body =
			block.text ?? (records.length === 0 ? "No applicable accepted facts." : "No accepted facts fit this view.");
		const nonce = createHash("sha256").update(body).digest("hex").slice(0, 32);
		const text = `${header}\n${wrapUntrustedText(body, "memory:knowledge", { nonce })}\n${omission(block.omittedCount)}`;
		const fits = memoryTextFitsBudget(text, budget);
		const included = new Set(fits ? block.includedIds : []);
		const dropped = new Map(block.diagnostics.map((entry) => [entry.candidateId, entry.reason] as const));
		// The framed view itself overflowing drops what the composer admitted: one record alone is oversized.
		if (!fits)
			for (const id of block.includedIds)
				dropped.set(id, block.includedCount === 1 ? "oversized_item" : "budget_exhausted");
		const value: KnowledgeProjection = {
			revision: snapshot.revision,
			text: fits ? text : "",
			includedCount: fits ? block.includedCount : 0,
			omittedCount: unavailable + (fits ? block.omittedCount : records.length),
			references: Object.freeze(
				records
					.filter((record) => included.has(record.id))
					.map((record) => Object.freeze({ id: record.id, revision: record.revision })),
			),
			dropped,
			isCurrent: () => {
				const now = new Date().toISOString();
				try {
					return (
						this.store.revision() === snapshot.revision &&
						now >= capturedAt &&
						(snapshot.refreshAt === undefined || now < snapshot.refreshAt)
					);
				} catch {
					return false;
				}
			},
		};
		this.rendered = { snapshot, key: renderKey, value };
		return value;
	}
}
