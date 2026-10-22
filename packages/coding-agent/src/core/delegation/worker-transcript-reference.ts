/** Canonical, path-free references to a worker transcript's immutable birth identity. */
import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "../orchestration/contracts.ts";

export const WORKER_TRANSCRIPT_REFERENCE_PREFIX = "worker-ref:";
// JSON can escape each UTF-16 code unit as six bytes; the two-string array adds seven bytes.
export const MAX_WORKER_TRANSCRIPT_REFERENCE_CHARACTERS =
	WORKER_TRANSCRIPT_REFERENCE_PREFIX.length + Math.ceil((2 * MAX_ORCHESTRATION_IDENTIFIER_LENGTH * 6 + 7) / 3) * 4;

export interface WorkerTranscriptIdentity {
	readonly parentSessionId: string;
	readonly logicalAgentId: string;
}

function isIdentityPart(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_ORCHESTRATION_IDENTIFIER_LENGTH &&
		value === value.trim()
	);
}

export function encodeWorkerTranscriptReference(identity: WorkerTranscriptIdentity): string {
	if (!isIdentityPart(identity.parentSessionId) || !isIdentityPart(identity.logicalAgentId)) {
		throw new TypeError("Worker transcript birth identity is invalid.");
	}
	const payload = JSON.stringify([identity.parentSessionId, identity.logicalAgentId]);
	return WORKER_TRANSCRIPT_REFERENCE_PREFIX + Buffer.from(payload, "utf8").toString("base64url");
}

/** Reject noncanonical base64, malformed UTF-8/JSON and oversized identities before any filesystem lookup. */
export function parseWorkerTranscriptReference(value: string): WorkerTranscriptIdentity | undefined {
	if (
		!value.startsWith(WORKER_TRANSCRIPT_REFERENCE_PREFIX) ||
		value.length > MAX_WORKER_TRANSCRIPT_REFERENCE_CHARACTERS
	) {
		return undefined;
	}
	const payload = value.slice(WORKER_TRANSCRIPT_REFERENCE_PREFIX.length);
	if (!/^[A-Za-z0-9_-]+$/.test(payload)) return undefined;
	try {
		const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
		if (!Array.isArray(decoded) || decoded.length !== 2) return undefined;
		const [parentSessionId, logicalAgentId] = decoded;
		if (!isIdentityPart(parentSessionId) || !isIdentityPart(logicalAgentId)) return undefined;
		const identity = { parentSessionId, logicalAgentId };
		return encodeWorkerTranscriptReference(identity) === value ? identity : undefined;
	} catch {
		return undefined;
	}
}
