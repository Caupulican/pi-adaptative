import { compactRetainedDetails } from "@caupulican/pi-agent-core/message-retention";
import type { Usage } from "@caupulican/pi-ai";
import { type Static, Type } from "typebox";
import { SYSTEM_ONE_VALIDATION_RULE } from "../provider-prompt-contracts.ts";
import {
	type EvaluationInput,
	evaluationInputSchema,
	getEvaluationUsage,
	type ReviewInput,
	reviewInputSchema,
} from "../review/typesafe-contract.ts";
import {
	MAX_TYPESAFE_EVIDENCE_REFERENCES,
	type TypeSafeEvidenceManifestEntry,
	type TypeSafeEvidenceMaterializer,
	typeSafeEvidenceReferenceSchema,
} from "../review/typesafe-evidence-materializer.ts";
import type { TypeSafeEvidenceStore } from "../review/typesafe-evidence-store.ts";
import {
	TypeSafeReviewError,
	type TypeSafeReviewer,
	type TypeSafeTransportAttempt,
} from "../review/typesafe-reviewer.ts";
import { type PricedTypeSafeUsage, priceTypeSafeUsage } from "../review/typesafe-usage.ts";

const schema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("status"),
			Type.Literal("evaluate"),
			Type.Literal("review"),
			Type.Literal("evidence"),
		]),
		id: Type.Optional(Type.String()),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		evidenceRefs: Type.Optional(
			Type.Array(typeSafeEvidenceReferenceSchema, { minItems: 1, maxItems: MAX_TYPESAFE_EVIDENCE_REFERENCES }),
		),
		evaluation: Type.Optional(evaluationInputSchema),
		review: Type.Optional(reviewInputSchema),
	},
	{ additionalProperties: false },
);

