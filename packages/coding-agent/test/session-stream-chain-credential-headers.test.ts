// @isolated: stubs global fetch and exercises mutable credential state
// @guards packages/coding-agent/src/core/session-stream-chain.ts packages/coding-agent/src/core/sdk.ts

import { join } from "node:path";
import type { StreamFn } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { type Context, fauxAssistantMessage, type Model } from "@caupulican/pi-ai";
import { createAssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import { streamSimple } from "@caupulican/pi-ai/stream";
import { createEmptyUsage } from "@caupulican/pi-ai/usage";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import { ProviderAdmissionLedger } from "../src/core/provider-admission/ledger.ts";
import { ProviderLimitStore } from "../src/core/provider-admission/limit-state.ts";
import { buildSessionStreamFn } from "../src/core/session-stream-chain.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { tempDir } from "./temp-dir.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

const access = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.signature`;

const model: Model<"openai-codex-responses"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
	headers: { "x-openai-fedramp": "true" },
};

async function sentFedramp(
	storage: AuthStorage,
	apiKey: string,
	credentialHeaders?: Record<string, string>,
): Promise<string | null> {
	const dir = tempDir("pi-chain-credential-");
	const streamFn = buildSessionStreamFn({
		baseStreamFn: streamSimple,
		settingsManager: SettingsManager.inMemory({}),
		sessionManager: SessionManager.inMemory(dir),
		modelAdaptationStore: new ModelAdaptationStore(join(dir, "adaptation.json"), { readOnly: true }),
		providerAdmissionLedger: new ProviderAdmissionLedger(dir),
		providerLimitStore: new ProviderLimitStore(dir),
		agentDir: dir,
		authStorage: storage,
		getRepetitionGuardRepeats: () => 3,
		getStreamIdleOptionsOverride: () => undefined,
	});
	let sent: string | null | undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: unknown, init?: RequestInit) => {
			sent = new Headers(init?.headers).get("X-OpenAI-Fedramp");
			throw new Error("captured");
		}),
	);
	const stream = await streamFn(
		model,
		{ messages: [] },
		{
			apiKey,
			transport: "sse",
			maxRetries: 0,
			headers: { "X-OpenAI-Fedramp": "true" },
			credentialHeaders,
		},
	);
	await stream.result();
	if (sent === undefined) throw new Error("no request was sent");
	return sent;
}

describe("raw session stream chain credential headers", () => {
	it("keeps frozen routing headers authoritative over later credential-state changes", async () => {
		const credential = {
			type: "oauth" as const,
			access,
			refresh: "refresh",
			expires: Date.now() + 3_600_000,
			accountId: "acct",
		};
		const fedramp = AuthStorage.inMemory({ "openai-codex": { ...credential, chatgptAccountIsFedramp: true } });
		expect(
			await sentFedramp(AuthStorage.inMemory({ "openai-codex": credential }), access, {
				"X-OpenAI-Fedramp": "true",
			}),
		).toBe("true");
		expect(await sentFedramp(fedramp, access)).toBe("true");
		expect(await sentFedramp(fedramp, `${access}-other`)).toBeNull();
	});

	it("redacts request credentials from context text while preserving transport authorization", async () => {
		const dir = tempDir("pi-chain-redaction-");
		let capturedContext: Context | undefined;
		let capturedOptions: Parameters<StreamFn>[2];
		let capturedPayload: unknown;
		let transportFailure: Error | undefined;
		const baseStreamFn: StreamFn = async (_model, context, options) => {
			if (transportFailure) throw transportFailure;
			capturedContext = context;
			capturedOptions = options;
			capturedPayload = await options?.onPayload?.({ prompt: "ordinary payload" }, model);
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("ok") });
			return stream;
		};
		const redactSensitiveText = vi.fn((text: string, additionalValues: readonly string[] = []) =>
			["active-secret", "snapshot-secret", ...additionalValues]
				.filter((value) => value.length > 0)
				.sort((left, right) => right.length - left.length)
				.reduce((result, value) => result.split(value).join("[REDACTED_SECRET]"), text),
		);
		const createSensitiveTextRedactor = vi.fn(
			(additionalValues: readonly string[] = []) =>
				(text: string) =>
					redactSensitiveText(text, additionalValues),
		);
		const input = {
			baseStreamFn,
			settingsManager: SettingsManager.inMemory({}),
			sessionManager: SessionManager.inMemory(dir),
			modelAdaptationStore: new ModelAdaptationStore(join(dir, "adaptation.json"), { readOnly: true }),
			providerAdmissionLedger: new ProviderAdmissionLedger(dir),
			providerLimitStore: new ProviderLimitStore(dir),
			agentDir: dir,
			authStorage: AuthStorage.inMemory({}),
			getRepetitionGuardRepeats: () => 3,
			getStreamIdleOptionsOverride: () => undefined,
			redactSensitiveText,
			createSensitiveTextRedactor,
			getSensitiveValues: vi.fn(() => ["snapshot-secret"]),
		};
		const streamFn = buildSessionStreamFn(input);
		const context: Context = {
			systemPrompt: "ordinary system text active-secret",
			messages: [
				{ role: "user", timestamp: 1, content: "ordinary user text; fedramp true; active-secret request-api-key" },
				{
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "fixture_tool",
							arguments: {
								"active-secret": "snapshot-secret",
								nested: ["header-auth-secret", "ordinary argument"],
							},
						},
					],
					usage: createEmptyUsage(),
					stopReason: "toolUse",
					timestamp: 2,
				},
			],
			tools: [
				{
					name: "fixture_tool",
					description: "Ordinary help; active-secret",
					parameters: Type.Object({
						token: Type.String({
							description: "Header secret is header-auth-secret",
							title: "active-secret",
							default: "snapshot-secret",
							enum: ["header-auth-secret", "ordinary schema value"],
						}),
					}),
				},
			],
		};
		const options = {
			apiKey: "request-api-key",
			credentialHeaders: { Authorization: "Bearer header-auth-secret", "X-OpenAI-Fedramp": "true" },
			headers: { Authorization: "Bearer header-auth-secret", "X-Ordinary": "ordinary-header" },
			onPayload: (payload: unknown) => ({ ...(payload as { prompt: string }), user_data: "snapshot-secret" }),
		};

		const stream = await streamFn(model, context, options);
		await stream.result();

		expect(redactSensitiveText).toHaveBeenCalled();
		expect(input.getSensitiveValues).toHaveBeenCalledOnce();
		expect(createSensitiveTextRedactor).toHaveBeenCalledOnce();
		expect(redactSensitiveText.mock.calls.flatMap(([, values]) => values ?? [])).toContain("header-auth-secret");
		expect(capturedContext).not.toBe(context);
		const projected = JSON.stringify(capturedContext);
		expect(projected).not.toContain("active-secret");
		expect(projected).not.toContain("snapshot-secret");
		expect(projected).not.toContain("request-api-key");
		expect(projected).not.toContain("header-auth-secret");
		expect(projected).toContain("ordinary user text");
		expect(projected).toContain("ordinary argument");
		expect(projected).toContain("fedramp true");
		expect(capturedContext?.messages[1]).toMatchObject({ api: model.api, provider: model.provider, model: model.id });
		expect(capturedOptions?.apiKey).toBe(options.apiKey);
		expect(capturedOptions?.credentialHeaders).toBe(options.credentialHeaders);
		expect(capturedOptions?.headers).toBe(options.headers);
		expect(JSON.stringify(capturedPayload)).not.toContain("snapshot-secret");
		expect(JSON.stringify(capturedPayload)).toContain("ordinary payload");

		const noMatchContext: Context = { messages: [{ role: "user", timestamp: 3, content: "ordinary content only" }] };
		await (await streamFn(model, noMatchContext, {})).result();
		expect(capturedContext).toBe(noMatchContext);

		const unsafeMessage = Object.defineProperty({ role: "user", timestamp: 4 }, "content", {
			enumerable: true,
			get: () => "ordinary local getter snapshot-secret",
		});
		const unsafeContext: Context = { messages: [unsafeMessage as Context["messages"][number]] };
		await (await streamFn(model, unsafeContext, {})).result();
		expect(capturedContext).not.toBe(unsafeContext);
		expect(JSON.stringify(capturedContext)).not.toContain("snapshot-secret");
		expect(JSON.stringify(capturedContext)).toContain("ordinary local getter");

		const sourceCause = new Error("credential source failed while reading snapshot-secret");
		input.getSensitiveValues.mockImplementation(() => {
			throw sourceCause;
		});
		const sourceFailure = await (await streamFn(model, noMatchContext, {})).result();
		expect(sourceFailure.errorMessage).not.toContain("snapshot-secret");
		const causeDescriptor = Object.getOwnPropertyDescriptor(sourceFailure, "cause");
		expect(causeDescriptor?.value).toBe(sourceCause);
		expect(causeDescriptor?.enumerable).toBe(false);
		expect(JSON.stringify(sourceFailure)).not.toContain("snapshot-secret");
		input.getSensitiveValues.mockImplementation(() => ["snapshot-secret"]);

		transportFailure = new Error("ECONNRESET from the provider transport");
		const baselineStreamFn = buildSessionStreamFn({
			...input,
			redactSensitiveText: undefined,
			createSensitiveTextRedactor: undefined,
		});
		const baselineFailure = await (await baselineStreamFn(model, noMatchContext, {})).result();
		const providerFailure = await (await streamFn(model, noMatchContext, {})).result();
		expect(baselineFailure.errorMessage).toContain("ECONNRESET from the provider transport");
		expect(providerFailure.errorMessage).toBe(baselineFailure.errorMessage);
		expect(providerFailure.errorMessage).not.toContain("Credential redaction");
		transportFailure = undefined;

		const controller = new AbortController();
		controller.abort(new Error("cancelled request"));
		const contextBeforeCancellation = capturedContext;
		await expect(streamFn(model, noMatchContext, { signal: controller.signal })).rejects.toThrow("cancelled request");
		expect(capturedContext).toBe(contextBeforeCancellation);
	});

	it("redacts host payload-hook additions on the raw streamSimple transport", async () => {
		const dir = tempDir("pi-chain-payload-redaction-");
		let sentBody = "";
		let sentAuthorization: string | null = null;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: unknown, init?: RequestInit) => {
				sentBody = String(init?.body ?? "");
				sentAuthorization = new Headers(init?.headers).get("Authorization");
				throw new Error("captured provider request");
			}),
		);
		const streamFn = buildSessionStreamFn({
			baseStreamFn: streamSimple,
			settingsManager: SettingsManager.inMemory({}),
			sessionManager: SessionManager.inMemory(dir),
			modelAdaptationStore: new ModelAdaptationStore(join(dir, "adaptation.json"), { readOnly: true }),
			providerAdmissionLedger: new ProviderAdmissionLedger(dir),
			providerLimitStore: new ProviderLimitStore(dir),
			agentDir: dir,
			authStorage: AuthStorage.inMemory({}),
			getRepetitionGuardRepeats: () => 3,
			getStreamIdleOptionsOverride: () => undefined,
			getSensitiveValues: () => ["synthetic-hook-credential"],
			createSensitiveTextRedactor: (additionalValues = []) => {
				const secrets = ["synthetic-hook-credential", ...additionalValues];
				return (text) => secrets.reduce((result, secret) => result.split(secret).join("[REDACTED_SECRET]"), text);
			},
			redactSensitiveText: (text) => text,
		});
		const stream = await streamFn(
			model,
			{ systemPrompt: `ordinary prompt ${access}`, messages: [] },
			{
				apiKey: access,
				transport: "sse",
				maxRetries: 0,
				onPayload: (payload: unknown) => ({
					...(payload as Record<string, unknown>),
					host_extension: "synthetic-hook-credential",
					request_created_at: new Date("2026-09-30T00:00:00.000Z"),
					hook_payload: {
						toJSON: () => ({ ordinary: "ordinary toJSON metadata", extension: "synthetic-hook-credential" }),
					},
				}),
			},
		);
		await stream.result();

		expect(sentBody).toContain("ordinary prompt");
		expect(sentBody).not.toContain(access);
		expect(sentBody).not.toContain("synthetic-hook-credential");
		expect(sentBody).toContain("[REDACTED_SECRET]");
		expect(sentBody).toContain('"request_created_at":"2026-09-30T00:00:00.000Z"');
		expect(sentBody).toContain("ordinary toJSON metadata");
		expect(sentAuthorization).toBe(`Bearer ${access}`);

		const getterStream = await streamFn(
			model,
			{ systemPrompt: "ordinary getter-control prompt", messages: [] },
			{
				apiKey: access,
				transport: "sse",
				maxRetries: 0,
				onPayload: (payload: unknown) => ({
					...(payload as Record<string, unknown>),
					getter_payload: Object.defineProperty({}, "value", {
						enumerable: true,
						get: () => "ordinary getter metadata synthetic-hook-credential",
					}),
				}),
			},
		);
		await getterStream.result();
		expect(sentBody).toContain("ordinary getter metadata [REDACTED_SECRET]");
		expect(sentBody).not.toContain("synthetic-hook-credential");
		expect(sentAuthorization).toBe(`Bearer ${access}`);
	});
});
