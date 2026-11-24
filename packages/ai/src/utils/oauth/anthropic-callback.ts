/** Configures the shared OAuth loopback owner for Claude's callback contract. */

import { startOAuthLoopbackCallback } from "./loopback-callback.ts";

interface AnthropicCallback {
	redirectUri: string;
	waitForCode(): Promise<string>;
	finish(success: boolean): void;
}

const CALLBACK_PATH = "/callback";
const FAILED = "Anthropic authentication did not complete.";

export async function startAnthropicCallback(expectedState: string): Promise<AnthropicCallback> {
	const callback = await startOAuthLoopbackCallback({
		expectedState,
		listenHost: typeof process === "undefined" ? "127.0.0.1" : process.env.PI_OAUTH_CALLBACK_HOST || "127.0.0.1",
		redirectHost: "localhost",
		callbackPath: CALLBACK_PATH,
		environmentError: "Anthropic OAuth is only available in Node.js environments",
		stateMismatchMessage: "State mismatch.",
		invalidCallbackMessage: "Invalid authorization callback.",
		completedMessage: "Anthropic authentication completed. You can close this window.",
		incompleteMessage: FAILED,
		serverClosedMessage: "Anthropic OAuth callback server closed",
		missingPortMessage: "Anthropic OAuth callback server has no TCP port",
		acceptEmptyAuthorizationError: true,
		authorizationDenied: () => ({ pageMessage: FAILED, errorMessage: FAILED }),
	});
	return {
		redirectUri: callback.redirectUri,
		waitForCode: async () => (await callback.waitForAuthorization()).code,
		finish: callback.finish,
	};
}
