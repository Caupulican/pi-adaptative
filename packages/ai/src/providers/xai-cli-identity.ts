import { XAI_CLIENT_CONFIG } from "./xai-client-config.generated.ts";

export const XAI_CLI_PROXY_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const XAI_CLI_VERSION_HEADERS = { "x-grok-client-version": XAI_CLIENT_CONFIG.version } as const;

/** Headers shared by Grok inference and billing requests. */
export function xaiCliHeaders(userId?: string): Record<string, string> {
	return {
		...XAI_CLI_VERSION_HEADERS,
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-client-mode": "interactive",
		...(userId ? { "x-userid": userId } : {}),
	};
}
