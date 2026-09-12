import { createHash } from "node:crypto";
import type { AuthCredential } from "../auth-storage.ts";

/**
 * The identity a machine-wide provider limit or in-flight count is keyed on: the provider id plus
 * the credential it is reached with (`<provider>#<identity>`), or the bare provider id when no
 * credential is configured. Two accounts on one provider are two budgets; keying on the provider
 * alone made them share a limit one of them never hit.
 *
 * The identity is never a secret: an OAuth account id when the credential carries one, otherwise
 * the `sub` claim of the access token, otherwise a short digest of the credential material.
 */

export interface ProviderAccountKey {
	key: string;
	provider: string;
	account?: string;
}

export function credentialIdentity(credential: AuthCredential | undefined): string | undefined {
	if (!credential) return undefined;
	if (credential.type === "oauth") {
		const accountId = (credential as { accountId?: unknown }).accountId;
		if (typeof accountId === "string" && accountId.trim()) return accountId.trim();
		const sub = jwtSubject(credential.access);
		if (sub) return sub;
		return digest(credential.refresh || credential.access);
	}
	return credential.key ? digest(credential.key) : undefined;
}

function jwtSubject(token: string | undefined): string | undefined {
	if (!token) return undefined;
	const parts = token.split(".");
	if (parts.length < 2) return undefined;
	try {
		const payload = JSON.parse(
			Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
		) as {
			sub?: unknown;
		};
		return typeof payload.sub === "string" && payload.sub.trim() ? payload.sub.trim() : undefined;
	} catch {
		return undefined;
	}
}

function digest(material: string | undefined): string | undefined {
	if (!material) return undefined;
	return createHash("sha256").update(material).digest("hex").slice(0, 12);
}

export function providerAccountKey(provider: string, credential: AuthCredential | undefined): string {
	const identity = credentialIdentity(credential);
	return identity ? `${provider}#${identity}` : provider;
}

export function resolveProviderAccountKey(
	auth: { get(provider: string): AuthCredential | undefined },
	provider: string,
): string {
	let credential: AuthCredential | undefined;
	try {
		credential = auth.get(provider);
	} catch {
		credential = undefined;
	}
	return providerAccountKey(provider, credential);
}

export function splitProviderAccountKey(key: string): ProviderAccountKey {
	const at = key.indexOf("#");
	if (at <= 0) return { key, provider: key };
	return { key, provider: key.slice(0, at), account: key.slice(at + 1) };
}

/** `provider (account 9dcc3287…)` for operator output; the bare provider when unkeyed. */
export function describeProviderAccountKey(key: string): string {
	const parts = splitProviderAccountKey(key);
	if (!parts.account) return parts.provider;
	const short = parts.account.length > 12 ? `${parts.account.slice(0, 8)}…` : parts.account;
	return `${parts.provider} (account ${short})`;
}
