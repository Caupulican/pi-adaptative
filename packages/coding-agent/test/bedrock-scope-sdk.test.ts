import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { fauxAssistantMessage, registerFauxProvider, type SimpleStreamOptions } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const originalAwsProfile = process.env.AWS_PROFILE;
const originalAwsRegion = process.env.AWS_REGION;
const originalBedrockSkipAuth = process.env.AWS_BEDROCK_SKIP_AUTH;
const originalBedrockEndpoint = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;

afterEach(() => {
	if (originalAwsProfile === undefined) delete process.env.AWS_PROFILE;
	else process.env.AWS_PROFILE = originalAwsProfile;
	if (originalAwsRegion === undefined) delete process.env.AWS_REGION;
	else process.env.AWS_REGION = originalAwsRegion;
	if (originalBedrockSkipAuth === undefined) delete process.env.AWS_BEDROCK_SKIP_AUTH;
	else process.env.AWS_BEDROCK_SKIP_AUTH = originalBedrockSkipAuth;
	if (originalBedrockEndpoint === undefined) delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
	else process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = originalBedrockEndpoint;
});

function settingsWithUsEast2Scope(): SettingsManager {
	return SettingsManager.inMemory({
		bedrock: {
			region: "us-east-2",
			profile: "work-sso",
			modelIds: ["us.anthropic.claude-sonnet-5"],
			verifiedAt: "2026-08-03T12:00:00.000Z",
			verification: "identity+control-plane+runtime",
		},
	});
}

function authenticatedRegistry(): ModelRegistry {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("amazon-bedrock", "test-auth");
	return ModelRegistry.inMemory(authStorage);
}

describe("Bedrock SDK scope integration", () => {
	it("binds us-east-2 before service-layer model resolution", async () => {
		delete process.env.AWS_PROFILE;
		delete process.env.AWS_REGION;
		const cwd = mkdtempSync(join(realpathSync.native(tmpdir()), "pi-bedrock-services-"));
		try {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: join(cwd, "agent"),
				authStorage: AuthStorage.inMemory({
					"amazon-bedrock": { type: "api_key", key: "test-auth" },
				}),
				settingsManager: settingsWithUsEast2Scope(),
			});

			expect(
				services.modelRegistry
					.getAvailable()
					.filter((model) => model.provider === "amazon-bedrock")
					.map((model) => model.id),
			).toEqual(["us.anthropic.claude-sonnet-5"]);
			expect(process.env.AWS_REGION).toBe("us-east-2");
			expect(process.env.AWS_PROFILE).toBe("work-sso");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("passes the persisted us-east-2 region and profile on every request", async () => {
		delete process.env.AWS_PROFILE;
		delete process.env.AWS_REGION;
		const registration = registerFauxProvider({
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			models: [{ id: "us.anthropic.claude-sonnet-5" }],
		});
		let capturedOptions: (SimpleStreamOptions & { region?: string; profile?: string }) | undefined;
		registration.setResponses([
			(_context, options) => {
				capturedOptions = options;
				return fauxAssistantMessage("ok");
			},
		]);
		const { session } = await createAgentSession({
			model: registration.getModel(),
			modelRegistry: authenticatedRegistry(),
			settingsManager: settingsWithUsEast2Scope(),
			sessionManager: SessionManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			await session.prompt("hello");
			expect(capturedOptions).toMatchObject({ region: "us-east-2", profile: "work-sso" });
			expect(process.env.AWS_REGION).toBe("us-east-2");
			expect(process.env.AWS_PROFILE).toBe("work-sso");
		} finally {
			session.dispose();
			registration.unregister();
		}
	});

	it("halts an explicit Bedrock request before transport when no verified scope exists", async () => {
		delete process.env.AWS_PROFILE;
		delete process.env.AWS_REGION;
		const registration = registerFauxProvider({
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			models: [{ id: "us.anthropic.claude-sonnet-5" }],
		});
		registration.setResponses([fauxAssistantMessage("must not run")]);
		const { session } = await createAgentSession({
			model: registration.getModel(),
			modelRegistry: authenticatedRegistry(),
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			await expect(session.prompt("hello")).rejects.toThrow("requires a verified profile/region scope");
			expect(registration.state.callCount).toBe(0);
		} finally {
			session.dispose();
			registration.unregister();
		}
	});

	it("preserves explicit unauthenticated proxy mode without claiming an AWS scope", async () => {
		delete process.env.AWS_PROFILE;
		delete process.env.AWS_REGION;
		process.env.AWS_BEDROCK_SKIP_AUTH = "1";
		process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = "http://localhost:9000/bedrock";
		const registration = registerFauxProvider({
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			models: [{ id: "proxy-model" }],
		});
		registration.setResponses([fauxAssistantMessage("proxy ok")]);
		const { session } = await createAgentSession({
			model: registration.getModel(),
			modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
		});

		try {
			await expect(session.prompt("hello")).resolves.toBeUndefined();
			expect(registration.state.callCount).toBe(1);
		} finally {
			session.dispose();
			registration.unregister();
		}
	});
});
