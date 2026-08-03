import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	activateVerifiedBedrockScope,
	bindSavedBedrockScope,
	selectBedrockTierModelIds,
	verifyBedrockScope,
} from "../src/core/bedrock-scope.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

function createAuthenticatedRegistry(): ModelRegistry {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("amazon-bedrock", "test-auth");
	authStorage.setRuntimeApiKey("anthropic", "test-auth");
	return ModelRegistry.inMemory(authStorage);
}

afterEach(() => vi.restoreAllMocks());

describe("Bedrock model scope", () => {
	it("hides every Bedrock model until a verified scope exists without affecting direct Anthropic", () => {
		const registry = createAuthenticatedRegistry();
		bindSavedBedrockScope(SettingsManager.inMemory(), registry, {});

		expect(registry.getAvailable().some((model) => model.provider === "amazon-bedrock")).toBe(false);
		expect(registry.getAvailable().some((model) => model.provider === "anthropic")).toBe(true);
	});

	it("restores only exact verified model IDs and applies the saved request region and profile", () => {
		const registry = createAuthenticatedRegistry();
		const settings = SettingsManager.inMemory({
			bedrock: {
				region: "us-east-2",
				profile: "work-sso",
				modelIds: ["us.anthropic.claude-opus-4-6-v1"],
				verifiedAt: "2026-08-03T12:00:00.000Z",
				verification: "identity+control-plane+runtime",
			},
		});
		const env: NodeJS.ProcessEnv = {};

		bindSavedBedrockScope(settings, registry, env);
		registry.refresh();

		expect(env.AWS_REGION).toBe("us-east-2");
		expect(env.AWS_PROFILE).toBe("work-sso");
		expect(
			registry
				.getAvailable()
				.filter((model) => model.provider === "amazon-bedrock")
				.map((model) => model.id),
		).toEqual(["us.anthropic.claude-opus-4-6-v1"]);
	});

	it("invalidates saved model evidence when an explicit environment scope differs", () => {
		const registry = createAuthenticatedRegistry();
		const settings = SettingsManager.inMemory({
			bedrock: {
				region: "us-east-2",
				profile: "work-sso",
				modelIds: ["us.anthropic.claude-opus-4-6-v1"],
				verifiedAt: "2026-08-03T12:00:00.000Z",
				verification: "identity+control-plane+runtime",
			},
		});
		const env: NodeJS.ProcessEnv = { AWS_REGION: "eu-west-1", AWS_PROFILE: "work-sso" };

		bindSavedBedrockScope(settings, registry, env);

		expect(registry.getAvailable().some((model) => model.provider === "amazon-bedrock")).toBe(false);
		expect(env.AWS_REGION).toBe("eu-west-1");
	});

	it("does not let project settings replace the user-owned AWS profile or region", () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				bedrock: {
					region: "us-east-2",
					profile: "work-sso",
					modelIds: ["us.anthropic.claude-sonnet-5"],
					verifiedAt: "2026-08-03T12:00:00.000Z",
					verification: "identity+control-plane+runtime",
				},
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				bedrock: {
					region: "eu-west-1",
					profile: "untrusted-project",
					modelIds: ["eu.anthropic.claude-sonnet-5"],
					verifiedAt: "2026-08-03T12:00:00.000Z",
					verification: "identity+control-plane+runtime",
				},
			}),
		);

		expect(SettingsManager.fromStorage(storage).getBedrockScopeSettings()).toMatchObject({
			region: "us-east-2",
			profile: "work-sso",
			modelIds: ["us.anthropic.claude-sonnet-5"],
		});
	});

	it("preserves explicitly configured application profiles only when their ARN matches us-east-2", () => {
		const registry = createAuthenticatedRegistry();
		const systemModelId = "us.anthropic.claude-sonnet-5";
		const matchingArn = "arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/us-east-2-claude";
		const foreignArn = "arn:aws:bedrock:eu-west-1:123456789012:application-inference-profile/eu-claude";
		registry.registerProvider("amazon-bedrock", {
			api: "bedrock-converse-stream",
			apiKey: "test-auth",
			baseUrl: "https://bedrock-runtime.us-east-2.amazonaws.com",
			models: [systemModelId, matchingArn, foreignArn].map((id) => ({
				id,
				name: id === systemModelId ? "Claude Sonnet 5" : "Claude application profile",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 64_000,
			})),
		});
		const settings = SettingsManager.inMemory({
			bedrock: {
				region: "us-east-2",
				modelIds: [systemModelId],
				verifiedAt: "2026-08-03T12:00:00.000Z",
				verification: "identity+control-plane+runtime",
			},
		});

		bindSavedBedrockScope(settings, registry, {});

		expect(
			registry
				.getAvailable()
				.filter((model) => model.provider === "amazon-bedrock")
				.map((model) => model.id),
		).toEqual([systemModelId, matchingArn]);
	});

	it("selects one newest region-scoped model per Claude tier", () => {
		const registry = createAuthenticatedRegistry();
		const bedrockModels = registry.getAll().filter((model) => model.provider === "amazon-bedrock");
		const discovered = bedrockModels
			.map((model) => model.id)
			.filter(
				(id) =>
					id.startsWith("us.anthropic.") || id.startsWith("eu.anthropic.") || id.startsWith("global.anthropic."),
			);

		expect(selectBedrockTierModelIds(bedrockModels, discovered, "us-east-2")).toEqual([
			"us.anthropic.claude-sonnet-5",
			"us.anthropic.claude-opus-5",
			"us.anthropic.claude-haiku-4-5-20251001-v1:0",
			"us.anthropic.claude-fable-5",
		]);
	});

	it("persists and activates only candidates proven by both discovery and runtime probes", async () => {
		const registry = createAuthenticatedRegistry();
		const settings = SettingsManager.inMemory();
		const env: NodeJS.ProcessEnv = {};
		const discoverInferenceProfiles = vi.fn(async () => ({
			inferenceProfileIds: [
				"us.anthropic.claude-sonnet-5",
				"us.anthropic.claude-opus-5",
				"eu.anthropic.claude-sonnet-5",
			],
		}));
		const probeModelAccess = vi.fn(async ({ modelIds }: { modelIds: string[] }) => ({
			verifiedModelIds: modelIds.filter((id) => id.includes("sonnet")),
			failures: modelIds.filter((id) => !id.includes("sonnet")).map((modelId) => ({ modelId, reason: "denied" })),
		}));

		const scope = await verifyBedrockScope(
			{ region: "us-east-2", profile: "work-sso", credentialMode: "profile" },
			registry,
			{
				env: { ...env, AWS_BEARER_TOKEN_BEDROCK: "must-not-override-sso" },
				discoverInferenceProfiles,
				probeModelAccess,
				now: () => new Date("2026-08-03T12:00:00.000Z"),
			},
		);
		activateVerifiedBedrockScope(settings, registry, scope, env);

		expect(discoverInferenceProfiles).toHaveBeenCalledWith({ region: "us-east-2", profile: "work-sso" });
		expect(probeModelAccess).toHaveBeenCalledWith(
			expect.objectContaining({
				region: "us-east-2",
				profile: "work-sso",
				modelIds: ["us.anthropic.claude-sonnet-5", "us.anthropic.claude-opus-5"],
			}),
		);
		expect(probeModelAccess.mock.calls[0]?.[0]).not.toHaveProperty("bearerToken");
		expect(settings.getBedrockScopeSettings()).toEqual({
			region: "us-east-2",
			profile: "work-sso",
			modelIds: ["us.anthropic.claude-sonnet-5"],
			verifiedAt: "2026-08-03T12:00:00.000Z",
			verification: "identity+control-plane+runtime",
		});
		expect(
			registry
				.getAvailable()
				.filter((model) => model.provider === "amazon-bedrock")
				.map((model) => model.id),
		).toEqual(["us.anthropic.claude-sonnet-5"]);
	});

	it("uses bounded runtime probes for bearer auth without requiring STS control-plane access", async () => {
		const registry = createAuthenticatedRegistry();
		const discoverInferenceProfiles = vi.fn();
		const probeModelAccess = vi.fn(async ({ modelIds }: { modelIds: string[] }) => ({
			verifiedModelIds: [modelIds[0]],
			failures: [],
		}));

		const scope = await verifyBedrockScope({ region: "us-east-2", credentialMode: "ambient" }, registry, {
			env: { AWS_BEARER_TOKEN_BEDROCK: "test-bearer" },
			discoverInferenceProfiles,
			probeModelAccess,
			now: () => new Date("2026-08-03T12:00:00.000Z"),
		});

		expect(discoverInferenceProfiles).not.toHaveBeenCalled();
		expect(probeModelAccess).toHaveBeenCalledWith(
			expect.objectContaining({
				region: "us-east-2",
				bearerToken: "test-bearer",
				modelIds: [
					"us.anthropic.claude-sonnet-5",
					"us.anthropic.claude-opus-5",
					"us.anthropic.claude-haiku-4-5-20251001-v1:0",
					"us.anthropic.claude-fable-5",
				],
			}),
		);
		expect(scope).toMatchObject({
			region: "us-east-2",
			verification: "runtime",
			modelIds: ["us.anthropic.claude-sonnet-5"],
		});
	});
});
