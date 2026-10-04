import chalk from "chalk";
import type { ModelAdaptationStore, StoredModelAdaptation } from "./models/adaptation-store.ts";
import type { ModelPerfProfile } from "./models/perf-profile.ts";
import { splitPerfAttributionKey } from "./provider-admission/lane-context.ts";
import type { ToolRecoveryLoggerStats } from "./tool-recovery-logger.ts";

function formatAgeDays(iso: string, now: Date): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return "age unknown";
	const days = Math.max(0, Math.floor((now.getTime() - ms) / (24 * 60 * 60 * 1000)));
	return `${days}d ago`;
}

/**
 * A store key is a model, or a model's measurements on the worker lane (`<model>#lane:worker`). Entries are
 * ordered by model with the owner's own entry first, so a model's worker-lane entry follows it and keeps its
 * own separate samples.
 */
function sortProfiles(
	profiles: StoredModelAdaptation[],
): Array<{ entry: StoredModelAdaptation; model: string; lane: "worker" | undefined }> {
	return profiles
		.map((entry) => ({ entry, ...splitPerfAttributionKey(entry.model) }))
		.sort((left, right) => {
			const byModel = left.model.localeCompare(right.model);
			if (byModel !== 0) return byModel;
			return (left.lane === undefined ? 0 : 1) - (right.lane === undefined ? 0 : 1);
		});
}

function formatPerf(perf: ModelPerfProfile, lane: "worker" | undefined): string {
	const rate = (value: number | undefined, label: string) =>
		value === undefined ? [] : [`${label}=${Math.round(value)} tok/s`];
	const parts = [
		`samples=${perf.samples}`,
		...rate(perf.prefillTokensPerSecond, "prefill"),
		...rate(perf.decodeTokensPerSecond, "decode"),
	];
	return `  perf${lane ? " (worker lane)" : ""}: ${parts.join(" ")}`;
}

function formatLoggerStats(stats: ToolRecoveryLoggerStats | undefined): string[] {
	if (!stats) return [];
	const phaseCounts = Object.entries(stats.failurePhases)
		.filter((entry): entry is [string, number] => entry[1] !== undefined && entry[1] > 0)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([phase, count]) => `${phase}=${count}`)
		.join(" ");
	return [
		`recovery logging: ${stats.enabled ? "enabled" : "disabled"} queued=${stats.queued} inFlight=${stats.inFlight} dropped=${stats.dropped} failures=${stats.failures} workerStarts=${stats.workerStarts} crashes=${stats.workerCrashes} respawns=${stats.respawns}`,
		`execution failures: total=${stats.executionFailures}${phaseCounts ? ` ${phaseCounts}` : ""}`,
	];
}

export function formatToolRepairHealthReport(
	store: ModelAdaptationStore,
	now: Date = new Date(),
	loggerStats?: ToolRecoveryLoggerStats,
): string {
	const profiles = sortProfiles(store.getForHost());
	if (profiles.length === 0) {
		const loggerLines = formatLoggerStats(loggerStats);
		return ["Tool repair health: no model adaptation records for this host.", ...loggerLines].join("\n");
	}

	const lines = [chalk.bold("Tool repair health"), ...formatLoggerStats(loggerStats)];
	for (const { entry, model, lane } of profiles) {
		lines.push(lane ? `${model} [worker lane]` : model);
		if (entry.profile.perf) lines.push(formatPerf(entry.profile.perf, lane));
		// Probe, protocol, rules and teach stats belong to the model itself, never to a lane's measurements:
		// a worker-lane entry shows them only when it somehow holds any, and never as empty "none" lines.
		const quiet = lane !== undefined;
		const toolProbe = entry.profile.toolProbe;
		if (!toolProbe) {
			if (!quiet) lines.push("  tool probe: none");
		} else {
			const variant = toolProbe.variant ? ` (${toolProbe.variant})` : "";
			const nativeGrade = toolProbe.nativeGrade ? ` native=${toolProbe.nativeGrade}` : "";
			lines.push(
				`  tool probe: v${toolProbe.version} ${toolProbe.status}${variant}${nativeGrade} ${formatAgeDays(toolProbe.probedAt, now)}`,
			);
			if (toolProbe.diagnostic) lines.push(`  probe diagnostic: ${toolProbe.diagnostic}`);
		}
		const protocol = entry.profile.protocol;
		if (!protocol) {
			if (!quiet) lines.push("  protocol: none");
		} else if (protocol.status === "failed") {
			lines.push(`  protocol: v${protocol.version} failed ${formatAgeDays(protocol.attemptedAt, now)}`);
			lines.push(`  variants tried: ${protocol.variantsTried.join(", ")}`);
			lines.push(`  reset: /toolprotocol-reset ${model}`);
		} else {
			lines.push(
				`  protocol: v${protocol.version} ${protocol.variant} calibrated ${formatAgeDays(protocol.calibratedAt, now)}`,
			);
		}
		if (entry.profile.rules.length === 0) {
			if (!quiet) lines.push("  rules: none");
		} else {
			lines.push("  rules:");
			for (const rule of [...entry.profile.rules].sort((left, right) => left.mode.localeCompare(right.mode))) {
				lines.push(`    - ${rule.mode} (${formatAgeDays(rule.lastFiredAt, now)}): ${rule.text}`);
			}
		}
		const teachEntries = Object.entries(entry.profile.teachStats).sort(([left], [right]) =>
			left.localeCompare(right),
		);
		if (teachEntries.length === 0) {
			if (!quiet) lines.push("  teach stats: none");
		} else {
			lines.push("  teach stats:");
			for (const [mode, stats] of teachEntries) {
				lines.push(
					`    - ${mode}: taught=${stats.taught} before=${stats.recurrenceBefore} after=${stats.recurrenceAfter}`,
				);
			}
		}
	}
	return lines.join("\n");
}
