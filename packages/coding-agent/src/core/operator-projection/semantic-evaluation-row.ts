/** Decodes stored semantic evaluation rows, retaining verdicts from older ledger layouts and optional receipt links. */
import { isReceiptCount, isReceiptText } from "../review/typesafe-usage-receipt-codec.ts";
import type {
	SemanticDecisionTrace,
	SemanticQuestionState,
	SemanticUsageReference,
} from "../system-one/semantic-evaluation-ledger.ts";
import type { SemanticEvaluationLedgerRow } from "./decision-ledger-store.ts";

export function asInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asText(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** A legacy or malformed optional attribution field cannot hide the verdict. */
function parseUsageReferences(raw: string | undefined): SemanticUsageReference[] | undefined {
	if (!raw) return undefined;
	try {
		const refs: unknown = JSON.parse(raw);
		if (
			Array.isArray(refs) &&
			refs.every(
				(ref) =>
					ref &&
					isReceiptText(ref.reportId) &&
					isReceiptText(ref.provider) &&
					isReceiptText(ref.model) &&
					isReceiptCount(ref.attempt),
			)
		)
			return refs;
	} catch {
		// A corrupt optional column does not erase the rest of the row.
	}
	return undefined;
}

export function semanticEvaluationRows(
	rows: readonly Record<string, unknown>[],
	sessionId: string,
): SemanticEvaluationLedgerRow[] {
	const out: SemanticEvaluationLedgerRow[] = [];
	for (const row of rows) {
		const evaluationId = asText(row.evaluation_id);
		const programId = asText(row.program_id);
		const label = asText(row.label);
		const startedAt = asInteger(row.started_at);
		const cwd = asText(row.cwd);
		if (
			evaluationId === undefined ||
			programId === undefined ||
			label === undefined ||
			startedAt === undefined ||
			cwd === undefined
		)
			continue;
		const outcome = asText(row.outcome);
		let reasons: string[] | undefined;
		const rawReasons = asText(row.reasons);
		if (rawReasons !== undefined) {
			try {
				const parsed: unknown = JSON.parse(rawReasons);
				if (Array.isArray(parsed)) reasons = parsed.filter((item): item is string => typeof item === "string");
			} catch {
				reasons = undefined;
			}
		}
		const endedAt = asInteger(row.ended_at);
		const verdict = asText(row.verdict);
		let questionStates: SemanticQuestionState[] | undefined;
		const rawQuestionStates = asText(row.question_states);
		if (rawQuestionStates !== undefined) {
			try {
				const parsed: unknown = JSON.parse(rawQuestionStates);
				if (
					Array.isArray(parsed) &&
					parsed.every(
						(item) =>
							typeof item === "object" &&
							item !== null &&
							typeof item.question === "string" &&
							typeof item.uncertain === "boolean" &&
							(item.text === undefined || typeof item.text === "string"),
					)
				)
					questionStates = parsed;
			} catch {
				questionStates = undefined;
			}
		}
		// A trace that does not parse is dropped; it never makes the row, or the store, unreadable.
		let trace: SemanticDecisionTrace | undefined;
		const rawTrace = asText(row.trace);
		if (rawTrace !== undefined) {
			try {
				const parsed: unknown = JSON.parse(rawTrace);
				if (
					typeof parsed === "object" &&
					parsed !== null &&
					typeof (parsed as { decision?: unknown }).decision === "string" &&
					["gates", "judgments", "facts"].every((key) => {
						const list = (parsed as Record<string, unknown>)[key];
						return list === undefined || Array.isArray(list);
					})
				)
					trace = parsed as SemanticDecisionTrace;
			} catch {
				trace = undefined;
			}
		}
		const consequence = asText(row.consequence);
		const model = asText(row.model);
		const provider = asText(row.provider);
		const certificateId = asText(row.certificate_id);
		const usageRefs = parseUsageReferences(asText(row.usage_refs));
		const scopeKind = asText(row.scope_kind);
		const scopeId = asText(row.scope_id);
		const questionNamespace = asText(row.question_namespace);
		out.push({
			evaluationId,
			sessionId,
			cwd,
			programId,
			label,
			startedAt,
			...(consequence !== undefined ? { consequence } : {}),
			...(endedAt !== undefined ? { endedAt } : {}),
			...(outcome === "ok" || outcome === "failed" || outcome === "cancelled" ? { outcome } : {}),
			...(verdict !== undefined ? { verdict } : {}),
			...(reasons !== undefined ? { reasons } : {}),
			...(questionStates !== undefined ? { questionStates } : {}),
			...(trace !== undefined ? { trace } : {}),
			...(model !== undefined ? { model } : {}),
			...(provider !== undefined ? { provider } : {}),
			...(certificateId !== undefined ? { certificateId } : {}),
			...(usageRefs ? { usageRefs } : {}),
			...(scopeId !== undefined && (scopeKind === "session" || scopeKind === "worker-task")
				? { evaluationScope: { kind: scopeKind, id: scopeId } }
				: {}),
			...(questionNamespace !== undefined ? { questionNamespace } : {}),
		});
	}
	return out;
}
