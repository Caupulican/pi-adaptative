import { BedrockClient, ListInferenceProfilesCommand } from "@aws-sdk/client-bedrock";
import {
	BedrockRuntimeClient,
	type BedrockRuntimeClientConfig,
	ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

const MAX_DISCOVERY_PAGES = 100;
const MAX_PROBE_MODELS = 16;
const MAX_FAILURE_REASON_CHARS = 240;

export interface BedrockScopeConnection {
	region: string;
	profile?: string;
	signal?: AbortSignal;
}

export interface BedrockInferenceProfilePage {
	inferenceProfileIds: string[];
	nextToken?: string;
}

export interface BedrockScopeOperations {
	getCallerIdentity(connection: BedrockScopeConnection): Promise<void>;
	listInferenceProfiles(
		connection: BedrockScopeConnection & { nextToken?: string },
	): Promise<BedrockInferenceProfilePage>;
	probeModel(connection: BedrockScopeConnection & { modelId: string; bearerToken?: string }): Promise<void>;
}

export interface BedrockModelProbeFailure {
	modelId: string;
	reason: string;
}

export interface BedrockModelProbeResult {
	verifiedModelIds: string[];
	failures: BedrockModelProbeFailure[];
}

function normalizeConnection(connection: BedrockScopeConnection): BedrockScopeConnection {
	const region = connection.region.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(region)) {
		throw new Error("AWS region must be an explicit valid region name.");
	}
	const profile = connection.profile?.trim();
	if (
		profile !== undefined &&
		(profile.length === 0 || profile.length > 256 || /[\u0000-\u001f\u007f]/.test(profile))
	) {
		throw new Error("AWS profile must be a non-empty printable name of at most 256 characters.");
	}
	return {
		region,
		...(profile ? { profile } : {}),
		...(connection.signal ? { signal: connection.signal } : {}),
	};
}

function commandOptions(signal: AbortSignal | undefined): { abortSignal?: AbortSignal } | undefined {
	return signal ? { abortSignal: signal } : undefined;
}

function createSdkOperations(): BedrockScopeOperations {
	return {
		async getCallerIdentity(connection) {
			const client = new STSClient({ region: connection.region, profile: connection.profile });
			try {
				await client.send(new GetCallerIdentityCommand({}), commandOptions(connection.signal));
			} finally {
				client.destroy();
			}
		},
		async listInferenceProfiles(connection) {
			const client = new BedrockClient({ region: connection.region, profile: connection.profile });
			try {
				const page = await client.send(
					new ListInferenceProfilesCommand({
						typeEquals: "SYSTEM_DEFINED",
						nextToken: connection.nextToken,
					}),
					commandOptions(connection.signal),
				);
				return {
					inferenceProfileIds: (page.inferenceProfileSummaries ?? [])
						.map((profile) => profile.inferenceProfileId?.trim())
						.filter((id): id is string => Boolean(id)),
					...(page.nextToken ? { nextToken: page.nextToken } : {}),
				};
			} finally {
				client.destroy();
			}
		},
		async probeModel(connection) {
			const config: BedrockRuntimeClientConfig = {
				region: connection.region,
				profile: connection.profile,
			};
			if (connection.bearerToken) {
				config.token = { token: connection.bearerToken };
				config.authSchemePreference = ["httpBearerAuth"];
			}
			const client = new BedrockRuntimeClient(config);
			try {
				await client.send(
					new ConverseCommand({
						modelId: connection.modelId,
						messages: [{ role: "user", content: [{ text: "Reply OK" }] }],
						inferenceConfig: { maxTokens: 1 },
					}),
					commandOptions(connection.signal),
				);
			} finally {
				client.destroy();
			}
		},
	};
}

function failureReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() || "Unknown Bedrock error";
	return normalized.slice(0, MAX_FAILURE_REASON_CHARS);
}

export async function discoverBedrockInferenceProfiles(
	connection: BedrockScopeConnection,
	operations: BedrockScopeOperations = createSdkOperations(),
): Promise<{ inferenceProfileIds: string[] }> {
	const normalized = normalizeConnection(connection);
	await operations.getCallerIdentity(normalized);

	const ids = new Set<string>();
	const seenTokens = new Set<string>();
	let nextToken: string | undefined;
	for (let pageIndex = 0; pageIndex < MAX_DISCOVERY_PAGES; pageIndex++) {
		const page = await operations.listInferenceProfiles({ ...normalized, nextToken });
		for (const id of page.inferenceProfileIds) {
			const candidate = id.trim();
			if (candidate.toLowerCase().includes("anthropic")) ids.add(candidate);
		}
		if (!page.nextToken) return { inferenceProfileIds: [...ids] };
		if (seenTokens.has(page.nextToken)) {
			throw new Error("Bedrock profile discovery returned a repeated pagination token.");
		}
		seenTokens.add(page.nextToken);
		nextToken = page.nextToken;
	}
	throw new Error(`Bedrock profile discovery exceeded ${MAX_DISCOVERY_PAGES} pages.`);
}

export async function probeBedrockModelAccess(
	connection: BedrockScopeConnection & { modelIds: string[]; bearerToken?: string },
	operations: BedrockScopeOperations = createSdkOperations(),
): Promise<BedrockModelProbeResult> {
	const normalized = normalizeConnection(connection);
	const modelIds = [...new Set(connection.modelIds.map((id) => id.trim()).filter(Boolean))];
	if (modelIds.length === 0) throw new Error("Bedrock verification requires at least one model candidate.");
	if (modelIds.length > MAX_PROBE_MODELS) {
		throw new Error(`Bedrock verification is bounded to ${MAX_PROBE_MODELS} model candidates.`);
	}

	const verifiedModelIds: string[] = [];
	const failures: BedrockModelProbeFailure[] = [];
	for (const modelId of modelIds) {
		if (normalized.signal?.aborted) {
			throw normalized.signal.reason instanceof Error
				? normalized.signal.reason
				: new Error("Bedrock verification was cancelled.");
		}
		try {
			await operations.probeModel({
				...normalized,
				modelId,
				...(connection.bearerToken ? { bearerToken: connection.bearerToken } : {}),
			});
			verifiedModelIds.push(modelId);
		} catch (error) {
			if (normalized.signal?.aborted) {
				throw normalized.signal.reason instanceof Error
					? normalized.signal.reason
					: new Error("Bedrock verification was cancelled.");
			}
			failures.push({ modelId, reason: failureReason(error) });
		}
	}
	return { verifiedModelIds, failures };
}
