// @isolated: builds the full session stream chain with provider admission state on disk
// @guards packages/coding-agent/src/core/session-stream-chain.ts packages/coding-agent/src/core/security/secret-text.ts

import { join } from "node:path";
import type { StreamFn } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { type Context, fauxAssistantMessage, type Model } from "@caupulican/pi-ai";
import { createAssistantMessageEventStream } from "@caupulican/pi-ai/event-stream";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelAdaptationStore } from "../src/core/models/adaptation-store.ts";
import { ProviderAdmissionLedger } from "../src/core/provider-admission/ledger.ts";
import { ProviderLimitStore } from "../src/core/provider-admission/limit-state.ts";
import { redactCredentialValues } from "../src/core/secrets/credential-manager.ts";
import { buildSessionStreamFn } from "../src/core/session-stream-chain.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { tempDir } from "./temp-dir.ts";

const model: Model<"openai-responses"> = {
	id: "fixture",
	name: "Fixture",
	api: "openai-responses",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const unseenToken = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const hostKnownValue = "correct-horse-battery-staple-9137";

async function sentContext(boundary: boolean, context: Context): Promise<string> {
	const dir = tempDir("pi-chain-token-shapes-");
	let sent = "";
	const baseStreamFn: StreamFn = async (_model, ctx) => {
		sent = JSON.stringify(ctx);
		const stream = createAssistantMessageEventStream();
		const message = fauxAssistantMessage("ok");
		stream.push({ type: "done", reason: "stop", message });
		stream.end();
		return stream;
	};
	const streamFn = buildSessionStreamFn({
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
		...(boundary
			? {
					redactSensitiveText: (text: string, values?: readonly string[]) =>
						redactCredentialValues(text, [hostKnownValue, ...(values ?? [])]),
					getSensitiveValues: () => [hostKnownValue],
				}
			: {}),
	});
	const stream = await streamFn(model, context, {});
	await stream.result();
	return sent;
}

const toolOutputContext = (): Context => ({
	messages: [
		{
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			content: [
				{
					type: "text",
					text: `vault item: ${unseenToken}\nknown: ${hostKnownValue}\nconst password = readPassword();`,
				},
			],
			isError: false,
			timestamp: 1,
		},
	],
});

describe("provider boundary redaction floor", () => {
	it("masks known values and token-shaped keys the host has never seen", async () => {
		const sent = await sentContext(true, toolOutputContext());
		expect(sent).not.toContain(unseenToken);
		expect(sent).not.toContain(hostKnownValue);
		expect(sent).toContain("[REDACTED_SECRET]");
		// Ordinary source text is not rewritten by the shape floor.
		expect(sent).toContain("const password = readPassword();");
	});

	it("masks token shapes even when the session has no credential boundary", async () => {
		const sent = await sentContext(false, toolOutputContext());
		expect(sent).not.toContain(unseenToken);
		expect(sent).toContain("const password = readPassword();");
	});
});