// Load the complete rubric through the skill instead of repeating every EntryType union
// in each provider request. The reviewer always validates the full canonical contract.
const parameters = Type.Object(
	{
		action: schema.properties.action,
		id: schema.properties.id,
		offset: schema.properties.offset,
		evidenceRefs: schema.properties.evidenceRefs,
		evaluation: Type.Optional(
			Type.Object(
				{
					...evaluationInputSchema.properties,
					questions: Type.Record(
						Type.String(),
						Type.Object(
							{
								type: Type.String({ description: "choice, noul or score" }),
								instructions: Type.Unknown(),
								criteria: Type.Optional(
									Type.Unknown({
										description: "Choice: option map. Noul: true/false descriptions. Score: ordered levels.",
									}),
								),
							},
							{ additionalProperties: false },
						),
						{ minProperties: 1 },
					),
				},
				{ additionalProperties: false },
			),
		),
		review: Type.Optional(
			Type.Object(
				{
					...reviewInputSchema.properties,
					questions: Type.Record(
						Type.String(),
						Type.Object(
							{
								instructions: Type.Unknown(),
								criteria: Type.Unknown({ description: "Choice option map; descriptions may be structured." }),
								expected: Type.String(),
							},
							{ additionalProperties: false },
						),
						{ minProperties: 1 },
					),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

function projectUsage(
	attempts: readonly TypeSafeTransportAttempt[],
	connection: { readonly provider: string; readonly model: string },
): PricedTypeSafeUsage | undefined {
	let inputTokens = 0;
	let outputTokens = 0;
	let known = false;
	for (const attempt of attempts) {
		const reported = getEvaluationUsage(attempt.response);
		if (!reported) continue;
		known = true;
		inputTokens += reported.input_tokens;
		outputTokens += reported.output_tokens;
	}
	return known && Number.isSafeInteger(inputTokens + outputTokens)
		? priceTypeSafeUsage(connection.provider, connection.model, {
				input_tokens: inputTokens,
				output_tokens: outputTokens,
			})
		: undefined;
}

async function materializeReferencedEvidence<T extends ReviewInput | EvaluationInput>(
	input: T,
	evidenceRefs: Static<typeof schema>["evidenceRefs"],
	materializer: TypeSafeEvidenceMaterializer | undefined,
	signal?: AbortSignal,
) {
	if (!evidenceRefs) return { request: input, sourceManifest: undefined };
	if (!materializer) throw new Error("TypeSafe referenced evidence is unavailable in this runtime");
	const evidence = await materializer.materialize(evidenceRefs, signal);
	return {
		request: {
			...input,
			state: { provided_state: input.state, referenced_evidence: evidence.state },
		},
		sourceManifest: evidence.manifest,
	};
}

export function createTypeSafeReviewToolDefinition(
	reviewer: TypeSafeReviewer,
	evidenceStore: TypeSafeEvidenceStore,
	reportUsage?: (toolCallId: string, usage: Usage) => void,
	evidenceMaterializer?: TypeSafeEvidenceMaterializer,
) {
	return {
		name: "typesafe_review",
		label: "TypeSafe review",
		readOnly: true,
		description:
			"Use Jev for semantic decisions and independent verification. Status checks setup. Evaluate batched Choice, Noul and Score questions. Review gates claims at high (0.95) or max (0.99) confidence. evidenceRefs snapshots scoped files, artifacts, or git diffs. Evidence reads retained records by id and offset. Does not execute or authorize actions.",
		promptSnippet: "Jev: semantic judgments and high/max claim review.",
		promptGuidelines: [
			"Check typesafe_review status at work start. When the typesafe-review skill is listed and the skill tool is available, load the typesafe-review skill. Use Jev for semantic decisions and reviews throughout work, in any domain.",
			"Batch independent narrow questions with complete relevant source, tests, prior findings and limitations; never hide adverse evidence. Reproduce bug candidates before fixing.",
			"Approval requires every expected verdict and high/max confidence; fix findings or add missing evidence. Never reroll unchanged evidence for a better score. Credentials belong in /login typesafe, never tool arguments.",
			"An uncertain or unavailable Jev result returns to the owning LLM. Workers report unresolved decisions to the parent; only the root asks the owner when authority or evidence is still missing. Silence grants nothing.",
			SYSTEM_ONE_VALIDATION_RULE,
		],
		parameters,
		// Independent System One calls in one turn run together: evidence saves are synchronous under the
		// session bundle lock and the reviewer holds no per-call state.
		async execute(toolCallId: string, input: Static<typeof schema>, signal?: AbortSignal) {
			let usageProjection: PricedTypeSafeUsage | undefined;
			const onResponse = (
				attempts: readonly TypeSafeTransportAttempt[],
				connection: { readonly provider: string; readonly model: string },
			): void => {
				usageProjection = projectUsage(attempts, connection);
				if (usageProjection) reportUsage?.(toolCallId, usageProjection.usage);
			};
			let record: Record<string, unknown>;
			let isError = false;
			let errorKind: "operation_outcome" | undefined;
			let transportAttempts: TypeSafeTransportAttempt[] = [];
			let sourceManifest: readonly TypeSafeEvidenceManifestEntry[] | undefined;
			try {
				signal?.throwIfAborted();
				if (input.action === "evidence") {
					const page = evidenceStore.read(input.id ?? "", input.offset);
					return {
						content: [{ type: "text" as const, text: JSON.stringify(page) }],
						details: { id: page.id, nextOffset: page.nextOffset },
					};
				}
				if (input.action === "status") {
					const status = await reviewer.status(signal);
					return { content: [{ type: "text" as const, text: JSON.stringify(status) }], details: status };
				}
				if (input.action === "evaluate" && !input.evaluation)
					throw new Error("evaluation is required for the evaluate action");
				if (input.action === "review" && !input.review) throw new Error("review is required for the review action");
				const prepared = await materializeReferencedEvidence(
					input.action === "evaluate" ? input.evaluation! : input.review!,
					input.evidenceRefs,
					evidenceMaterializer,
					signal,
				);
				sourceManifest = prepared.sourceManifest;
				const result =
					input.action === "evaluate"
						? await reviewer.evaluate(prepared.request as EvaluationInput, signal, onResponse)
						: await reviewer.review(prepared.request as ReviewInput, signal, onResponse);
				record = {
					...result,
					...(sourceManifest ? { sourceManifest } : {}),
					costStatus: usageProjection?.costStatus ?? "unpriced",
					...(usageProjection?.costProvenance ? { costProvenance: usageProjection.costProvenance } : {}),
				};
				transportAttempts = result.transportAttempts;
			} catch (error) {
				const message = signal?.aborted
					? "TypeSafe review cancelled"
					: error instanceof Error
						? error.message
						: "TypeSafe review failed";
				isError = true;
				// A completed service attempt owns its negative result and evidence. Generic
				// tool-failure rewriting would replace that record with a lossy diagnostic.
				if (error instanceof TypeSafeReviewError) errorKind = "operation_outcome";
				transportAttempts = error instanceof TypeSafeReviewError ? error.transportAttempts : [];
				record = {
					accepted: false,
					costStatus: usageProjection?.costStatus ?? "unpriced",
					...(usageProjection?.costProvenance ? { costProvenance: usageProjection.costProvenance } : {}),
					error: message,
					...(sourceManifest ? { sourceManifest } : {}),
					...(error instanceof TypeSafeReviewError
						? {
								requestSha256: error.requestSha256,
								request: error.request,
								response: error.response,
								transportAttempts,
							}
						: {}),
				};
			}
			try {
				const evidence = evidenceStore.save(toolCallId, record);
				const { request: _request, transportAttempts: _attempts, ...summary } = record;
				const holder: { details: unknown } = { details: { ...record, evidence } };
				compactRetainedDetails(holder);
				if (
					holder.details &&
					typeof holder.details === "object" &&
					"piToolResultDetailsTruncated" in holder.details
				) {
					holder.details = {
						accepted: record.accepted,
						requestSha256: record.requestSha256,
						evidence,
						costStatus: record.costStatus,
						...(record.costProvenance ? { costProvenance: record.costProvenance } : {}),
					};
				}
				return {
					isError,
					errorKind,
					content: [{ type: "text" as const, text: JSON.stringify({ ...summary, evidence }) }],
					details: holder.details,
					usage: usageProjection?.usage,
				};
			} catch {
				return {
					isError: true,
					content: [
						{ type: "text" as const, text: "TypeSafe evidence could not be retained; review is not accepted." },
					],
					details: {
						accepted: false,
						costStatus: usageProjection?.costStatus ?? "unpriced",
						...(usageProjection?.costProvenance ? { costProvenance: usageProjection.costProvenance } : {}),
					},
					usage: usageProjection?.usage,
				};
			}
		},
	};
}
