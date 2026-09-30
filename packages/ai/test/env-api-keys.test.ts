import { afterEach, describe, expect, it, vi } from "vitest";
import { findEnvKeys, getEnvApiKey, getEnvCredentialValues } from "../src/env-api-keys.ts";

const originalCopilotGitHubToken = process.env.COPILOT_GITHUB_TOKEN;
const originalGhToken = process.env.GH_TOKEN;
const originalGitHubToken = process.env.GITHUB_TOKEN;
const originalSakanaApiKey = process.env.SAKANA_API_KEY;
const originalFuguApiKey = process.env.FUGU_API_KEY;
const originalBedrockSkipAuth = process.env.AWS_BEDROCK_SKIP_AUTH;
const originalBedrockEndpoint = process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;

function withoutProcess(callback: () => void): void {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
	Object.defineProperty(globalThis, "process", { value: undefined, configurable: true, writable: true });
	try {
		callback();
	} finally {
		if (descriptor) {
			Object.defineProperty(globalThis, "process", descriptor);
		} else {
			delete (globalThis as { process?: unknown }).process;
		}
	}
}

afterEach(() => {
	vi.unstubAllEnvs();
	if (originalCopilotGitHubToken === undefined) {
		delete process.env.COPILOT_GITHUB_TOKEN;
	} else {
		process.env.COPILOT_GITHUB_TOKEN = originalCopilotGitHubToken;
	}

	if (originalGhToken === undefined) {
		delete process.env.GH_TOKEN;
	} else {
		process.env.GH_TOKEN = originalGhToken;
	}

	if (originalGitHubToken === undefined) {
		delete process.env.GITHUB_TOKEN;
	} else {
		process.env.GITHUB_TOKEN = originalGitHubToken;
	}

	if (originalSakanaApiKey === undefined) {
		delete process.env.SAKANA_API_KEY;
	} else {
		process.env.SAKANA_API_KEY = originalSakanaApiKey;
	}

	if (originalFuguApiKey === undefined) {
		delete process.env.FUGU_API_KEY;
	} else {
		process.env.FUGU_API_KEY = originalFuguApiKey;
	}

	if (originalBedrockSkipAuth === undefined) delete process.env.AWS_BEDROCK_SKIP_AUTH;
	else process.env.AWS_BEDROCK_SKIP_AUTH = originalBedrockSkipAuth;
	if (originalBedrockEndpoint === undefined) delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
	else process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = originalBedrockEndpoint;
});

describe("environment API keys", () => {
	it("does not treat generic GitHub tokens as GitHub Copilot credentials", () => {
		delete process.env.COPILOT_GITHUB_TOKEN;
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toBeUndefined();
		expect(getEnvApiKey("github-copilot")).toBeUndefined();
	});

	it("resolves GitHub Copilot credentials from COPILOT_GITHUB_TOKEN", () => {
		process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
		process.env.GH_TOKEN = "gh-token";
		process.env.GITHUB_TOKEN = "github-token";

		expect(findEnvKeys("github-copilot")).toEqual(["COPILOT_GITHUB_TOKEN"]);
		expect(getEnvApiKey("github-copilot")).toBe("copilot-token");
	});

	it("prefers SAKANA_API_KEY over FUGU_API_KEY for Fugu", () => {
		process.env.SAKANA_API_KEY = "sakana-token";
		process.env.FUGU_API_KEY = "fugu-token";

		expect(findEnvKeys("fugu")).toEqual(["SAKANA_API_KEY", "FUGU_API_KEY"]);
		expect(getEnvApiKey("fugu")).toBe("sakana-token");
	});

	it("falls back to FUGU_API_KEY for Fugu", () => {
		delete process.env.SAKANA_API_KEY;
		process.env.FUGU_API_KEY = "fugu-token";

		expect(findEnvKeys("fugu")).toEqual(["FUGU_API_KEY"]);
		expect(getEnvApiKey("fugu")).toBe("fugu-token");
	});

	it("keeps explicit unauthenticated Bedrock proxy mode outside AWS scope verification", () => {
		process.env.AWS_BEDROCK_SKIP_AUTH = "1";
		process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = "http://localhost:9000/bedrock";

		expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
	});

	it("does not read env keys without a process global", () => {
		withoutProcess(() => {
			expect(findEnvKeys("openai")).toBeUndefined();
			expect(getEnvApiKey("openai")).toBeUndefined();
			expect(getEnvCredentialValues("amazon-bedrock")).toEqual([]);
		});
	});

	it("exposes actual Bedrock environment credentials without profile or authentication status", () => {
		vi.stubEnv("AWS_PROFILE", "ordinary-profile-name");
		vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-aws-access-id");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-aws-secret");
		vi.stubEnv("AWS_SESSION_TOKEN", "fixture-aws-session");
		vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "fixture-bedrock-bearer");
		vi.stubEnv("AWS_CONTAINER_AUTHORIZATION_TOKEN", "fixture-container-auth");

		expect(getEnvApiKey("amazon-bedrock")).toBe("<authenticated>");
		expect(getEnvCredentialValues("amazon-bedrock")).toEqual([
			"fixture-aws-access-id",
			"fixture-aws-secret",
			"fixture-aws-session",
			"fixture-bedrock-bearer",
			"fixture-container-auth",
		]);
		expect(findEnvKeys("amazon-bedrock")).toBeUndefined();
	});

	it("includes alternate environment keys and header tokens without reading another provider", () => {
		vi.stubEnv("SAKANA_API_KEY", "fixture-sakana-key");
		vi.stubEnv("FUGU_API_KEY", "fixture-fugu-key");
		vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "fixture-anthropic-header-token");
		vi.stubEnv("ANTHROPIC_API_KEY", "fixture-anthropic-key");
		vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");

		expect(getEnvCredentialValues("fugu")).toEqual(["fixture-sakana-key", "fixture-fugu-key"]);
		expect(getEnvCredentialValues("anthropic")).toEqual(["fixture-anthropic-header-token", "fixture-anthropic-key"]);
		expect(getEnvCredentialValues("fixture-unknown-provider")).toEqual([]);
	});
});
