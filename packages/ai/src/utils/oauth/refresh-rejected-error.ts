export type OAuthRefreshRejection = "expired" | "reused" | "revoked" | "rejected";

export class OAuthRefreshRejectedError extends Error {
	readonly providerId: string;
	readonly reason: OAuthRefreshRejection;

	constructor(providerId: string, reason: OAuthRefreshRejection, message: string) {
		super(message);
		this.name = "OAuthRefreshRejectedError";
		this.providerId = providerId;
		this.reason = reason;
	}
}
