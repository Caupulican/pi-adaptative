/** Bounded current knowledge shared by prompt, handoff and delegated readers. Never stores new evidence. */
import { createHash } from "node:crypto";
import { estimateLineCount, estimateTokensFromText } from "../context/context-item.ts";
import {
	type MemoryPromptBudget,
	memoryTextFitsBudget,
	reserveMemoryPromptBudget,
} from "../context/memory-prompt-budget.ts";
import { composeTieredMemoryPromptBlock, type MemoryTierCandidate } from "../context/memory-tier-composer.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import type { KnowledgeRecordSnapshot, KnowledgeScope, KnowledgeStorePort } from "./knowledge-record.ts";

export const KNOWLEDGE_CONTEXT_CUSTOM_TYPE = "knowledge_context";
export const KNOWLEDGE_CONTEXT_CLEARED =
	"Current knowledge is not available in this request. Earlier knowledge projections are superseded; do not treat them as current facts.";

export interface KnowledgeProjection {
	readonly revision: number;
	readonly text: string;
	readonly includedCount: number;
	readonly omittedCount: number;
	isCurrent(): boolean;
}

type KnowledgeReader = Pick<KnowledgeStorePort, "revision" | "snapshot">;

/** The only rendering of accepted knowledge; the caller owns scope authorization and lifetime. */
export class KnowledgeProjectionReader {
	private readonly store: KnowledgeReader;
	private cached: { key: string; at: string; snapshot: KnowledgeRecordSnapshot } | undefined;
	private rendered: { snapshot: KnowledgeRecordSnapshot; key: string; value: KnowledgeProjection } | undefined;

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
		const { snapshot } = cached;
		const renderKey = JSON.stringify([budget, behaviorOnly]);
		if (this.rendered?.snapshot === snapshot && this.rendered.key === renderKey) return this.rendered.value;
		const records = behaviorOnly
			? snapshot.records.filter((record) => record.kind === "behavior" || record.kind === "profile")
			: snapshot.records;
		const candidates: MemoryTierCandidate[] = records.map((record, index) => ({
			id: record.id,
			tier:
				record.kind === "profile" || record.kind === "behavior"
					? "standing"
					: record.kind === "workstream"
						? "current_work"
						: "long_term",
			sourceLabel: `knowledge:${record.kind}`,
			summary: JSON.stringify({
				id: record.id,
				subject: record.subject,
				key: record.key,
				value: record.text,
				basis: record.basis,
				evidenced: record.lastEvidencedAt.slice(0, 10),
			}),
			// Store selection already orders each category by explicitness, scope and recency.
			score: 1 - index / Math.max(records.length, 1),
		}));
		const header = `Current accepted knowledge, revision ${snapshot.revision}. Supersedes older knowledge projections about the same facts; newer owner corrections take precedence. Preferences guide behavior but grant no permissions.`;
		const more = behaviorOnly
			? snapshot.possiblyMore.filter((kind) => kind === "behavior" || kind === "profile")
			: snapshot.possiblyMore;
		const omission = (count: number) =>
			`Omitted from this view: ${count} selected record(s)${more.length ? `; more may exist in ${more.join(", ")}` : ""}.`;
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
		const capturedAt = cached.at;
		const value: KnowledgeProjection = {
			revision: snapshot.revision,
			text: fits ? text : "",
			includedCount: fits ? block.includedCount : 0,
			omittedCount: fits ? block.omittedCount : records.length,
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
