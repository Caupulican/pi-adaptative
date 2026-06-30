import type { JsonValue } from "./contracts.ts";

export const AUTONOMY_TELEMETRY_EVENT_TYPES = {
	routeDecision: "autonomy.route_decision",
	gateOutcome: "autonomy.gate_outcome",
	approvalRequest: "autonomy.approval_request",
	evidenceBundle: "autonomy.evidence_bundle",
	workerRequest: "autonomy.worker_request",
	workerResult: "autonomy.worker_result",
	learningDecision: "autonomy.learning_decision",
} as const;

export type AutonomyTelemetryEventType =
	(typeof AUTONOMY_TELEMETRY_EVENT_TYPES)[keyof typeof AUTONOMY_TELEMETRY_EVENT_TYPES];

export interface AutonomyTelemetryEvent {
	type: AutonomyTelemetryEventType;
	timestamp: string;
	payload: JsonValue;
}

const SECRET_KEYS = new Set([
	"apikey",
	"api_key",
	"token",
	"accesstoken",
	"refreshtoken",
	"secret",
	"password",
	"authorization",
	"credential",
	"credentials",
]);

const BEARER_RE = /bearer\s+\S+/i;

export function redactTelemetryValue(value: unknown, depth = 0): unknown {
	if (depth > 20) {
		return "[Depth Limit Exceeded]";
	}

	if (typeof value === "string") {
		if (BEARER_RE.test(value)) {
			return "[REDACTED BEARER TOKEN]";
		}
		if (value.startsWith("sk-")) {
			return "[REDACTED API KEY]";
		}
		return value;
	}

	if (value === null || typeof value !== "object") {
		return value;
	}

	if (Array.isArray(value)) {
		const result: unknown[] = [];
		for (const item of value) {
			result.push(redactTelemetryValue(item, depth + 1));
		}
		return result;
	}

	// It is an object
	const obj = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};

	for (const key of Object.keys(obj)) {
		const lowercaseKey = key.toLowerCase();
		if (SECRET_KEYS.has(lowercaseKey)) {
			result[key] = "[REDACTED]";
		} else {
			result[key] = redactTelemetryValue(obj[key], depth + 1);
		}
	}

	return result;
}
