import { compactRetainedDetails } from "@caupulican/pi-agent-core/message-retention";
import type { Usage } from "@caupulican/pi-ai";
import { createEmptyUsage } from "@caupulican/pi-ai/usage";
import { type Static, Type } from "typebox";
import { evaluationInputSchema, getEvaluationUsage, reviewInputSchema } from "../review/typesafe-contract.ts";
import type { TypeSafeEvidenceStore } from "../review/typesafe-evidence-store.ts";
import {
	TypeSafeReviewError,
	type TypeSafeReviewer,
	type TypeSafeTransportAttempt,
} from "../review/typesafe-reviewer.ts";

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

function projectUsage(attempts: readonly TypeSafeTransportAttempt[]) {
	const usage = createEmptyUsage();
	let known = false;
	for (const attempt of attempts) {
		const reported = getEvaluationUsage(attempt.response);
		if (!reported) continue;
		known = true;
		usage.input += reported.input_tokens;
		usage.output += reported.output_tokens;
	}
	usage.totalTokens = usage.input + usage.output;
	return known && Number.isSafeInteger(usage.totalTokens) ? usage : undefined;
}

export function createTypeSafeReviewToolDefinition(
	reviewer: TypeSafeReviewer,
	evidenceStore: TypeSafeEvidenceStore,
	reportUsage?: (toolCallId: string, usage: Usage) => void,
) {
	return {
		name: "typesafe_review",
		label: "TypeSafe review",
		description:
			"Use Jev for semantic decisions and independent verification in any domain. Status checks setup. Evaluate batches Choice, Noul and Score questions for classification, detection, routing, ranking, retrieval, extraction, ambiguity, planning, guardrails and evidence checks. Review gates claims at high (0.95) or max (0.99) confidence. Evidence reads retained records by id and offset. Sends explicit state only; does not execute or authorize actions.",
		promptSnippet: "Jev: semantic judgments and high/max claim review.",
		promptGuidelines: [
			"Check typesafe_review status at work start. If enabled, load typesafe-review; use Jev for every applicable semantic uncertainty throughout work, in any domain.",
			"Batch independent narrow questions with complete relevant source, tests, prior findings and limitations; never hide adverse evidence. Reproduce bug candidates before fixing.",
			"Approval requires every expected verdict and high/max confidence; fix findings or add missing evidence. Never reroll unchanged evidence for a better score. Credentials belong in /login typesafe, never tool arguments.",
		],
		parameters,
		executionMode: "sequential" as const,
		async execute(toolCallId: string, input: Static<typeof schema>, signal?: AbortSignal) {
			const onResponse = (attempts: readonly TypeSafeTransportAttempt[]): void => {
				const usage = projectUsage(attempts);
				if (usage) reportUsage?.(toolCallId, usage);
			};
			let record: Record<string, unknown>;
			let isError = false;
			let errorKind: "operation_outcome" | undefined;
			let transportAttempts: TypeSafeTransportAttempt[] = [];
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
					const status = await reviewer.status();
					return { content: [{ type: "text" as const, text: JSON.stringify(status) }], details: status };
				}
				if (input.action === "evaluate" && !input.evaluation)
					throw new Error("evaluation is required for the evaluate action");
				if (input.action === "review" && !input.review) throw new Error("review is required for the review action");
				const result =
					input.action === "evaluate"
						? await reviewer.evaluate(input.evaluation!, signal, onResponse)
						: await reviewer.review(input.review!, signal, onResponse);
				record = { ...result, costStatus: "unpriced" };
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
					costStatus: "unpriced",
					error: message,
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
						costStatus: "unpriced",
					};
				}
				return {
					isError,
					errorKind,
					content: [{ type: "text" as const, text: JSON.stringify({ ...summary, evidence }) }],
					details: holder.details,
					usage: projectUsage(transportAttempts),
				};
			} catch {
				return {
					isError: true,
					content: [
						{ type: "text" as const, text: "TypeSafe evidence could not be retained; review is not accepted." },
					],
					details: { accepted: false, costStatus: "unpriced" },
					usage: projectUsage(transportAttempts),
				};
			}
		},
	};
}
