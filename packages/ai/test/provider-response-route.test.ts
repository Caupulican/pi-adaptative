import { devNull } from "node:os";
import { Readable } from "node:stream";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { afterEach, expect, it, vi } from "vitest";
import { registerBuiltInApiProviders } from "../src/providers/register-builtins.ts";
import {
	getProviderResponseAccount,
	type ProviderResponseAccount,
	providerResponseAccountFor,
	sameProviderResponseRoute,
	stream,
} from "../src/stream.ts";
import type { Api, Model } from "../src/types.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

it.each([
	["azure-openai-responses", "azure-openai-responses", "AZURE_OPENAI_BASE_URL"],
	["fugu", "openai-responses", "FUGU_BASE_URL"],
	["cloudflare-workers-ai", "openai-completions", "PI_TEST_ROUTE"],
] as const)("matches the physical %s endpoint across a configuration change", async (provider, api, variable) => {
	registerBuiltInApiProviders();
	for (const name of [
		"OPENAI_CUSTOM_HEADERS",
		"OPENAI_ORG_ID",
		"OPENAI_PROJECT_ID",
		"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	])
		vi.stubEnv(name, "");
	vi.stubEnv("AZURE_OPENAI_API_VERSION", "v1");
	const origin = "https://offline.invalid";
	const model: Model<Api> = {
		id: "fixture-model",
		name: "Fixture",
		api,
		provider,
		baseUrl: variable === "PI_TEST_ROUTE" ? `${origin}/{PI_TEST_ROUTE}/v1` : `${origin}/declared`,
		reasoning: false,
		input: ["text"],
		contextWindow: 16384,
		maxTokens: 512,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const options = { apiKey: "offline-credential", providerAccountKey: `${provider}#owner` };
	const paths: string[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		expect(url.origin).toBe(origin);
		paths.push(url.pathname);
		return Response.json({ error: { message: "model_not_supported" } }, { status: 400 });
	});
	const receipts: ProviderResponseAccount[] = [];
	for (const name of ["one", "two"]) {
		vi.stubEnv(variable, variable === "PI_TEST_ROUTE" ? name : `${origin}/${name}/v1`);
		const selected = providerResponseAccountFor(model, options)!;
		const response = await stream(
			model,
			{ messages: [{ role: "user", content: "Fixture", timestamp: 1 }] },
			options,
		).result();
		expect(response.errorMessage).toContain("model_not_supported");
		expect(paths.at(-1)).toMatch(new RegExp(`^/${name}/v1/`));
		const receipt = getProviderResponseAccount(response)!;
		expect(sameProviderResponseRoute(receipt, selected)).toBe(true);
		receipts.push(receipt);
	}
	expect(paths).toHaveLength(2);
	expect(sameProviderResponseRoute(receipts[0]!, receipts[1]!)).toBe(false);
	if (api === "azure-openai-responses") {
		vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME_MAP", `${model.id}=other`);
		expect(providerResponseAccountFor(model, options)).toBeUndefined();
		vi.stubEnv("AZURE_OPENAI_BASE_URL", "malformed-fixture-secret");
		const response = await stream(model, { messages: [] }, options).result();
		expect(response.errorMessage).toContain("Invalid Azure OpenAI base URL");
		expect(JSON.stringify(response)).not.toContain("malformed-fixture-secret");
		expect(getProviderResponseAccount(response)).toBeUndefined();
	}
});

it.each(["<authenticated>", "configured-but-unused"])(
	"leaves Bedrock's SDK-owned route unverified with %s auth",
	async (apiKey) => {
		registerBuiltInApiProviders();
		vi.stubEnv("AWS_PROFILE", undefined);
		vi.stubEnv("AWS_CONFIG_FILE", devNull);
		vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", devNull);
		vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
		vi.stubEnv("AWS_BEDROCK_SKIP_AUTH", undefined);
		vi.stubEnv("AWS_BEDROCK_FORCE_HTTP1", "1");
		vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", undefined);
		vi.stubEnv("AWS_ENDPOINT_URL", undefined);
		vi.stubEnv("AWS_USE_FIPS_ENDPOINT", "false");
		vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", "false");
		const model: Model<Api> = {
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			id: "fixture-model",
			name: "Fixture",
			baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			reasoning: false,
			input: ["text"],
			contextWindow: 16384,
			maxTokens: 512,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const options = { apiKey, providerAccountKey: "amazon-bedrock#fixture" };
		const sends: { host: string; expectedBearer: boolean }[] = [];
		let token = "";
		const handler = vi.spyOn(NodeHttpHandler.prototype, "handle").mockImplementation(async (request) => {
			sends.push({
				host: request.hostname,
				expectedBearer: new Headers(request.headers).get("authorization") === `Bearer ${token}`,
			});
			return {
				response: {
					statusCode: 400,
					headers: { "content-type": "application/json", "x-amzn-errortype": "ValidationException" },
					body: Readable.from([
						Buffer.from(JSON.stringify({ message: "This model is not supported for this account." })),
					]),
				},
			};
		});
		try {
			for (const region of ["us-east-1", "us-west-2"]) {
				token = `fixture-bearer-${region}`;
				vi.stubEnv("AWS_REGION", region);
				vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", token);
				const message = await stream(
					model,
					{ messages: [{ role: "user", content: "Fixture", timestamp: 1 }] },
					options,
				).result();
				expect(message.errorMessage).toContain("This model is not supported for this account.");
				expect(getProviderResponseAccount(message)).toBeUndefined();
				expect(providerResponseAccountFor(model, options)).toBeUndefined();
			}
			expect(sends).toEqual([
				{ host: "bedrock-runtime.us-east-1.amazonaws.com", expectedBearer: true },
				{ host: "bedrock-runtime.us-west-2.amazonaws.com", expectedBearer: true },
			]);
		} finally {
			handler.mockRestore();
		}
	},
);
