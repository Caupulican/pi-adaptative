import { interfaceText } from "../language/interface-text.ts";
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
	const words = interfaceText().machines.load.view;
	if (!window || typeof window !== "object") return undefined;
	const w = window as { usedPercent?: unknown; windowMinutes?: unknown; resetsAt?: unknown };
	if (typeof w.usedPercent !== "number") return undefined;
	const minutes =
		typeof w.windowMinutes === "number" ? words.windowMinutes(w.windowMinutes) : words.windowFallbackName;
	return words.windowUsed({
		minutes,
		percent: w.usedPercent,
		resetsAt: typeof w.resetsAt === "number" ? new Date(w.resetsAt * 1000).toISOString() : undefined,
	});
}

/** Plain-text rendering for the operator (`/load`). */
export function formatProviderLoadView(view: ProviderLoadView): string {
	const words = interfaceText().machines.load.view;
	const lines: string[] = [];
	const byProvider = new Map<string, ProviderAdmissionEntry[]>();
	for (const entry of view.inflight) {
		const key = entryKey(entry);
		const list = byProvider.get(key) ?? [];
		list.push(entry);
		byProvider.set(key, list);
	}
	lines.push(words.header(view.inflight.length));
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
			words.provider({
				account: describeProviderAccountKey(key),
				inFlight: entries.length,
				foreground: lanes.foreground,
				worker: lanes.worker,
				background: lanes.background,
				processes: pids.size,
				limit: cap,
				oldest: seconds(view.at - oldest),
			}),
		);
	}
	if (view.limits.length > 0) {
		lines.push(words.limitedHeader);
		for (const limit of view.limits) {
			lines.push(
				words.limitedRow({
					account: describeProviderAccountKey(limit.provider),
					reason: limit.reason.replace("_", " "),
					until: new Date(limit.limitedUntil).toISOString(),
					left: seconds(limit.limitedUntil - view.at),
					pid: limit.pid,
					detail: limit.detail,
				}),
			);
		}
	} else {
		lines.push(words.limitedNone);
	}
	if (view.usage.length > 0) {
		lines.push(words.windowsHeader);
		for (const usage of view.usage) {
			for (const snapshot of usage.rateLimits) {
				if (!snapshot || typeof snapshot !== "object") continue;
				const s = snapshot as { limitId?: unknown; limitName?: unknown; primary?: unknown; secondary?: unknown };
				const parts = [describeWindow(s.primary), describeWindow(s.secondary)].filter(Boolean);
				if (parts.length === 0) continue;
				const name = typeof s.limitName === "string" ? s.limitName : String(s.limitId ?? "window");
				lines.push(
					words.window({
						account: describeProviderAccountKey(usage.provider),
						name,
						parts: parts.join("; "),
						seen: seconds(view.at - usage.at),
					}),
				);
			}
			const credits = usage.credits;
			if (credits) {
				const state = credits.unlimited
					? words.creditsUnlimited
					: credits.hasCredits
						? words.creditsBalance(credits.balance ?? words.creditsUnknown)
						: words.creditsNone;
				lines.push(
					words.credits({
						account: describeProviderAccountKey(usage.provider),
						state,
						seen: seconds(view.at - usage.at),
					}),
				);
			}
		}
	}
	lines.push(
		view.emergencyStop.engaged
			? words.stopEngaged({
					reason: view.emergencyStop.reason,
					engagedAt: view.emergencyStop.engagedAt,
					path: view.emergencyStop.path,
				})
			: words.stopOff,
	);
	return lines.join("\n");
}
