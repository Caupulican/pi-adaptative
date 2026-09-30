import { compactRetainedDetails } from "@caupulican/pi-agent-core/message-retention";
import type { Usage } from "@caupulican/pi-ai";
import { type Static, Type } from "typebox";
import { SYSTEM_ONE_VALIDATION_RULE } from "../provider-prompt-contracts.ts";
import {
	SystemOneReviewError,
	type SystemOneReviewPort,
	type SystemOneTransportAttempt,
} from "../review/system-one-review-port.ts";
import {
	type EvaluationInput,
	evaluationInputSchema,
	getEvaluationUsage,
	type ReviewInput,
	reviewInputSchema,
	validateTypeSafeInput,
} from "../review/typesafe-contract.ts";
import {
	MAX_TYPESAFE_EVIDENCE_REFERENCES,
	type TypeSafeEvidenceManifestEntry,
	type TypeSafeEvidenceMaterializer,
	typeSafeEvidenceReferenceSchema,
} from "../review/typesafe-evidence-materializer.ts";
import type { TypeSafeEvidenceStore } from "../review/typesafe-evidence-store.ts";
import { type PricedTypeSafeUsage, priceTypeSafeUsage } from "../review/typesafe-usage.ts";
import type { SemanticUncertaintyPort } from "../system-one/semantic-doubts.ts";
import { SYSTEM_ONE_TOOL_NAME } from "../system-one/tool-names.ts";

