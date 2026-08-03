import type { Api, Model } from "@caupulican/pi-ai";
import {
	type BedrockModelProbeResult,
	discoverBedrockInferenceProfiles,
	probeBedrockModelAccess,
} from "@caupulican/pi-ai/bedrock-provider";
import type { ModelRegistry } from "./model-registry.ts";
import type { BedrockScopeSettings, SettingsManager } from "./settings-manager.ts";

export const BEDROCK_PROVIDER_ID = "amazon-bedrock";
const BEDROCK_MODEL_FAMILIES = ["sonnet", "opus", "haiku", "fable"] as const;
const MODEL_VERSION_COLLATOR = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function isUnscopedBedrockProxy(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.AWS_BEDROCK_SKIP_AUTH === "1" && Boolean(env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME?.trim());
}

export interface BedrockScopeVerificationRequest {
	region: string;
	profile?: string;
	signal?: AbortSignal;
	credentialMode?: "profile" | "ambient";
}

export interface BedrockScopeVerificationDependencies {
	env?: NodeJS.ProcessEnv;
	discoverInferenceProfiles?: typeof discoverBedrockInferenceProfiles;
	probeModelAccess?: typeof probeBedrockModelAccess;
	now?: () => Date;
}

function normalizeRegion(region: string): string {
	const normalized = region.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(normalized)) {
		throw new Error("AWS region must be an explicit valid region name.");
	}
	return normalized;
}

function normalizeProfile(profile: string | undefined): string | undefined {
	if (profile === undefined) return undefined;
	const normalized = profile.trim();
	if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
		throw new Error("AWS profile must be a non-empty printable name of at most 256 characters.");
	}
	return normalized;
}

function regionInferencePrefix(region: string): string {
	if (region.startsWith("us-gov-")) return "us-gov";
	if (region.startsWith("us-")) return "us";
	if (region.startsWith("eu-")) return "eu";
	if (region.startsWith("ap-")) return "apac";
	return "global";
}

function modelRegionPrefix(modelId: string): string | undefined {
	const marker = ".anthropic.";
	const markerIndex = modelId.indexOf(marker);
	if (markerIndex >= 0) return modelId.slice(0, markerIndex);
	return modelId.startsWith("anthropic.") ? undefined : "foreign";
}

function regionRank(modelId: string, preferredPrefix: string, trustDiscovery: boolean): number | undefined {
	const prefix = modelRegionPrefix(modelId);
	if (prefix === preferredPrefix) return 0;
	if (prefix === "global") return 1;
	if (prefix === undefined) return 2;
	return trustDiscovery && prefix !== "foreign" ? 3 : undefined;
}

function isAnthropicBedrockModel(model: Model<Api>): boolean {
	return (
		model.provider === BEDROCK_PROVIDER_ID && (model.id.startsWith("anthropic.") || model.id.includes(".anthropic."))
	);
}

/** Choose one current model per Claude tier, preferring the region's inference-profile prefix. */
export function selectBedrockTierModelIds(
	models: readonly Model<Api>[],
	discoveredModelIds: readonly string[] | undefined,
	region: string,
): string[] {
	const normalizedRegion = normalizeRegion(region);
	const preferredPrefix = regionInferencePrefix(normalizedRegion);
	const discovered = discoveredModelIds ? new Set(discoveredModelIds) : undefined;
	const candidates = models.filter(
		(model) => isAnthropicBedrockModel(model) && (!discovered || discovered.has(model.id)),
	);
	const selected: string[] = [];
	for (const family of BEDROCK_MODEL_FAMILIES) {
		const familyCandidates = candidates
			.map((model) => ({
				model,
				rank: regionRank(model.id, preferredPrefix, discovered !== undefined),
			}))
			.filter(
				(candidate): candidate is { model: Model<Api>; rank: number } =>
					candidate.rank !== undefined && candidate.model.id.toLowerCase().includes(`claude-${family}`),
			)
			.sort(
				(a, b) =>
					a.rank - b.rank ||
					MODEL_VERSION_COLLATOR.compare(b.model.name, a.model.name) ||
					MODEL_VERSION_COLLATOR.compare(b.model.id, a.model.id),
			);
		if (familyCandidates[0]) selected.push(familyCandidates[0].model.id);
	}
	return selected;
}

function connection(request: BedrockScopeVerificationRequest): BedrockScopeVerificationRequest {
	const region = normalizeRegion(request.region);
	const profile = normalizeProfile(request.profile);
	return {
		region,
		...(profile ? { profile } : {}),
		...(request.signal ? { signal: request.signal } : {}),
	};
}

