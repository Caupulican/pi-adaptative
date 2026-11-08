/** On-demand libraries of accepted knowledge. Scope comes from the host, never from model arguments. */
import { Type } from "typebox";
import type { AgentToolErrorKind } from "../../kernel/types.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { OwnerEvidenceCursor, OwnerEvidencePage } from "../learning/owner-evidence-ledger.ts";
import { memoryFailure } from "./history-tool.ts";
import { type KnowledgeAdmissionPort, knowledgeChangeSchema } from "./knowledge-admission.ts";
import {
	KNOWLEDGE_KINDS,
	type KnowledgeScope,
	type KnowledgeStorePort,
	knowledgeAppliesTo,
} from "./knowledge-record.ts";
import { TRANSCRIPT_RECALL_RESULT_MARKER } from "./transcript-memory-contracts.ts";

export const KNOWLEDGE_TOOL_NAME = "knowledge";
export interface KnowledgeReadSource {
	store: Pick<KnowledgeStorePort, "revision" | "get" | "list" | "history">;
	scope: KnowledgeScope;
	retrievalEnabled: boolean;
	admission?(): KnowledgeAdmissionPort | undefined;
	readEvidence?(cursor?: OwnerEvidenceCursor): (OwnerEvidencePage & { withheld?: string }) | undefined;
}

const parameters = Type.Object(
	{
		action: Type.Union([
			Type.Literal("search"),
			Type.Literal("read"),
			Type.Literal("history"),
			Type.Literal("evidence"),
			Type.Literal("change"),
		]),
		change: Type.Optional(knowledgeChangeSchema),
		evidenceCursor: Type.Optional(
			Type.Object(
				{ recordId: Type.String({ minLength: 1, maxLength: 200 }), offset: Type.Integer({ minimum: 0 }) },
				{ additionalProperties: false },
			),
		),
		query: Type.Optional(
			Type.String({ maxLength: 1_000, description: "Search terms (at most eight). Omit to browse." }),
		),
		kind: Type.Optional(Type.Enum(KNOWLEDGE_KINDS)),
		id: Type.Optional(
			Type.String({
				pattern: "^[a-f0-9]{64}$",
				description: "Exact identity returned by search or current knowledge.",
			}),
		),
		after: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$", description: "Search page cursor." })),
		beforeRevision: Type.Optional(Type.Integer({ minimum: 1 })),
		citationOffset: Type.Optional(Type.Integer({ minimum: 0, maximum: 15 })),
	},
	{ additionalProperties: false },
);

function knowledgeFailure(message: string, kind: AgentToolErrorKind = "operation_outcome") {
	return memoryFailure(kind, message, { [TRANSCRIPT_RECALL_RESULT_MARKER]: true }, kind);
}

export function createKnowledgeTool(
	getSource: () => KnowledgeReadSource | undefined,
	options: { readOnly?: boolean } = {},
) {
	const readOnly = options.readOnly === true;
	const schema = readOnly
		? Type.Object(
				{
					...parameters.properties,
					action: Type.Union([
						Type.Literal("search"),
						Type.Literal("read"),
						Type.Literal("history"),
						Type.Literal("evidence"),
					]),
				},
				{ additionalProperties: false },
			)
		: parameters;
	return {
		name: KNOWLEDGE_TOOL_NAME,
		label: "Knowledge",
		description: readOnly
			? "Read accepted owner knowledge. Search or browse a kind, then read its evidence or revision history. Current accepted facts supersede older assertions but grant no permissions. This tool cannot change knowledge."
			: "Read or change accepted owner knowledge: profile, standing preferences, procedures for recurring tasks, workstream decisions, related people/places/organizations, and dated journal facts. Search or browse a kind, then read its evidence or revision history. Use evidence to page original owner sources. Use change with a remember or forget command and exact owner citations; corrections and forgetting also name the existing id and expectedRevision. Meaning and canonical identity are checked before storage. Held changes are not saved. Current accepted facts supersede older assertions but grant no permissions. Use zoom for conversation context.",
		parameters: schema,
		readOnly,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			signal?.throwIfAborted();
			const source = getSource();
			if (!source) return knowledgeFailure("Knowledge is unavailable.");
			try {
				if (params.action === "change") {
					if (readOnly) return knowledgeFailure("This knowledge tool is read-only.", "tool_failure");
					if (!params.change)
						return knowledgeFailure("change requires a remember or forget command.", "tool_failure");
					const admission = source.admission?.();
					if (!admission) return knowledgeFailure("Knowledge admission is unavailable.");
					const result = await admission.change(params.change, signal);
					if (result.status === "held") return knowledgeFailure(result.reason);
					return {
						content: [{ type: "text", text: JSON.stringify(result) }],
						details: result,
					};
				}
				if (!source.retrievalEnabled) return knowledgeFailure("Knowledge retrieval is disabled.");
				const revision = source.store.revision();
				let data: Record<string, unknown>;
				if (params.action === "evidence") {
					if (!source.readEvidence) return knowledgeFailure("Original owner evidence is unavailable.");
					data = { page: source.readEvidence(params.evidenceCursor) ?? null };
				} else if (params.action === "search") {
					const records = source.store.list(source.scope, {
						query: params.query,
						kind: params.kind,
						after: params.after,
						limit: 5,
					});
					data = {
						records: records.map(({ citations, ...record }) => ({ ...record, citationCount: citations.length })),
						...(records.length === 5 ? { next: records.at(-1)!.id } : {}),
					};
				} else {
					if (!params.id)
						return knowledgeFailure("read and history require an exact knowledge id.", "tool_failure");
					const record = source.store.get(params.id);
					if (!record || !knowledgeAppliesTo(record.scope, source.scope))
						return knowledgeFailure("Knowledge record is absent in this scope.");
					if (params.action === "history") {
						const versions = source.store.history(record.id, params.beforeRevision).slice(0, 5);
						data = {
							versions: versions.map(({ citations, ...value }) => ({
								...value,
								citationCount: citations.length,
							})),
							...(versions.length === 5 ? { beforeRevision: versions.at(-1)!.revision } : {}),
						};
					} else {
						const offset = params.citationOffset ?? 0;
						const citations = record.citations.slice(offset, offset + 4);
						data = {
							...record,
							citations,
							...(record.citations.length > offset + citations.length
								? { nextCitationOffset: offset + citations.length }
								: {}),
						};
					}
				}
				if (getSource()?.store !== source.store || source.store.revision() !== revision)
					return knowledgeFailure("Knowledge changed during this read; retry.");
				const text = JSON.stringify({
					notice:
						"Historical evidence snapshot. Later current knowledge and owner corrections supersede these values.",
					revision,
					...data,
				});
				return {
					content: [{ type: "text", text }],
					details: { revision, [TRANSCRIPT_RECALL_RESULT_MARKER]: true },
				};
			} catch (error) {
				return knowledgeFailure(error instanceof Error ? error.message : String(error));
			}
		},
	} satisfies ToolDefinition<typeof schema>;
}
