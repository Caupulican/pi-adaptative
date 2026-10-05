import type { Api, AssistantMessage, Context, Model } from "@caupulican/pi-ai";
import { createEmptyUsage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { redactCredentialContent } from "../src/core/secrets/credential-model-content.ts";
import { createProviderRequestSecretPolicy } from "../src/core/secrets/provider-request-secrets.ts";

const secret = "sk-opaque-credential-shaped-value";
const redact = (text: string) => text.replaceAll(secret, "[redacted]");
const model: Model<Api> = {
	id: "local-crypto",
	name: "Local crypto",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://unused.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 1000,
	maxTokens: 100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("provider cryptographic provenance", () => {
	it.each([false, true])("preserves ciphertext, but not readable secrets, with normalization=%s", (normalize) => {
		const item = { type: "reasoning", encrypted_content: secret, summary: [{ type: "summary_text", text: secret }] };
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(item) }],
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const context: Context = { messages: [message] };
		const policy = createProviderRequestSecretPolicy(context, model, redact);
		const projected = redactCredentialContent(context, redact, policy.contextKey, undefined, policy.contextString);
		const signature = (projected.messages[0] as AssistantMessage).content[0];
		expect(signature?.type).toBe("thinking");
		if (signature?.type !== "thinking") throw new Error("Missing thinking block");
		expect(JSON.parse(signature.thinkingSignature!)).toEqual({
			...item,
			summary: [{ type: "summary_text", text: "[redacted]" }],
		});
		const wire = { input: [item], instructions: secret };
		const payload = normalize ? { toJSON: () => wire } : wire;
		const output = redactCredentialContent(
			payload,
			redact,
			policy.payloadKey,
			policy.payloadObject,
			policy.payloadString,
		);
		expect(output).toEqual({
			input: [{ ...item, summary: [{ type: "summary_text", text: "[redacted]" }] }],
			instructions: "[redacted]",
		});
	});

	it.each(["absent", "different-model", "aborted"] as const)(
		"does not trust ciphertext with %s provenance",
		(kind) => {
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: kind === "different-model" ? "other" : model.id,
				content: [
					{
						type: "thinking",
						thinking: "",
						thinkingSignature: JSON.stringify({ type: "reasoning", encrypted_content: secret }),
					},
				],
				usage: createEmptyUsage(),
				stopReason: kind === "aborted" ? "aborted" : "stop",
				timestamp: 0,
			};
			const policy = createProviderRequestSecretPolicy(
				{ messages: kind === "absent" ? [] : [message] },
				model,
				redact,
			);
			const wire = { input: [{ type: "reasoning", encrypted_content: secret }] };
			expect(
				redactCredentialContent(wire, redact, policy.payloadKey, policy.payloadObject, policy.payloadString)
					.input[0]?.encrypted_content,
			).toBe("[redacted]");
		},
	);

	it("freezes protocol identity and preserves codec keys without exempting new values", () => {
		const mutable = { ...model };
		const message: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			content: [
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: JSON.stringify({ type: "reasoning", encrypted_content: secret }),
				},
			],
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const redactSchema = (text: string) =>
			["input", "type", "reasoning", "encrypted_content"].includes(text) ? "collision" : redact(text);
		const policy = createProviderRequestSecretPolicy({ messages: [message] }, mutable, redactSchema);
		mutable.api = "anthropic-messages";
		const wire = {
			input: [
				{ type: "reasoning", encrypted_content: secret },
				{ type: "reasoning", encrypted_content: `new-${secret}` },
			],
		};
		expect(
			redactCredentialContent(wire, redactSchema, policy.payloadKey, policy.payloadObject, policy.payloadString),
		).toEqual({
			input: [
				{ type: "reasoning", encrypted_content: secret },
				{ type: "reasoning", encrypted_content: "new-[redacted]" },
			],
		});
	});

	it("fails closed before changing signed readable Anthropic thinking", () => {
		const anthropic = { ...model, api: "anthropic-messages" as const, provider: "anthropic" };
		const message: AssistantMessage = {
			role: "assistant",
			api: anthropic.api,
			provider: anthropic.provider,
			model: model.id,
			content: [{ type: "thinking", thinking: secret, thinkingSignature: "trusted-signature" }],
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: 0,
		};
		const context: Context = { messages: [message] };
		const policy = createProviderRequestSecretPolicy(context, anthropic, redact);
		expect(() =>
			redactCredentialContent(context, redact, policy.contextKey, undefined, policy.contextString),
		).toThrow("signed-content");
		const wire = {
			messages: [
				{ role: "assistant", content: [{ type: "thinking", thinking: secret, signature: "trusted-signature" }] },
			],
		};
		expect(() =>
			redactCredentialContent(
				{ toJSON: () => wire },
				redact,
				policy.payloadKey,
				policy.payloadObject,
				policy.payloadString,
			),
		).toThrow("signed-content");
	});
});
