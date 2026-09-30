// @isolated: exercises process-environment credential discovery.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { resolveConfigValue } from "../src/core/resolve-config-value.ts";
import { SystemOneReviewer } from "../src/core/review/typesafe-reviewer.ts";

const input = {
	state: "ordinary evidence",
	questions: { q: { type: "noul" as const, instructions: "Is the condition present?" } },
};
const response = {
	model: "jev-1.13.0",
	answers: { q: { type: "noul" as const, noul: 1 } },
	usage: { input_tokens: 1, output_tokens: 1 },
};

afterEach(() => vi.unstubAllEnvs());

function boundaryFor(values: readonly string[]) {
	return {
		getSensitiveValues: async () => values,
		redactSensitiveText(text: string, additionalValues: readonly string[] = []) {
			let redacted = text;
			for (const value of additionalValues) redacted = redacted.split(value).join("[REDACTED_SECRET]");
			return redacted;
		},
	};
}

describe("System One credential boundary", () => {
	it("keeps an unselected configured provider credential out of the submitted request", async () => {
		const foreignCredential = "fixture-unselected-provider-credential-without-token-shape";
		let submittedBody = "";
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			submittedBody = String(init?.body ?? "");
			return Response.json(response);
		});
		const reviewer = new SystemOneReviewer({
			getApiKey: async () => "fixture-typesafe-current-key",
			credentialBoundary: boundaryFor([foreignCredential]),
			fetch,
		});

		await reviewer.evaluate({ ...input, state: `Local source: ${foreignCredential}` });

		expect(submittedBody).not.toContain(foreignCredential);
		expect(submittedBody).toContain("Local source: [REDACTED_SECRET]");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("projects credentials containing quotes, backslashes, and newlines from JSON request fields", async () => {
		const foreignCredential = 'fixture-quote-"-slash-\\-line-\n-break';
		let submittedBody = "";
		const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
			submittedBody = String(init?.body ?? "");
			return Response.json(response);
		});
		const reviewer = new SystemOneReviewer({
			getApiKey: async () => "fixture-typesafe-current-key",
			credentialBoundary: boundaryFor([foreignCredential]),
			fetch,
		});

		await reviewer.evaluate({ ...input, state: `Local source: ${foreignCredential}` });

		expect(JSON.parse(submittedBody)).toMatchObject({ state: "Local source: [REDACTED_SECRET]" });
		expect(submittedBody).not.toContain("fixture-quote-");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("redacts configured credentials from retained provider error diagnostics", async () => {
		const foreignCredential = "fixture-foreign-credential-in-provider-error";
		const reviewer = new SystemOneReviewer({
			getApiKey: async () => "fixture-typesafe-current-key",
			credentialBoundary: boundaryFor([foreignCredential]),
			fetch: async () => {
				throw new Error(`TypeSafe HTTP 503: maintenance ${foreignCredential}`);
			},
		});

		await expect(reviewer.evaluate(input)).rejects.toThrow("TypeSafe HTTP 503: maintenance [REDACTED_SECRET]");
	});

	it("retains ordinary evidence and never submits the selected provider key", async () => {
		const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json(response));
		const reviewer = new SystemOneReviewer({
			getApiKey: async () => "fixture-typesafe-current-key",
			fetch,
		});
		await reviewer.evaluate({ ...input, state: "ordinary source evidence" });
		const submittedBody = String(fetch.mock.calls[0]?.[1]?.body ?? "");

		expect(submittedBody).toContain("ordinary source evidence");
		expect(submittedBody).not.toContain("fixture-typesafe-current-key");
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("refuses the currently selected provider credential if it appears in evidence", async () => {
		const fetch = vi.fn(async () => Response.json(response));
		const reviewer = new SystemOneReviewer({
			getApiKey: async () => "fixture-typesafe-current-key",
			fetch,
		});

		await expect(reviewer.evaluate({ ...input, state: "fixture-typesafe-current-key" })).rejects.toThrow(
			"API credential",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("refuses a selected credential after JSON escaping", async () => {
		const selectedCredential = 'fixture-selected-quote-"-slash-\\-newline-\n';
		const fetch = vi.fn(async () => Response.json(response));
		const reviewer = new SystemOneReviewer({
			getApiKey: async () => selectedCredential,
			fetch,
		});

		await expect(reviewer.evaluate({ ...input, state: selectedCredential })).rejects.toThrow("API credential");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("enumerates stored, OAuth, runtime, environment, and provider-config credential values", () => {
		vi.stubEnv("OPENAI_API_KEY", "fixture-environment-credential");
		const ordinaryConfigValue = "fixture-ordinary-nonsecret-config-output";
		expect(resolveConfigValue(`!printf ${ordinaryConfigValue}`)).toBe(ordinaryConfigValue);
		const authStorage = AuthStorage.inMemory({
			stored: { type: "api_key", key: "fixture-stored-credential" },
			oauth: {
				type: "oauth",
				access: "fixture-oauth-access-value",
				refresh: "fixture-oauth-refresh-value",
				expires: Date.now() + 60_000,
				client_secret: "fixture-oauth-client-secret",
			},
		});
		authStorage.setRuntimeApiKey("runtime-provider", "fixture-runtime-credential");
		const registry = ModelRegistry.inMemory(authStorage);
		registry.registerProvider("credential-audit-provider", {
			api: "openai-completions",
			baseUrl: "https://example.invalid/v1",
			apiKey: "fixture-provider-config-credential",
			headers: {
				Authorization: "Bearer fixture-header-credential",
				"X-OpenAI-Fedramp": "true",
				"X-OpenAI-Mode": `!printf ${ordinaryConfigValue}`,
			},
			models: [
				{
					id: "audit-model",
					name: "Audit model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 16_384,
					maxTokens: 1_024,
				},
			],
		});

		const authValues = authStorage.getKnownCredentialValues(["openai"]);
		const registryValues = registry.getKnownCredentialValues();
		expect(authValues).toEqual(
			expect.arrayContaining([
				"fixture-stored-credential",
				"fixture-oauth-access-value",
				"fixture-oauth-refresh-value",
				"fixture-oauth-client-secret",
				"fixture-runtime-credential",
				"fixture-environment-credential",
			]),
		);
		expect(registryValues).toEqual(
			expect.arrayContaining(["fixture-provider-config-credential", "fixture-header-credential"]),
		);
		expect(registryValues).not.toContain("true");
		expect(registryValues).not.toContain(ordinaryConfigValue);
	});

	it("does not treat ambient authentication status as credential text", () => {
		vi.stubEnv("AWS_PROFILE", "fixture-profile-name");
		const authStorage = AuthStorage.inMemory();

		expect(authStorage.getKnownCredentialValues(["amazon-bedrock"])).not.toContain("<authenticated>");
		expect(authStorage.getKnownCredentialValues(["amazon-bedrock"])).not.toContain("fixture-profile-name");
	});

	it("enumerates ambient AWS credential values while excluding the profile name and auth sentinel", () => {
		vi.stubEnv("AWS_PROFILE", "fixture-ambient-profile-name");
		vi.stubEnv("AWS_ACCESS_KEY_ID", "fixture-aws-access-key-id");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "fixture-aws-secret-access-key");
		vi.stubEnv("AWS_SESSION_TOKEN", "fixture-aws-session-token");
		vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "fixture-bedrock-bearer-token");
		const authStorage = AuthStorage.inMemory();
		const values = authStorage.getKnownCredentialValues(["amazon-bedrock"]);

		expect(values).toEqual(
			expect.arrayContaining([
				"fixture-aws-access-key-id",
				"fixture-aws-secret-access-key",
				"fixture-aws-session-token",
				"fixture-bedrock-bearer-token",
			]),
		);
		expect(values).not.toContain("fixture-ambient-profile-name");
		expect(values).not.toContain("<authenticated>");
	});

	it("redacts a resolved API key without redacting its environment-reference metadata", () => {
		vi.stubEnv("FIXTURE_CONFIGURED_SECRET", "fixture-resolved-configured-secret-value");
		const authStorage = AuthStorage.inMemory({
			configured: { type: "api_key", key: "$FIXTURE_CONFIGURED_SECRET" },
		});

		expect(authStorage.getKnownCredentialValues()).toContain("fixture-resolved-configured-secret-value");
		expect(authStorage.getKnownCredentialValues()).not.toContain("$FIXTURE_CONFIGURED_SECRET");
	});
});
