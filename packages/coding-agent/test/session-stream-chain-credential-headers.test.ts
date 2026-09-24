import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import type { Model } from "@caupulican/pi-ai";
import { streamSimple } from "@caupulican/pi-ai/stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import { ProviderAdmissionLedger } from "../src/core/provider-admission/ledger.ts";
import { ProviderLimitStore } from "../src/core/provider-admission/limit-state.ts";
import { buildSessionStreamFn } from "../src/core/session-stream-chain.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const dirs: string[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

async function sentFedramp(storage: AuthStorage, apiKey: string): Promise<string | null> {
	const dir = mkdtempSync(join(tmpdir(), "pi-chain-credential-"));
	dirs.push(dir);
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
			credentialHeaders: { "X-OpenAI-Fedramp": "true" },
		},
	);
	await stream.result();
	if (sent === undefined) throw new Error("no request was sent");
	return sent;
}

describe("raw session stream chain credential headers", () => {
	it("sends the routing header from the stored credential of the exact key, over any caller value", async () => {
		const credential = {
			type: "oauth" as const,
			access,
			refresh: "refresh",
			expires: Date.now() + 3_600_000,
			accountId: "acct",
		};
		const fedramp = AuthStorage.inMemory({ "openai-codex": { ...credential, chatgptAccountIsFedramp: true } });
		expect(await sentFedramp(fedramp, access)).toBe("true");
		expect(await sentFedramp(fedramp, `${access}-other`)).toBeNull();
		expect(await sentFedramp(AuthStorage.inMemory({ "openai-codex": credential }), access)).toBeNull();
	});
});
