/** Configures the shared OAuth loopback owner for Grok's native callback contract. */

import {
	type OAuthLoopbackAuthorization,
	type OAuthLoopbackCallback,
	startOAuthLoopbackCallback,
} from "./loopback-callback.ts";

export interface XaiCallback extends OAuthLoopbackCallback {
	waitForAuthorization(): Promise<OAuthLoopbackAuthorization>;
}

const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";

export async function startXaiCallback(expectedState: string): Promise<XaiCallback> {
	return startOAuthLoopbackCallback({
		expectedState,
		listenHost: CALLBACK_HOST,
		redirectHost: CALLBACK_HOST,
		callbackPath: CALLBACK_PATH,
		environmentError: "xAI OAuth is only available in Node.js environments",
		stateMismatchMessage: "OAuth state mismatch.",
		invalidCallbackMessage: "Invalid xAI authorization callback.",
		completedMessage: "xAI authentication completed. You can close this window.",
		incompleteMessage: "xAI authentication did not complete.",
		serverClosedMessage: "xAI OAuth callback server closed",
		missingPortMessage: "xAI OAuth callback server has no TCP port",
		authorizationDenied: (error, description) => {
			const detail = description ?? error;
			return {
				pageMessage: "xAI authorization was denied.",
				pageDetail: detail,
				errorMessage: `xAI authorization failed: ${detail}`,
			};
		},
	});
}
