/** A single-use link invitation. Both installations contribute a fresh P-256 key to the
 * reconnect secret. The owner carries the hub public key and a random invitation secret.
 * Capturing that invitation and the public hello cannot recover an enrolled machine's key.
 */
import { createECDH, createHash, hkdfSync } from "node:crypto";
import { isMachineName, newSecret } from "./protocol.ts";

const INVITATION_MS = 10 * 60_000;
const CURVE = "prime256v1";
const KEY = /^[A-Za-z0-9_-]{44}$/; // compressed P-256 public key, 33 bytes
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export interface PendingPairing {
	readonly salt: string;
	readonly expiresAt: number;
}

export interface PairingToken {
	readonly hubName: string;
	readonly name: string;
	readonly salt: string;
	readonly publicKey: string;
}

export function isPairingKey(value: unknown): value is string {
	return typeof value === "string" && KEY.test(value);
}

export function createPairing(hubName: string, name: string) {
	const key = createECDH(CURVE);
	const publicKey = key.generateKeys("base64url", "compressed");
	const salt = newSecret();
	return {
		privateKey: key.getPrivateKey("base64url"),
		pending: { salt, expiresAt: Date.now() + INVITATION_MS },
		token: ["pair1", hubName, name, salt, publicKey].join("."),
	};
}

export function parsePairingToken(raw: string): PairingToken | undefined {
	if (raw.length > 300) return undefined;
	const [version, hubName, name, salt, publicKey, ...extra] = raw.split(".");
	if (version !== "pair1" || extra.length || !isMachineName(hubName) || !isMachineName(name)) return undefined;
	if (!salt || !SECRET.test(salt) || !isPairingKey(publicKey)) return undefined;
	return { hubName, name, salt, publicKey };
}

function reconnectSecret(key: ReturnType<typeof createECDH>, publicKey: string, salt: string): string {
	const shared = key.computeSecret(Buffer.from(publicKey, "base64url"));
	return Buffer.from(hkdfSync("sha256", shared, salt, "pi-link/1 pairing reconnect", 32)).toString("base64url");
}

export function preparePairing(token: PairingToken) {
	const key = createECDH(CURVE);
	const pairingKey = key.generateKeys("base64url", "compressed");
	return { pairingKey, secret: reconnectSecret(key, token.publicKey, token.salt) };
}

export function pairingId(token: PairingToken): string {
	return createHash("sha256")
		.update(JSON.stringify([token.hubName, token.name, token.salt, token.publicKey]))
		.digest("hex");
}

export function offeredPairingSecret(privateKey: string, pending: PendingPairing, peerKey: string): string | undefined {
	if (!isPairingKey(peerKey)) return undefined;
	try {
		const key = createECDH(CURVE);
		key.setPrivateKey(privateKey, "base64url");
		return reconnectSecret(key, peerKey, pending.salt);
	} catch {
		return undefined;
	}
}
