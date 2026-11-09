import type { Usage } from "@caupulican/pi-ai";
import { type Static, Type } from "typebox";
import { compactRetainedDetails } from "../../kernel/session/message-retention.ts";
import {
	SystemOneObserverError,
	SystemOneReviewError,
	type SystemOneReviewPort,
	type SystemOneTransportAttempt,
} from "../review/system-one-review-port.ts";
import {
	type EvaluationInput,
	getEvaluationUsage,
	type ReviewInput,
	reviewInputSchema,
	textEvaluationInputSchema,
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
import { evaluateSystemOneVision, type SystemOneImageManifest, visionInputSchema } from "../review/typesafe-vision.ts";
import type { FileLocator } from "../system-one/locate.ts";
import {
	LocateInputError,
	MAX_LOCATE_LIMIT,
	MAX_LOCATE_PATHS,
	MAX_LOCATE_QUERIES,
	MAX_LOCATE_QUERY_CHARS,
	MAX_LOCATE_TARGET_CHARS,
} from "../system-one/locate-input.ts";
import type { SemanticUncertaintyPort } from "../system-one/semantic-doubts.ts";
import { SYSTEM_ONE_TOOL_NAME } from "../system-one/tool-names.ts";

const schema = Type.Object(
	{
		action: Type.Enum([
			"status",
			"evaluate",
			"review",
			"vision",
			"evidence",
			"uncertainties",
			"resolve_uncertainty",
			"locate",
		]),
		id: Type.Optional(Type.String()),
		offset: Type.Optional(Type.Integer({ minimum: 0 })),
		evidenceRefs: Type.Optional(
			Type.Array(typeSafeEvidenceReferenceSchema, { minItems: 1, maxItems: MAX_TYPESAFE_EVIDENCE_REFERENCES }),
		),
		evaluation: Type.Optional(textEvaluationInputSchema),
		vision: Type.Optional(visionInputSchema),
		review: Type.Optional(reviewInputSchema),
		locate: Type.Optional(
			Type.Object(
				{
					target: Type.String({ minLength: 1, maxLength: MAX_LOCATE_TARGET_CHARS }),
					queries: Type.Array(Type.String({ minLength: 1, maxLength: MAX_LOCATE_QUERY_CHARS }), {
						minItems: 1,
						maxItems: MAX_LOCATE_QUERIES,
					}),
					paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: MAX_LOCATE_PATHS })),
					limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LOCATE_LIMIT })),
				},
				{ additionalProperties: false },
			),
		),
		uncertainty: Type.Optional(
			Type.Object(
				{
					evaluationId: Type.String({ minLength: 1 }),
					question: Type.String({ minLength: 1 }),
					disposition: Type.Enum(["conservative_path", "evidence_based_decision"]),
					reason: Type.String({ minLength: 1 }),
					evidence: Type.String({ minLength: 1 }),
					workerTaskFit: Type.Optional(Type.Enum(["adequate", "inadequate"])),
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
	locator?: Pick<FileLocator, "locate">,
	// The reviewer records every paid response through the session's usage delivery: the result must not carry the same spend.
	reviewerRecordsUsage = false,
) {
	const uncertaintyClause = uncertainties
		? "At turn entry and before delivery, inspect active uncertainties with uncertainties (advisory questions); resolve_uncertainty records a disposition (conservative_path or evidence_based_decision) with reason and evidence, after an extra reasoning round over the task and evidence. For worker_task_fit:<fingerprint> questions record workerTaskFit adequate or inadequate; only an explicit adequate outcome settles that exact task/model fitness on retry. No disposition is System One verification, certificate proof or an execution grant, and mandatory same-lane verification stays required. Reject stale questions and questions scoped to a foreign root session."
		: "Workers cannot disposition session-owner uncertainties: recheck your mandatory findings in this lane and report unresolved advisory questions and evidence to the parent.";
	return {
		name: SYSTEM_ONE_TOOL_NAME,
		label: "System One",
		readOnly: true,
		description: `Semantic judgments and independent verification; results advise and never execute or authorize actions. System One judges, code decides: compute facts in code, ask one atomic question per judgment, accept only at 0.90 or higher (0.10 or lower for absence), and keep open, reject and error apart; load the systemone skill if listed for how to design the questions and exits. Batch independent narrow questions with the complete source, checks and limitations, never hide adverse evidence, and reproduce bug candidates before fixing. On an uncertain or unavailable result, gather new evidence or decide within your grant; only the root asks the owner, and only when authority or evidence is missing; silence grants nothing. status: setup, image capability and the provider login flow to use; run it when availability is unknown (never put credentials in tool arguments). evaluate: batched Choice, Noul and Score questions. review: gates claims at high (0.95) or max (0.99) confidence; approval needs every expected verdict, so fix findings or add evidence and never reroll unchanged evidence, e.g. {"action":"review","review":{"state":"<source and check results>","questions":{"claim":{"instructions":"Does this evidence support the claim?","criteria":{"supports":"Supported","insufficient":"Missing evidence"},"expected":"supports"}}}}. evidenceRefs snapshots scoped files, artifacts or git diffs into evaluate and review. vision: judges and compares explicitly selected PNG/JPEG files and localizes targets with Box plus presence (experimental, advisory; check status capabilities.images first); reference each <screen> placeholder from images in state, instructions and criteria, give a Box its unique Noul with instructions:null and no criteria, crop in integer EXIF-upright source pixels; no screenshots are captured and vision never approves completion or clicks. evidence: reads retained records by id and offset. locate: ranks files by whether their code defines what a target describes (target in words plus 1-8 literal/regex queries; read top hits before editing; for a known token use grep). ${uncertaintyClause}`,
		promptSnippet: "Semantic judgment and claim review",
		// The model and reviewer consume the same canonical input contract.
		parameters: schema,
		// Independent System One calls in one turn run together: evidence saves are synchronous under the
		// session bundle lock and the reviewer holds no per-call state.
		async execute(toolCallId: string, input: Static<typeof schema>, signal?: AbortSignal) {
			const capturedOrigin = reviewer.captureUsageOrigin?.();
			const usageOrigin = capturedOrigin ? { ...capturedOrigin, toolCallId } : undefined;
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
			let imageManifest: readonly SystemOneImageManifest[] | undefined;
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
							? input.uncertainty.workerTaskFit
								? `Recorded exact worker task/model fitness decision: ${input.uncertainty.workerTaskFit}. Execution grants and verification remain independently required.`
								: "Recorded owner-model advisory disposition. This is not System One verification, certificate proof, or permission."
							: "No uncertainty was settled. Refresh the active questions; the evaluation or question may have changed or belong to another lane.",
					};
					return {
						content: [{ type: "text" as const, text: JSON.stringify(record) }],
						details: record,
					};
				}
				if (input.action === "locate") {
					if (!locator) {
						return {
							isError: true,
							content: [
								{ type: "text" as const, text: "systemone locate is available to the session owner only." },
							],
							details: { advisoryOnly: true },
						};
					}
					if (!input.locate) throw new Error("locate is required for the locate action");
					const outcome = await locator.locate(input.locate, signal);
					return {
						content: [{ type: "text" as const, text: outcome.text }],
						details: {
							kind: "system_one_locate",
							judged: outcome.judged,
							candidates: outcome.candidates,
							filesMatched: outcome.filesMatched,
							requests: outcome.requests,
							matches: [...outcome.matches, ...outcome.closest]
								.slice(0, MAX_LOCATE_LIMIT)
								.map(({ path, line, probability }) => ({ path, line, probability })),
						},
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
				if (input.action === "vision") {
					if (!input.vision || !evidenceMaterializer)
						throw new Error("vision input and scoped evidence materialization are required");
					if (input.evidenceRefs)
						throw new Error("For vision, put text evidence in vision.state; evidenceRefs is for text actions");
					const result = await evaluateSystemOneVision(
						input.vision,
						evidenceMaterializer,
						reviewer,
						signal,
						onResponse,
						(manifest) => {
							imageManifest = manifest;
						},
						usageOrigin,
					);
					record = {
						...result,
						costStatus: usageProjection?.costStatus ?? "unpriced",
						...(usageProjection?.costProvenance ? { costProvenance: usageProjection.costProvenance } : {}),
					};
					transportAttempts = result.transportAttempts;
				} else {
					if (input.action === "evaluate" && !input.evaluation)
						throw new Error("evaluation is required for the evaluate action");
					if (input.action === "review" && !input.review)
						throw new Error("review is required for the review action");
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
							? await reviewer.evaluate(prepared.request as EvaluationInput, signal, onResponse, usageOrigin)
							: await reviewer.review(prepared.request as ReviewInput, signal, onResponse, usageOrigin);
					record = {
						...result,
						...(sourceManifest ? { sourceManifest } : {}),
						costStatus: usageProjection?.costStatus ?? "unpriced",
						...(usageProjection?.costProvenance ? { costProvenance: usageProjection.costProvenance } : {}),
					};
					transportAttempts = result.transportAttempts;
				}
			} catch (error) {
				if (error instanceof LocateInputError) {
					return {
						isError: true,
						content: [{ type: "text" as const, text: error.message }],
						details: { kind: "system_one_locate", judged: false },
					};
				}
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
					...(error instanceof SystemOneReviewError || error instanceof SystemOneObserverError
						? { receipts: error.receipts }
						: {}),
					accepted: input.action === "vision" ? null : false,
					...(input.action === "vision"
						? { kind: "system_one_vision", advisoryOnly: true, experimental: true }
						: {}),
					costStatus: usageProjection?.costStatus ?? "unpriced",
					...(usageProjection?.costProvenance ? { costProvenance: usageProjection.costProvenance } : {}),
					error: message,
					...(imageManifest ? { imageManifest } : {}),
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
				// Image bytes are retained once in evidence, never duplicated into transcript metadata.
				const holder: { details: unknown } = {
					details: { ...(input.action === "vision" ? summary : record), evidence },
				};
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
					...(reviewerRecordsUsage ? {} : { usage: usageProjection?.usage }),
				};
			} catch {
				return {
					isError: true,
					content: [
						{ type: "text" as const, text: "System One evidence could not be retained; no result is approved." },
					],
					details: {
						accepted: input.action === "vision" ? null : false,
						...(input.action === "vision" ? { advisoryOnly: true, experimental: true } : {}),
						costStatus: usageProjection?.costStatus ?? "unpriced",
						...(usageProjection?.costProvenance ? { costProvenance: usageProjection.costProvenance } : {}),
					},
					...(reviewerRecordsUsage ? {} : { usage: usageProjection?.usage }),
				};
			}
		},
	};
}
