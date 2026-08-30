import { describe, expect, it } from "vitest";
import { checkProviderAuth, handleAuthCommand, parseAuthCheckArgs, runAuthCheck } from "../src/cli/auth-check.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

describe("auth check CLI (P1i)", () => {
	it("parses auth check CLI arguments", () => {
		const parsed = parseAuthCheckArgs(["--provider", "anthropic", "--json", "--no-refresh"]);
		expect(parsed.provider).toBe("anthropic");
		expect(parsed.json).toBe(true);
		expect(parsed.noRefresh).toBe(true);

		const parsedEquals = parseAuthCheckArgs(["--provider=openai", "--model=deepseek/chat"]);
		expect(parsedEquals.provider).toBe("openai");
		expect(parsedEquals.model).toBe("deepseek/chat");
	});

	it("reports valid stored api_key credentials", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "sk-ant-test" },
		});
		const report = await checkProviderAuth("anthropic", storage);
		expect(report.configured).toBe(true);
		expect(report.source).toBe("stored");
		expect(report.type).toBe("api_key");
		expect(report.status).toBe("valid");
	});

	it("reports missing credentials when not configured", async () => {
		const storage = AuthStorage.inMemory({});
		const report = await checkProviderAuth("unknown-provider", storage);
		expect(report.configured).toBe(false);
		expect(report.source).toBe("none");
		expect(report.status).toBe("missing");
	});

	it("reports valid OAuth credentials when not expired", async () => {
		const storage = AuthStorage.inMemory({
			github: {
				type: "oauth",
				access: "gho_test",
				refresh: "ghr_test",
				expires: Date.now() + 3600 * 1000,
			},
		});
		const report = await checkProviderAuth("github", storage);
		expect(report.configured).toBe(true);
		expect(report.type).toBe("oauth");
		expect(report.status).toBe("valid");
		expect(report.expiresInMs && report.expiresInMs > 0).toBeTruthy();
	});

	it("reports expired OAuth credentials when expired and --no-refresh is set", async () => {
		const storage = AuthStorage.inMemory({
			github: {
				type: "oauth",
				access: "gho_expired",
				refresh: "ghr_expired",
				expires: Date.now() - 1000,
			},
		});
		const report = await checkProviderAuth("github", storage, { noRefresh: true });
		expect(report.configured).toBe(true);
		expect(report.type).toBe("oauth");
		expect(report.status).toBe("expired");
	});

	it("runs full check and returns structured result", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "api_key", key: "sk-ant-test" },
		});
		const result = await runAuthCheck(["--provider", "anthropic", "--json"], storage);
		expect(result.success).toBe(true);
		expect(result.providers.length).toBe(1);
		expect(result.providers[0].provider).toBe("anthropic");
		expect(result.providers[0].status).toBe("valid");
	});

	it("resolves --model to its provider via the model resolver instead of treating the bare id as a provider name (D6)", async () => {
		const storage = AuthStorage.inMemory({
			mistral: { type: "api_key", key: "sk-mistral-test" },
		});
		const modelRegistry = ModelRegistry.inMemory(storage);
		// "devstral-medium-latest" has no slash and is not itself a provider name -- it must resolve
		// through the catalog to provider "mistral", not be checked literally as provider
		// "devstral-medium-latest".
		const result = await runAuthCheck(["--model", "devstral-medium-latest"], storage, modelRegistry);
		expect(result.providers.length).toBe(1);
		expect(result.providers[0].provider).toBe("mistral");
		expect(result.providers[0].status).toBe("valid");
		expect(result.success).toBe(true);
	});

	it("reports an error instead of guessing when --model does not resolve to any known model", async () => {
		const storage = AuthStorage.inMemory({});
		const modelRegistry = ModelRegistry.inMemory(storage);
		const result = await runAuthCheck(["--model", "not-a-real-model-xyz"], storage, modelRegistry);
		expect(result.success).toBe(false);
		expect(result.providers.length).toBe(1);
		expect(result.providers[0].status).toBe("error");
	});

	it("handleAuthCommand returns false for non-auth command and true for auth command", async () => {
		expect(await handleAuthCommand(["other"])).toBe(false);
		expect(await handleAuthCommand(["auth", "--help"])).toBe(true);
	});
});
