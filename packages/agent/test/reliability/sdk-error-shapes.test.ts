import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "@google/genai";
import { SDKError } from "@mistralai/mistralai/models/errors";
import { describe, expect, it } from "vitest";
import { classifyFailure } from "../../src/reliability/classifier.ts";
import { PROVIDER_FAILURE_SIGNATURES } from "../../src/reliability/provider-signatures.ts";

type FixtureExpectation = {
	provider: string;
	message: string;
	reason: ReturnType<typeof classifyFailure>["reason"];
	genericReason: ReturnType<typeof classifyFailure>["reason"];
	provisional?: boolean;
};

const headers = new Headers();
// Exact `.message` shapes emitted by the OpenAI SDK pinned by pi-ai. Keep them as
// fixtures here because pi-agent-core deliberately has no provider-SDK dependency.
const OPENAI_QUOTA_MESSAGE = "429 You exceeded your current quota, please check your plan and billing details.";
const OPENAI_RATE_LIMIT_MESSAGE = "429 Rate limit reached for gpt";
const OPENROUTER_CREDITS_MESSAGE = "402 Insufficient credits. Add more credits to continue.";

function mistralSdkError(status: number, body: object): string {
	return new SDKError("Mistral API error", {
		response: new Response("", { status, headers: { "content-type": "application/json" } }),
		request: new Request("https://api.mistral.ai/v1/chat/completions"),
		body: JSON.stringify(body),
	}).message;
}

function fixtureExpectations(): FixtureExpectation[] {
	return [
		{
			provider: "anthropic",
			message: Anthropic.APIError.generate(
				429,
				{ type: "error", error: { type: "rate_limit_error", message: "Your account has hit a rate limit" } },
				undefined,
				headers,
			).message,
			reason: "rate_limit",
			genericReason: "rate_limit",
		},
		{
			provider: "anthropic",
			message: Anthropic.APIError.generate(
				529,
				{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
				undefined,
				headers,
			).message,
			reason: "overloaded",
			genericReason: "overloaded",
		},
		{
			provider: "anthropic",
			message: Anthropic.APIError.generate(
				400,
				{ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low" } },
				undefined,
				headers,
			).message,
			reason: "billing_or_quota",
			genericReason: "unknown",
		},
		{
			provider: "openai",
			message: OPENAI_QUOTA_MESSAGE,
			reason: "billing_or_quota",
			genericReason: "billing_or_quota",
		},
		{
			provider: "openai",
			message: OPENAI_RATE_LIMIT_MESSAGE,
			reason: "rate_limit",
			genericReason: "rate_limit",
		},
		{
			provider: "mistral",
			message: mistralSdkError(429, { message: "Rate limit exceeded", type: "rate_limit" }),
			reason: "rate_limit",
			genericReason: "rate_limit",
		},
		{
			provider: "mistral",
			message: mistralSdkError(402, {
				message: "Insufficient credits. Please add credits to continue.",
				type: "payment_required",
			}),
			reason: "billing_or_quota",
			genericReason: "unknown",
			provisional: true,
		},
		{
			provider: "openrouter",
			message: OPENROUTER_CREDITS_MESSAGE,
			reason: "billing_or_quota",
			genericReason: "unknown",
			provisional: true,
		},
		{
			provider: "google",
			message: new ApiError({
				status: 429,
				message: "RESOURCE_EXHAUSTED: Quota exceeded for quota metric GenerateContent requests",
			}).message,
			reason: "billing_or_quota",
			genericReason: "billing_or_quota",
		},
		{
			provider: "google",
			message: new ApiError({
				status: 403,
				message: "PERMISSION_DENIED: API key not valid. Please pass a valid API key.",
			}).message,
			reason: "auth",
			genericReason: "auth",
		},
	];
}

const providerRowFixtureCoverage: Record<string, readonly string[]> = {
	anthropic: ["Your credit balance is too low"],
	mistral: ["Insufficient credits"],
	openrouter: ["Insufficient credits"],
	"openai-codex": ["You have hit your ChatGPT usage limit"],
};

describe("SDK-rendered provider error messages", () => {
	it("classifies actual SDK .message output, with generic ladder results pinned first", () => {
		for (const fixture of fixtureExpectations()) {
			expect(classifyFailure({ message: fixture.message }).reason, `${fixture.provider} generic`).toBe(
				fixture.genericReason,
			);
			expect(
				classifyFailure({ provider: fixture.provider, message: fixture.message }).reason,
				fixture.provider,
			).toBe(fixture.reason);
		}
	});

	it("marks the OpenRouter credits body as provisional evidence", () => {
		const openrouter = PROVIDER_FAILURE_SIGNATURES.openrouter?.find((row) =>
			row.pattern.test("Insufficient credits"),
		);
		expect(openrouter?.provisional).toBe(true);
		expect(
			PROVIDER_FAILURE_SIGNATURES.mistral?.find((row) => row.pattern.test("Insufficient credits"))?.provisional,
		).toBe(true);
	});

	it("keeps provider signature rows paired with executable fixtures", () => {
		for (const [provider, rows] of Object.entries(PROVIDER_FAILURE_SIGNATURES)) {
			for (const row of rows) {
				const fixtures = providerRowFixtureCoverage[provider] ?? [];
				expect(
					fixtures.some((literal) => row.pattern.test(literal)),
					`${provider} ${row.pattern.toString()} lacks a fixture mapping`,
				).toBe(true);
			}
		}
	});
});
