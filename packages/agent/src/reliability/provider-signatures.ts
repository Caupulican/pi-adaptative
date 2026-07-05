import type { FailureReason } from "./classifier.ts";

export interface ProviderSignature {
	reason: FailureReason;
	pattern: RegExp;
	/** Where this pattern was observed: adapter file:line, or "incident YYYY-MM-DD". */
	source: string;
}

/** Provider-thrown-message signatures checked before the generic ladder. */
export const PROVIDER_FAILURE_SIGNATURES: Record<string, readonly ProviderSignature[]> = {
	"openai-codex": [
		{
			reason: "billing_or_quota",
			pattern: /You have hit your ChatGPT usage limit/i,
			source: "packages/ai/src/providers/openai-codex-responses.ts:1402",
		},
	],
};
