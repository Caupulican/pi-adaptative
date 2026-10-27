import { XAI_CLIENT_CONFIG } from "./xai-client-config.generated.ts";

export const XAI_CLI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const XAI_CLI_VERSION_HEADERS = { "x-grok-client-version": XAI_CLIENT_CONFIG.version } as const;

/** Exact reviewed Grok CLI images: a reported version alone cannot admit unreviewed OAuth or request headers. */
export const REVIEWED_XAI_INSTALLATIONS = Object.freeze([
	Object.freeze({
		version: "1.0.62",
		sha256: "2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa",
	}),
	Object.freeze({
		version: "1.0.70",
		sha256: "22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9",
	}),
]);

/** Headers shared by Grok inference and billing requests. */
export function xaiCliHeaders(userId?: string): Record<string, string> {
	return {
		...XAI_CLI_VERSION_HEADERS,
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-client-mode": "interactive",
		...(userId ? { "x-userid": userId } : {}),
	};
}
