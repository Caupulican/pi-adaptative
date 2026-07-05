import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "@google/genai";
import OpenAI from "openai";
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
			message: OpenAI.APIError.generate(
				429,
				{
					error: {
						message: "You exceeded your current quota, please check your plan and billing details.",
						type: "insufficient_quota",
						code: "insufficient_quota",
					},
				},
				undefined,
				headers,
			).message,
			reason: "billing_or_quota",
			genericReason: "billing_or_quota",
		},
		{
			provider: "openai",
			message: OpenAI.APIError.generate(
				429,
				{
					error: {
						message: "Rate limit reached for gpt",
						type: "rate_limit_exceeded",
						code: "rate_limit_exceeded",
					},
				},
				undefined,
				headers,
			).message,
			reason: "rate_limit",
			genericReason: "rate_limit",
		},
		{
			provider: "openrouter",
			message: OpenAI.APIError.generate(
				402,
				{ error: { message: "Insufficient credits. Add more credits to continue.", code: 402 } },
				undefined,
				headers,
			).message,
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
