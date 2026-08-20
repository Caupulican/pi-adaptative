import {
	type CredentialProfileRecord,
	type StoredCredentialProfileSummary,
	validateCredentialProfileRecord,
} from "./credential-manager.ts";

export const CREDENTIAL_PROFILE_KEY_PREFIX = "Pi credential profile · ";
const ENVELOPE_KIND = "pi.credential-profile";
const ENVELOPE_SCHEMA = 1;
const MAX_ENVELOPE_BYTES = 1024 * 1024;

interface CredentialProfileEnvelope {
	kind: typeof ENVELOPE_KIND;
	schema: typeof ENVELOPE_SCHEMA;
	profile: string;
	description?: string;
	variables: Array<{ name: string; value: string }>;
	projectKeys: string[];
}

export class CredentialProfileEnvelopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CredentialProfileEnvelopeError";
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function serializeCredentialProfileEnvelope(record: CredentialProfileRecord): string {
	validateCredentialProfileRecord(record);
	const envelope: CredentialProfileEnvelope = {
		kind: ENVELOPE_KIND,
		schema: ENVELOPE_SCHEMA,
		profile: record.profile,
		...(record.description ? { description: record.description } : {}),
		variables: record.variables.map((variable) => ({ ...variable })),
		projectKeys: [...record.projectKeys],
	};
	return JSON.stringify(envelope);
}

export function parseCredentialProfileEnvelope(value: string, expectedProfile: string): CredentialProfileRecord {
	if (Buffer.byteLength(value, "utf8") > MAX_ENVELOPE_BYTES) {
		throw new CredentialProfileEnvelopeError("Credential provider returned an oversized profile record.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value) as unknown;
	} catch {
		throw new CredentialProfileEnvelopeError("Credential provider returned malformed profile data.");
	}
	if (
		!isObject(parsed) ||
		parsed.kind !== ENVELOPE_KIND ||
		parsed.schema !== ENVELOPE_SCHEMA ||
		parsed.profile !== expectedProfile ||
		(parsed.description !== undefined && typeof parsed.description !== "string") ||
		!Array.isArray(parsed.variables) ||
		!Array.isArray(parsed.projectKeys) ||
		!parsed.variables.every(
			(variable) => isObject(variable) && typeof variable.name === "string" && typeof variable.value === "string",
		) ||
		!parsed.projectKeys.every((key) => typeof key === "string")
	) {
		throw new CredentialProfileEnvelopeError("Credential provider returned malformed profile data.");
	}
	const record: CredentialProfileRecord = {
		profile: expectedProfile,
		...(typeof parsed.description === "string" ? { description: parsed.description } : {}),
		variables: parsed.variables.map((variable) => ({
			name: (variable as Record<string, unknown>).name as string,
			value: (variable as Record<string, unknown>).value as string,
		})),
		projectKeys: parsed.projectKeys as string[],
	};
	try {
		return validateCredentialProfileRecord(record);
	} catch {
		for (const variable of record.variables) variable.value = "";
		throw new CredentialProfileEnvelopeError("Credential provider returned malformed profile data.");
	}
}

/** Provider-neutral metadata projection and ordering for stored profiles. */
export function summarizeCredentialProfiles(
	records: Iterable<CredentialProfileRecord>,
): StoredCredentialProfileSummary[] {
	return [...records]
		.map((record) => ({
			profile: record.profile,
			...(record.description ? { description: record.description } : {}),
			variableNames: record.variables.map((variable) => variable.name),
			projectKeys: [...record.projectKeys],
		}))
		.sort((left, right) => left.profile.localeCompare(right.profile));
}
