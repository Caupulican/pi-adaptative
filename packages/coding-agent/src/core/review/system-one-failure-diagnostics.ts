import { isPlainRecord } from "../util/value-guards.ts";
import { SystemOneReviewError } from "./system-one-review-port.ts";

const VALIDATION_CODES = new Set([
	"missing",
	"literal_error",
	"string_type",
	"dict_type",
	"list_type",
	"int_type",
	"float_type",
	"bool_type",
	"extra_forbidden",
	"too_short",
	"too_long",
	"value_error",
	"json_invalid",
	"union_tag_invalid",
	"union_tag_not_found",
	"greater_than",
	"greater_than_equal",
	"less_than",
	"less_than_equal",
	"invalid_request",
	"invalid_request_error",
	"bad_request",
	"context_length_exceeded",
	"max_tokens_exceeded",
	"invalid_api_key",
	"rate_limit_exceeded",
	"insufficient_quota",
]);
const SCHEMA_FIELDS = new Set(["body", "model", "state", "questions", "type", "instructions", "criteria"]);
const FAILURE_KINDS = new Set([
	"invalid_request",
	"invalid_response",
	"unavailable",
	"rate_limit",
	"timeout",
	"cancelled",
	"model_drift",
]);

/** One default diagnostic path, with dynamic question, option and state keys concealed. */
function validationLocation(value: unknown): string {
	if (!Array.isArray(value)) return "unknown";
	const path: string[] = [];
	let inState = false;
	for (const [index, item] of value.slice(0, 12).entries()) {
		const dynamic = inState || value[index - 1] === "questions" || value[index - 1] === "criteria";
		path.push(
			typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && item <= 1_000_000
				? String(item)
				: !dynamic && typeof item === "string" && SCHEMA_FIELDS.has(item)
					? item
					: "*",
		);
		if (!dynamic && item === "state") inState = true;
	}
	if (value.length > 12) path.push("…");
	return path.join("/") || "unknown";
}

/** Metadata only: provider message/detail/input/context and private evidence never enter default diagnostics. */
export function systemOneFailureReasons(error: unknown): readonly string[] {
	const reasons = [error instanceof Error ? error.message : String(error)];
	const receipt =
		error instanceof SystemOneReviewError
			? error
			: error instanceof Error && error.cause instanceof SystemOneReviewError
				? error.cause
				: undefined;
	const kind = isPlainRecord(error) || error instanceof Error ? Reflect.get(error, "kind") : undefined;
	if (receipt) {
		const status = receipt.transportAttempts.at(-1)?.status;
		reasons.push(
			[
				typeof kind === "string" && FAILURE_KINDS.has(kind) ? `failure kind=${kind}` : "failure",
				typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
					? `HTTP ${status}`
					: "HTTP status unknown",
				`attempts=${receipt.transportAttempts.length}`,
			].join(" "),
		);
		if (/^[a-f0-9]{64}$/.test(receipt.requestSha256)) reasons.push(`request sha256=${receipt.requestSha256}`);
		const questions = Object.values(receipt.request.questions);
		reasons.push(
			`request bytes=${Buffer.byteLength(JSON.stringify(receipt.request))} questions=${questions.length} choice=${questions.filter((q) => q.type === "choice").length} noul=${questions.filter((q) => q.type === "noul").length} score=${questions.filter((q) => q.type === "score").length}`,
		);
		const body = receipt.response;
		const entries = isPlainRecord(body)
			? Array.isArray(body.detail)
				? body.detail
				: isPlainRecord(body.detail)
					? [body.detail]
					: Array.isArray(body.errors)
						? body.errors
						: isPlainRecord(body.error)
							? [body.error]
							: []
			: [];
		if (entries.length === 0) reasons.push("provider validation diagnostics unavailable");
		else {
			const available = 6 - reasons.length;
			for (const entry of entries.slice(0, available)) {
				const code = isPlainRecord(entry) ? (entry.type ?? entry.code ?? entry.error_type) : undefined;
				const safeCode = typeof code === "string" && VALIDATION_CODES.has(code) ? code : "unknown validation code";
				reasons.push(
					`validation (${Math.min(entries.length, available)}/${entries.length}): ${safeCode} at ${validationLocation(isPlainRecord(entry) ? entry.loc : undefined)}`,
				);
			}
		}
	} else if (typeof kind === "string" && FAILURE_KINDS.has(kind)) reasons.push(`failure kind=${kind}`);
	return reasons.slice(0, 6).map((line) => {
		const safe = line
			.replace(/apikey_[A-Za-z0-9_-]+/g, "[REDACTED]")
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return safe.length <= 120 ? safe : `${safe.slice(0, 119)}…`;
	});
}