function noVerifiedModelsError(result: BedrockModelProbeResult): Error {
	const details = result.failures
		.slice(0, 4)
		.map((failure) => `${failure.modelId}: ${failure.reason}`)
		.join("; ");
	return new Error(`No Anthropic Bedrock model passed runtime verification${details ? ` (${details})` : ""}.`);
}

export async function verifyBedrockScope(
	request: BedrockScopeVerificationRequest,
	modelRegistry: ModelRegistry,
	dependencies: BedrockScopeVerificationDependencies = {},
): Promise<BedrockScopeSettings> {
	const normalized = connection(request);
	const env = dependencies.env ?? process.env;
	const bearerToken = request.credentialMode === "profile" ? undefined : env.AWS_BEARER_TOKEN_BEDROCK?.trim();
	const models = modelRegistry.getAll();
	let candidates: string[];
	let verification: BedrockScopeSettings["verification"];

	if (bearerToken) {
		candidates = selectBedrockTierModelIds(models, undefined, normalized.region);
		verification = "runtime";
	} else {
		const discover = dependencies.discoverInferenceProfiles ?? discoverBedrockInferenceProfiles;
		const discovery = await discover(normalized);
		candidates = selectBedrockTierModelIds(models, discovery.inferenceProfileIds, normalized.region);
		verification = "identity+control-plane+runtime";
	}
	if (candidates.length === 0) {
		throw new Error(`No catalogued Anthropic inference profiles were discovered in ${normalized.region}.`);
	}

	const probe = dependencies.probeModelAccess ?? probeBedrockModelAccess;
	const result = await probe({
		...normalized,
		modelIds: candidates,
		...(bearerToken ? { bearerToken } : {}),
	});
	if (result.verifiedModelIds.length === 0) throw noVerifiedModelsError(result);

	return {
		region: normalized.region,
		...(normalized.profile ? { profile: normalized.profile } : {}),
		modelIds: result.verifiedModelIds,
		verifiedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
		verification,
	};
}

function scopeMatchesEnvironment(scope: BedrockScopeSettings, env: NodeJS.ProcessEnv): boolean {
	const environmentRegion = env.AWS_REGION?.trim().toLowerCase();
	if (environmentRegion && environmentRegion !== scope.region) return false;
	const environmentProfile = env.AWS_PROFILE?.trim();
	return environmentProfile === undefined || environmentProfile === scope.profile;
}

function scopedModelIds(scope: BedrockScopeSettings, modelRegistry: ModelRegistry): string[] {
	const modelIds = new Set(scope.modelIds);
	for (const model of modelRegistry.getAll()) {
		if (model.provider !== BEDROCK_PROVIDER_ID) continue;
		const applicationProfile = model.id.match(/^arn:[^:]+:bedrock:([^:]+):[^:]*:application-inference-profile\//i);
		if (applicationProfile?.[1]?.toLowerCase() === scope.region) modelIds.add(model.id);
	}
	return [...modelIds];
}

export function getActiveBedrockScope(
	settingsManager: SettingsManager,
	env: NodeJS.ProcessEnv = process.env,
): BedrockScopeSettings | undefined {
	const scope = settingsManager.getBedrockScopeSettings();
	return scope && scopeMatchesEnvironment(scope, env) ? scope : undefined;
}

/** Bind persisted evidence to both provider visibility and the SDK's exact request environment. */
export function bindSavedBedrockScope(
	settingsManager: SettingsManager,
	modelRegistry: ModelRegistry,
	env: NodeJS.ProcessEnv = process.env,
): BedrockScopeSettings | undefined {
	if (isUnscopedBedrockProxy(env)) {
		modelRegistry.setProviderModelScope(BEDROCK_PROVIDER_ID, undefined);
		return undefined;
	}
	const scope = getActiveBedrockScope(settingsManager, env);
	if (!scope) {
		modelRegistry.setProviderModelScope(BEDROCK_PROVIDER_ID, []);
		return undefined;
	}
	if (!env.AWS_REGION?.trim()) env.AWS_REGION = scope.region;
	if (scope.profile && !env.AWS_PROFILE?.trim()) env.AWS_PROFILE = scope.profile;
	modelRegistry.setProviderModelScope(BEDROCK_PROVIDER_ID, scopedModelIds(scope, modelRegistry));
	return scope;
}

export function activateVerifiedBedrockScope(
	settingsManager: SettingsManager,
	modelRegistry: ModelRegistry,
	scope: BedrockScopeSettings,
	env: NodeJS.ProcessEnv = process.env,
): void {
	settingsManager.setBedrockScopeSettings(scope);
	env.AWS_REGION = scope.region;
	if (scope.profile) env.AWS_PROFILE = scope.profile;
	else delete env.AWS_PROFILE;
	modelRegistry.setProviderModelScope(BEDROCK_PROVIDER_ID, scopedModelIds(scope, modelRegistry));
}
