import type { GateOutcomeKind } from "./contracts.ts";

export interface AutonomyStatusSnapshot {
	latestRoute?: { tier: string; reasonCode: string; risk?: string };
	latestGate?: { outcome: string; gate: string; reasonCode: string };
	currentCostUsd?: number;
	dailyCostUsd?: number;
	spawnedCostUsd?: number;
	activeGoal?: { goalId: string; status: string; openRequirements?: number; stallTurns?: number };
	activeLaneCount?: number;
}

/**
 * One bounded entry in AgentSession's gate-outcome history (G8). Codes/ids only — never the gate's
 * human-facing `message`. The most recent entry is the tail; `at` is an ISO timestamp.
 */
export interface GateOutcomeHistoryEntry {
	outcome: GateOutcomeKind;
	gate: string;
	reasonCode: string;
	at: string;
}

export interface DiagnosticEntry {
	title: string;
	summary?: string;
	reasonCode?: string;
	metadata?: Record<string, unknown>;
}

export interface AutonomyDiagnosticSnapshot {
	routes?: readonly DiagnosticEntry[];
	gates?: readonly DiagnosticEntry[];
	costs?: readonly DiagnosticEntry[];
	research?: readonly DiagnosticEntry[];
	delegation?: readonly DiagnosticEntry[];
	learning?: readonly DiagnosticEntry[];
	goals?: readonly DiagnosticEntry[];
}

const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";
const MAX_STRING_LENGTH = 200;
const SENSITIVE_KEYS = ["token", "secret", "key", "credential", "password", "authorization"];
const SENSITIVE_VALUE_REGEX = /bearer\s+[\w\-._]+|api[-_]?key[-_]?[\w\-._]+|sk-[\w\-._]+/i;

function formatCost(value: number): string {
	return Number.isFinite(value) ? `$${value.toFixed(4)}` : "$0.0000";
}

function redactAndTruncateString(value: string): string {
	if (SENSITIVE_VALUE_REGEX.test(value)) return REDACTED;
	if (value.length <= MAX_STRING_LENGTH) return value;
	return `${value.slice(0, MAX_STRING_LENGTH - 1)}…`;
}

function isSensitiveKey(key: string): boolean {
	const lowerKey = key.toLowerCase();
	return SENSITIVE_KEYS.some((sensitiveKey) => lowerKey.includes(sensitiveKey));
}

function sanitizeMetadataValue(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === "string") return redactAndTruncateString(value);
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return CIRCULAR;
	if (Array.isArray(value)) {
		seen.add(value);
		return value.map((item) => sanitizeMetadataValue(item, seen));
	}
	return sanitizeMetadata(value as Record<string, unknown>, seen);
}

function sanitizeMetadata(
	obj: Record<string, unknown>,
	seen: WeakSet<object> = new WeakSet(),
): Record<string, unknown> {
	if (seen.has(obj)) return { value: CIRCULAR };
	seen.add(obj);
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		result[key] = isSensitiveKey(key) ? REDACTED : sanitizeMetadataValue(value, seen);
	}
	return result;
}

export function formatAutonomyStatus(args: AutonomyStatusSnapshot): string {
	const parts: string[] = [];

	if (args.latestRoute) {
		const risk = args.latestRoute.risk ? ` (${redactAndTruncateString(args.latestRoute.risk)})` : "";
		parts.push(
			`Route: ${redactAndTruncateString(args.latestRoute.tier)}${risk} - ${redactAndTruncateString(args.latestRoute.reasonCode)}`,
		);
	}

	if (args.latestGate) {
		parts.push(
			`Gate: ${redactAndTruncateString(args.latestGate.gate)} = ${redactAndTruncateString(args.latestGate.outcome)} (${redactAndTruncateString(args.latestGate.reasonCode)})`,
		);
	}

	const costs: string[] = [];
	if (args.currentCostUsd !== undefined) costs.push(`current: ${formatCost(args.currentCostUsd)}`);
	if (args.dailyCostUsd !== undefined) costs.push(`daily: ${formatCost(args.dailyCostUsd)}`);
	if (args.spawnedCostUsd !== undefined) costs.push(`spawned: ${formatCost(args.spawnedCostUsd)}`);
	if (costs.length > 0) {
		parts.push(`Costs: ${costs.join(", ")}`);
	}

	if (args.activeGoal) {
		const goal = args.activeGoal;
		const requirements = goal.openRequirements !== undefined ? `, open reqs: ${goal.openRequirements}` : "";
		const stalls = goal.stallTurns !== undefined ? `, stalls: ${goal.stallTurns}` : "";
		parts.push(
			`Goal [${redactAndTruncateString(goal.goalId)}]: ${redactAndTruncateString(goal.status)}${requirements}${stalls}`,
		);
	}

	if (args.activeLaneCount !== undefined) {
		parts.push(`Lanes: ${args.activeLaneCount}`);
	}

	if (parts.length === 0) return "Autonomy: idle";
	return parts.join(" | ");
}

function formatDiagnosticSection(name: string, entries?: readonly DiagnosticEntry[]): string | undefined {
	if (!entries || entries.length === 0) return undefined;

	const lines: string[] = [`--- ${name} ---`];
	for (const entry of entries) {
		let header = `- ${redactAndTruncateString(entry.title)}`;
		if (entry.reasonCode) header += ` [${redactAndTruncateString(entry.reasonCode)}]`;
		lines.push(header);

		if (entry.summary) {
			lines.push(`  Summary: ${redactAndTruncateString(entry.summary)}`);
		}

		if (entry.metadata) {
			lines.push(`  Metadata: ${JSON.stringify(sanitizeMetadata(entry.metadata))}`);
		}
	}
	return lines.join("\n");
}

export function formatAutonomyDiagnostics(args: AutonomyDiagnosticSnapshot): string {
	const sections = [
		formatDiagnosticSection("Routes", args.routes),
		formatDiagnosticSection("Gates", args.gates),
		formatDiagnosticSection("Costs", args.costs),
		formatDiagnosticSection("Research", args.research),
		formatDiagnosticSection("Delegation", args.delegation),
		formatDiagnosticSection("Learning", args.learning),
		formatDiagnosticSection("Goals", args.goals),
	].filter((section): section is string => Boolean(section));

	if (sections.length === 0) return "No diagnostics available.";
	return sections.join("\n\n");
}
