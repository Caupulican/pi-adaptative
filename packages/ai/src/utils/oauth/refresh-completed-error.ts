import type { OAuthCredentials } from "./types.ts";

/**
 * The token endpoint completed a rotation, but subsequent account discovery failed.
 * Storage hosts must retain these credentials under their normal ownership rules
 * and report the discovery failure separately. A failed token exchange is never
 * represented by this error. Private fields keep credentials out of error logging.
 */
export class OAuthRefreshCompletedError extends Error {
	readonly providerId: string;
	#credentials: OAuthCredentials;

	constructor(providerId: string, credentials: OAuthCredentials, cause: unknown) {
		super(`OAuth refresh for ${providerId} completed, but account discovery failed`, { cause });
		this.name = "OAuthRefreshCompletedError";
		this.providerId = providerId;
		this.#credentials = structuredClone(credentials);
	}

	get credentials(): OAuthCredentials {
		return structuredClone(this.#credentials);
	}
}