const schema = Type.Object(
	{
		action: Type.Enum(["status", "evaluate", "review", "evidence", "uncertainties", "resolve_uncertainty"]),
		id: Type.Optional(Type.String()),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		evidenceRefs: Type.Optional(
			Type.Array(typeSafeEvidenceReferenceSchema, { minItems: 1, maxItems: MAX_TYPESAFE_EVIDENCE_REFERENCES }),
		),
		evaluation: Type.Optional(evaluationInputSchema),
		review: Type.Optional(reviewInputSchema),
		uncertainty: Type.Optional(
			Type.Object(
				{
					evaluationId: Type.String({ minLength: 1 }),
					question: Type.String({ minLength: 1 }),
					disposition: Type.Enum(["conservative_path", "evidence_based_decision"]),
					reason: Type.String({ minLength: 1 }),
					evidence: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

function projectUsage(
	attempts: readonly SystemOneTransportAttempt[],
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
	if (!materializer) throw new Error("System One referenced evidence is unavailable in this runtime");
	const evidence = await materializer.materialize(evidenceRefs, signal);
	return {
		request: {
			...input,
			state: { provided_state: input.state, referenced_evidence: evidence.state },
		},
		sourceManifest: evidence.manifest,
	};
}

export function createSystemOneToolDefinition(
	reviewer: SystemOneReviewPort,
	evidenceStore: TypeSafeEvidenceStore,
	reportUsage?: (toolCallId: string, usage: Usage) => void,
	evidenceMaterializer?: TypeSafeEvidenceMaterializer,
	uncertainties?: SemanticUncertaintyPort,
) {
	const uncertaintyPrompt = uncertainties
		? "At turn entry and before delivery, inspect active uncertainties. For worker-task questions, gather evidence from the responsible worker and steer it as needed; after reviewing that evidence, the owning session may record an advisory disposition for any current question in its own journal. Include a conservative path or evidence-based decision with concise evidence and reason. Keep mandatory same-lane verification and recheck requirements active. This disposition is not a System One pass, verification proof, certificate proof, or permission. Reject stale questions and questions explicitly scoped to a foreign root session."
		: "Worker lanes cannot disposition session-owner uncertainties. Recheck your own mandatory findings in this lane, report unresolved advisory questions and evidence to the parent, and continue independent work where appropriate.";
	return {
		name: SYSTEM_ONE_TOOL_NAME,
		label: "System One",
		readOnly: true,
		description: `Use System One for semantic decisions and independent verification. Status checks setup. Evaluate batched Choice, Noul and Score questions. Review gates claims at high (0.95) or max (0.99) confidence. evidenceRefs snapshots scoped files, artifacts, or git diffs. Evidence reads retained records by id and offset. ${uncertainties ? "The session owner can list and disposition advisory uncertainties; this never proves verification or grants permission." : "Workers report unresolved task questions to their owner and recheck mandatory findings in their own lane."} Does not execute or authorize actions.`,
		promptSnippet: "System One: semantic judgments and high/max claim review.",
		promptGuidelines: [
			'For review, use an option map and a declared expected key, for example: {"action":"review","review":{"state":"relevant source and check results","questions":{"claim":{"instructions":"Does this evidence support the claim?","criteria":{"supports":"Supported","contradicts":"Contradicted","insufficient":"Missing evidence"},"expected":"supports"}}}}.',
			"Check systemone status at work start. When the systemone skill is listed and the skill tool is available, load the systemone skill. Use System One for semantic decisions and reviews throughout work, in any domain.",
			"Batch independent narrow questions with complete relevant source, tests, prior findings and limitations; never hide adverse evidence. Reproduce bug candidates before fixing.",
			"Approval requires every expected verdict and high/max confidence; fix findings or add missing evidence. Never reroll unchanged evidence for a better score. Use the configured provider login flow reported by systemone status; never put credentials in tool arguments.",
			uncertaintyPrompt,
			"An uncertain or unavailable System One result returns to the owning LLM. Workers report unresolved decisions to the parent; only the root asks the owner when authority or evidence is still missing. Silence grants nothing.",
			SYSTEM_ONE_VALIDATION_RULE,
		],
		// The model and reviewer consume the same canonical input contract.
		parameters: schema,
		// Independent System One calls in one turn run together: evidence saves are synchronous under the
		// session bundle lock and the reviewer holds no per-call state.
		async execute(toolCallId: string, input: Static<typeof schema>, signal?: AbortSignal) {
			let usageProjection: PricedTypeSafeUsage | undefined;
			const onResponse = (
				attempts: readonly SystemOneTransportAttempt[],
				connection: { readonly provider: string; readonly model: string },
			): void => {
				usageProjection = projectUsage(attempts, connection);
				if (usageProjection) reportUsage?.(toolCallId, usageProjection.usage);
			};
			let record: Record<string, unknown>;
			let isError = false;
			let errorKind: "operation_outcome" | undefined;
			let transportAttempts: SystemOneTransportAttempt[] = [];
			let sourceManifest: readonly TypeSafeEvidenceManifestEntry[] | undefined;
			try {
				signal?.throwIfAborted();
				if (input.action === "uncertainties") {
					if (!uncertainties) {
						return {
							isError: true,
							content: [
								{ type: "text" as const, text: "Only the session owner can list semantic uncertainties." },
							],
							details: { advisoryOnly: true },
						};
					}
					const unresolved = uncertainties.listOwnSession();
					const record = { kind: "active_semantic_uncertainties", advisoryOnly: true, uncertainties: unresolved };
					return {
						content: [{ type: "text" as const, text: JSON.stringify(record) }],
						details: record,
					};
				}
				if (input.action === "resolve_uncertainty") {
					if (!uncertainties) {
						return {
							isError: true,
							content: [
								{
									type: "text" as const,
									text: "Only the session owner can disposition semantic uncertainties.",
								},
							],
							details: { advisoryOnly: true },
						};
					}
					if (!input.uncertainty) throw new Error("uncertainty is required for the resolve_uncertainty action");
					const resolution = uncertainties.resolveOwnSession(input.uncertainty);
					const record = {
						kind: "advisory_semantic_disposition",
						advisoryOnly: true,
						...resolution,
						...(resolution.resolved
							? { disposition: input.uncertainty.disposition, evaluationId: input.uncertainty.evaluationId }
							: {}),
						message: resolution.resolved
							? "Recorded owner-model advisory disposition. This is not System One verification, certificate proof, or permission."
							: "No uncertainty was settled. Refresh the active questions; the evaluation or question may have changed or belong to another lane.",
					};
					return {
						content: [{ type: "text" as const, text: JSON.stringify(record) }],
						details: record,
					};
				}
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
				validateTypeSafeInput(
					input.action === "evaluate" ? "evaluation" : "review",
					input.action === "evaluate" ? input.evaluation : input.review,
				);
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
					? "System One review cancelled"
					: error instanceof Error
						? error.message
						: "System One review failed";
				isError = true;
				// A completed service attempt owns its negative result and evidence. Generic
				// tool-failure rewriting would replace that record with a lossy diagnostic.
				if (error instanceof SystemOneReviewError) errorKind = "operation_outcome";
				transportAttempts = error instanceof SystemOneReviewError ? error.transportAttempts : [];
				record = {
					accepted: false,
					costStatus: usageProjection?.costStatus ?? "unpriced",
					...(usageProjection?.costProvenance ? { costProvenance: usageProjection.costProvenance } : {}),
					error: message,
					...(sourceManifest ? { sourceManifest } : {}),
					...(error instanceof SystemOneReviewError
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
						{ type: "text" as const, text: "System One evidence could not be retained; review is not accepted." },
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
