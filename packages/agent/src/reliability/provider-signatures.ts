import type { FailureReason } from "./classifier.ts";

export interface ProviderSignature {
	reason: FailureReason;
	pattern: RegExp;
	/** Evidence citation: sdk package+version+file, corpus capture, or adapter file:line. */
	source: string;
	/** True when the SDK-rendered fixture uses a vendor body shape that still awaits corpus confirmation. */
	provisional?: boolean;
}

/** Provider-thrown-message signatures checked before the generic ladder. */
export const PROVIDER_FAILURE_SIGNATURES: Record<string, readonly ProviderSignature[]> = {
	anthropic: [
		{
			reason: "billing_or_quota",
			pattern: /credit balance is too low/i,
			source: "sdk:@anthropic-ai/sdk@0.91.1 node_modules/@anthropic-ai/sdk/core/error.js",
		},
	],
	mistral: [
		{
			reason: "billing_or_quota",
			pattern: /insufficient credits/i,
			source: "sdk:@mistralai/mistralai@2.2.1 node_modules/@mistralai/mistralai/esm/models/errors/sdkerror.js",
			provisional: true,
		},
	],
	openrouter: [
		{
			reason: "billing_or_quota",
			pattern: /insufficient credits/i,
			source: "sdk:openai@6.26.0 node_modules/openai/core/error.js",
			provisional: true,
		},
	],
	"openai-codex": [
		{
			reason: "billing_or_quota",
			pattern: /You have hit your ChatGPT usage limit/i,
			source: "packages/ai/src/providers/openai-codex-responses.ts:1402",
		},
	],
};
