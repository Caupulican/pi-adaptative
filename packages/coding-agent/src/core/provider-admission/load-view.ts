import { describeProviderAccountKey, splitProviderAccountKey } from "./account-key.ts";
import { type EmergencyStopState, readEmergencyStop } from "./emergency-stop.ts";
import { entryKey, type ProviderAdmissionEntry, type ProviderAdmissionLedger } from "./ledger.ts";
import type { ProviderLimitRecord, ProviderLimitStore, ProviderUsageRecord } from "./limit-state.ts";

/** One machine-wide snapshot of provider load: what is in flight, what is limited, what the provider reports, and the stop. */
export interface ProviderLoadView {
	at: number;
	inflight: ProviderAdmissionEntry[];
	limits: ProviderLimitRecord[];
	usage: ProviderUsageRecord[];
	emergencyStop: EmergencyStopState;
	configuredLimits: Readonly<Record<string, number>>;
}

export function buildProviderLoadView(input: {
	agentDir: string;
	ledger: ProviderAdmissionLedger;
	limits: ProviderLimitStore;
	configuredLimits: Readonly<Record<string, number>>;
	now?: () => number;
}): ProviderLoadView {
	return {
		at: (input.now ?? Date.now)(),
		inflight: input.ledger.listInflight(),
		limits: input.limits.list(),
		usage: input.limits.listUsage(),
		emergencyStop: readEmergencyStop(input.agentDir),
		configuredLimits: input.configuredLimits,
	};
}

function seconds(ms: number): string {
	return `${Math.max(0, Math.ceil(ms / 1000))}s`;
}

function describeWindow(window: unknown): string | undefined {
	if (!window || typeof window !== "object") return undefined;
	const w = window as { usedPercent?: unknown; windowMinutes?: unknown; resetsAt?: unknown };
	if (typeof w.usedPercent !== "number") return undefined;
	const minutes = typeof w.windowMinutes === "number" ? `${w.windowMinutes}m` : "window";
	const reset = typeof w.resetsAt === "number" ? ` resets ${new Date(w.resetsAt * 1000).toISOString()}` : "";
	return `${minutes} ${w.usedPercent}% used${reset}`;
}

/** Plain-text rendering for the operator (`/load`). */
export function formatProviderLoadView(view: ProviderLoadView): string {
	const lines: string[] = [];
	const byProvider = new Map<string, ProviderAdmissionEntry[]>();
	for (const entry of view.inflight) {
		const key = entryKey(entry);
		const list = byProvider.get(key) ?? [];
		list.push(entry);
		byProvider.set(key, list);
	}
	lines.push(
		`Provider load — ${view.inflight.length} request${view.inflight.length === 1 ? "" : "s"} in flight machine-wide`,
	);
	for (const [key, entries] of [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const provider = splitProviderAccountKey(key).provider;
		const lanes = { foreground: 0, worker: 0, background: 0 };
		const pids = new Set<number>();
		for (const entry of entries) {
			lanes[entry.lane] += 1;
			pids.add(entry.pid);
		}
		const cap = view.configuredLimits[provider];
		const oldest = Math.min(...entries.map((entry) => Date.parse(entry.startedAt)));
		lines.push(
			`  ${describeProviderAccountKey(key)}: ${entries.length} in flight (${lanes.foreground} foreground, ${lanes.worker} worker, ${lanes.background} background) ` +
				`across ${pids.size} process${pids.size === 1 ? "" : "es"}${cap ? `, limit ${cap}` : ""}, oldest ${seconds(view.at - oldest)} ago`,
		);
	}
	if (view.limits.length > 0) {
		lines.push("Limited:");
		for (const limit of view.limits) {
			lines.push(
				`  ${describeProviderAccountKey(limit.provider)}: ${limit.reason.replace("_", " ")} until ${new Date(limit.limitedUntil).toISOString()} ` +
					`(${seconds(limit.limitedUntil - view.at)} left, recorded by pid ${limit.pid}${limit.detail ? `: ${limit.detail}` : ""})`,
			);
		}
	} else {
		lines.push("Limited: none recorded");
	}
	if (view.usage.length > 0) {
		lines.push("Provider windows:");
		for (const usage of view.usage) {
			for (const snapshot of usage.rateLimits) {
				if (!snapshot || typeof snapshot !== "object") continue;
				const s = snapshot as { limitId?: unknown; limitName?: unknown; primary?: unknown; secondary?: unknown };
				const parts = [describeWindow(s.primary), describeWindow(s.secondary)].filter(Boolean);
				if (parts.length === 0) continue;
				const name = typeof s.limitName === "string" ? s.limitName : String(s.limitId ?? "window");
				lines.push(
					`  ${describeProviderAccountKey(usage.provider)} ${name}: ${parts.join("; ")} (seen ${seconds(view.at - usage.at)} ago)`,
				);
			}
		}
	}
	lines.push(
		view.emergencyStop.engaged
			? `Emergency stop: ENGAGED${view.emergencyStop.reason ? ` — ${view.emergencyStop.reason}` : ""}${view.emergencyStop.engagedAt ? ` (since ${view.emergencyStop.engagedAt})` : ""}; new worker and background requests are held (${view.emergencyStop.path})`
			: `Emergency stop: off (/estop on [reason] pauses new worker and background work on this machine)`,
	);
	return lines.join("\n");
}
