import { describe, expect, it } from "vitest";
import { AUTONOMY_TELEMETRY_EVENT_TYPES, redactTelemetryValue } from "../src/core/autonomy/telemetry-events.ts";

describe("Autonomy Telemetry Events", () => {
	it("telemetry event family names are stable and exactly match the expected strings", () => {
		expect(AUTONOMY_TELEMETRY_EVENT_TYPES.routeDecision).toBe("autonomy.route_decision");
		expect(AUTONOMY_TELEMETRY_EVENT_TYPES.gateOutcome).toBe("autonomy.gate_outcome");
		expect(AUTONOMY_TELEMETRY_EVENT_TYPES.approvalRequest).toBe("autonomy.approval_request");
		expect(AUTONOMY_TELEMETRY_EVENT_TYPES.evidenceBundle).toBe("autonomy.evidence_bundle");
		expect(AUTONOMY_TELEMETRY_EVENT_TYPES.workerRequest).toBe("autonomy.worker_request");
		expect(AUTONOMY_TELEMETRY_EVENT_TYPES.workerResult).toBe("autonomy.worker_result");
		expect(AUTONOMY_TELEMETRY_EVENT_TYPES.learningDecision).toBe("autonomy.learning_decision");
	});

	it("redactTelemetryValue redacts api keys by key name", () => {
		const original = {
			apiKey: "super-secret-key-123",
			api_key: "another-secret-456",
			normalField: "public-value",
		};
		const redacted = redactTelemetryValue(original) as typeof original;
		expect(redacted.apiKey).toBe("[REDACTED]");
		expect(redacted.api_key).toBe("[REDACTED]");
		expect(redacted.normalField).toBe("public-value");
	});

	it("redactTelemetryValue redacts bearer tokens in strings", () => {
		const original = {
			authHeader: "Bearer sk-12345abcde",
			nested: {
				tokenField: "Bearer xyz",
			},
		};
		const redacted = redactTelemetryValue(original) as typeof original;
		expect(redacted.authHeader).toBe("[REDACTED BEARER TOKEN]");
		expect(redacted.nested.tokenField).toBe("[REDACTED BEARER TOKEN]");
	});

	it("redactTelemetryValue redacts Nested secret values", () => {
		const original = {
			config: {
				nestedInfo: {
					password: "my-password",
					secret: "deeply-nested-secret",
				},
				publicUrl: "https://example.com",
			},
		};
		const redacted = redactTelemetryValue(original) as typeof original;
		expect(redacted.config.nestedInfo.password).toBe("[REDACTED]");
		expect(redacted.config.nestedInfo.secret).toBe("[REDACTED]");
		expect(redacted.config.publicUrl).toBe("https://example.com");
	});

	it("redactTelemetryValue does not mutate the original object", () => {
		const original = {
			secret: "do-not-change-me",
			normal: 42,
		};
		const redacted = redactTelemetryValue(original) as typeof original;
		expect(redacted.secret).toBe("[REDACTED]");
		expect(original.secret).toBe("do-not-change-me");
	});

	it("redactTelemetryValue preserves non-secret fields", () => {
		const original = {
			normalNumber: 100,
			normalBoolean: true,
			normalArray: [1, "two", { three: 3 }],
			normalNull: null,
		};
		const redacted = redactTelemetryValue(original) as typeof original;
		expect(redacted).toEqual(original);
	});

	it("redactTelemetryValue redacts obvious sk- api key strings", () => {
		const original = {
			someUrl: "https://api.openai.com",
			rawKey: "sk-proj-someApiKeyLongStringForTesting",
		};
		const redacted = redactTelemetryValue(original) as typeof original;
		expect(redacted.rawKey).toBe("[REDACTED API KEY]");
		expect(redacted.someUrl).toBe("https://api.openai.com");
	});
});
