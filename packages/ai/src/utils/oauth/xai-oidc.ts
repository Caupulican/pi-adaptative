/** Grok OIDC discovery and ID-token verification. */

import type { webcrypto } from "node:crypto";
import { readBoundedResponseText } from "../../providers/account-request.ts";
import { createOAuthRequestSignal } from "./request-signal.ts";

const MAX_OIDC_RESPONSE_BYTES = 64 * 1024;
const CLOCK_SKEW_SECONDS = 60;

type JsonObject = Record<string, unknown>;

export interface XaiOidcDiscovery {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	jwksUri: string;
	idTokenAlgorithms: readonly string[];
}

function requiredString(body: JsonObject, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid xAI OIDC discovery field: ${field}`);
	return value;
}

function trustedProtocolUrl(raw: string, issuer: string, field: string): string {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Invalid xAI OIDC discovery field: ${field}`);
	}
	const localIssuer = issuer === "http://localhost:22255";
	if (url.protocol !== "https:" && !(localIssuer && url.protocol === "http:" && url.hostname === "localhost")) {
		throw new Error(`Untrusted xAI OIDC discovery field: ${field}`);
	}
	return url.href;
}

async function getJson(url: string, signal?: AbortSignal): Promise<JsonObject> {
	const requestSignal = createOAuthRequestSignal(signal);
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { Accept: "application/json" },
			redirect: "error",
			signal: requestSignal,
		});
	} catch (error) {
		signal?.throwIfAborted();
		throw error;
	}
	try {
		const text = await readBoundedResponseText(response, MAX_OIDC_RESPONSE_BYTES);
		requestSignal.throwIfAborted();
		if (text === undefined) throw new Error(`xAI OIDC response exceeded the 64 KiB limit (HTTP ${response.status})`);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new Error(`xAI OIDC returned invalid JSON (HTTP ${response.status})`);
		}
		if (!response.ok) throw new Error(`xAI OIDC request failed (HTTP ${response.status})`);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error("xAI OIDC returned an invalid object");
		}
		return parsed as JsonObject;
	} finally {
		await response.body?.cancel().catch(() => {});
	}
}

export async function discoverXaiOidc(issuer: string, signal?: AbortSignal): Promise<XaiOidcDiscovery> {
	const discoveryBase = issuer.replace(/\/+$/, "");
	const body = await getJson(`${discoveryBase}/.well-known/openid-configuration`, signal);
	const discoveredIssuer = requiredString(body, "issuer");
	if (discoveredIssuer !== issuer) {
		throw new Error(`Authorization server issuer mismatch: expected ${issuer}`);
	}
	const algorithms = body.id_token_signing_alg_values_supported;
	if (!Array.isArray(algorithms) || !algorithms.every((value) => typeof value === "string" && value.length > 0)) {
		throw new Error("Invalid xAI OIDC discovery field: id_token_signing_alg_values_supported");
	}
	return {
		issuer,
		authorizationEndpoint: trustedProtocolUrl(
			requiredString(body, "authorization_endpoint"),
			issuer,
			"authorization_endpoint",
		),
		tokenEndpoint: trustedProtocolUrl(requiredString(body, "token_endpoint"), issuer, "token_endpoint"),
		jwksUri: trustedProtocolUrl(requiredString(body, "jwks_uri"), issuer, "jwks_uri"),
		idTokenAlgorithms: algorithms,
	};
}

function decodeJwtPart(part: string, label: string): JsonObject {
	try {
		const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
	} catch {
		// The stable error below does not expose token contents.
	}
	throw new Error(`xAI OIDC id_token has an invalid ${label}`);
}

function verificationAlgorithm(alg: string): {
	importAlgorithm: webcrypto.RsaHashedImportParams | webcrypto.EcKeyImportParams | webcrypto.Algorithm;
	verifyAlgorithm: webcrypto.RsaPssParams | webcrypto.EcdsaParams | webcrypto.Algorithm;
} {
	switch (alg) {
		case "RS256":
		case "RS384":
		case "RS512": {
			const hash = `SHA-${alg.slice(2)}`;
			return {
				importAlgorithm: { name: "RSASSA-PKCS1-v1_5", hash },
				verifyAlgorithm: { name: "RSASSA-PKCS1-v1_5" },
			};
		}
		case "PS256":
		case "PS384":
		case "PS512": {
			const bits = Number(alg.slice(2));
			return {
				importAlgorithm: { name: "RSA-PSS", hash: `SHA-${bits}` },
				verifyAlgorithm: { name: "RSA-PSS", saltLength: bits / 8 },
			};
		}
		case "ES256":
			return {
				importAlgorithm: { name: "ECDSA", namedCurve: "P-256" },
				verifyAlgorithm: { name: "ECDSA", hash: "SHA-256" },
			};
		case "ES384":
			return {
				importAlgorithm: { name: "ECDSA", namedCurve: "P-384" },
				verifyAlgorithm: { name: "ECDSA", hash: "SHA-384" },
			};
		case "ES512":
			return {
				importAlgorithm: { name: "ECDSA", namedCurve: "P-521" },
				verifyAlgorithm: { name: "ECDSA", hash: "SHA-512" },
			};
		case "EdDSA":
			return { importAlgorithm: { name: "Ed25519" }, verifyAlgorithm: { name: "Ed25519" } };
		default:
			throw new Error(`OIDC id_token uses unsupported algorithm: ${alg}`);
	}
}

function numericClaim(claims: JsonObject, name: string): number | undefined {
	const value = claims[name];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export async function verifyXaiIdToken(options: {
	token: string;
	discovery: XaiOidcDiscovery;
	clientId: string;
	nonce: string;
	signal?: AbortSignal;
}): Promise<JsonObject> {
	const parts = options.token.split(".");
	if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("xAI OIDC id_token is malformed");
	const header = decodeJwtPart(parts[0]!, "header");
	const claims = decodeJwtPart(parts[1]!, "claims");
	const kid = header.kid;
	if (typeof kid !== "string" || !kid) throw new Error("OIDC id_token missing kid header");
	const alg = header.alg;
	if (typeof alg !== "string" || !options.discovery.idTokenAlgorithms.includes(alg)) {
		throw new Error(`OIDC id_token uses unsupported algorithm: ${String(alg)}`);
	}
	const algorithms = verificationAlgorithm(alg);
	const jwks = await getJson(options.discovery.jwksUri, options.signal);
	const keys = jwks.keys;
	if (!Array.isArray(keys)) throw new Error("xAI OIDC JWKS response is invalid");
	const jwk = keys.find(
		(value): value is webcrypto.JsonWebKey & JsonObject =>
			!!value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			(value as JsonObject).kid === kid &&
			((value as JsonObject).alg === undefined || (value as JsonObject).alg === alg) &&
			((value as JsonObject).use === undefined || (value as JsonObject).use === "sig"),
	);
	if (!jwk) throw new Error("xAI OIDC id_token signing key was not found");
	let verified = false;
	try {
		const key = await crypto.subtle.importKey("jwk", jwk, algorithms.importAlgorithm, false, ["verify"]);
		options.signal?.throwIfAborted();
		verified = await crypto.subtle.verify(
			algorithms.verifyAlgorithm,
			key,
			Buffer.from(parts[2]!, "base64url"),
			new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
		);
		options.signal?.throwIfAborted();
	} catch {
		options.signal?.throwIfAborted();
		throw new Error("OIDC id_token validation failed");
	}
	if (!verified) throw new Error("OIDC id_token validation failed");

	if (claims.iss !== options.discovery.issuer) throw new Error("xAI OIDC id_token issuer mismatch");
	const audience = claims.aud;
	if (
		!(
			(typeof audience === "string" && audience === options.clientId) ||
			(Array.isArray(audience) && audience.some((value) => value === options.clientId))
		)
	) {
		throw new Error("xAI OIDC id_token audience mismatch");
	}
	if (claims.nonce !== options.nonce) throw new Error("xAI OIDC id_token nonce mismatch");
	const now = Date.now() / 1000;
	const expiresAt = numericClaim(claims, "exp");
	if (expiresAt === undefined || expiresAt + CLOCK_SKEW_SECONDS < now) {
		throw new Error("xAI OIDC id_token is expired");
	}
	const notBefore = numericClaim(claims, "nbf");
	if (notBefore !== undefined && notBefore - CLOCK_SKEW_SECONDS > now) {
		throw new Error("xAI OIDC id_token is not active");
	}
	options.signal?.throwIfAborted();
	return claims;
}
