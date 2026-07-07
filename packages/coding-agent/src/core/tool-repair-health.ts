import chalk from "chalk";
import type { ModelAdaptationStore, StoredModelAdaptation } from "./models/adaptation-store.ts";

function formatAgeDays(iso: string, now: Date): string {
	const ms = Date.parse(iso);
	if (!Number.isFinite(ms)) return "age unknown";
	const days = Math.max(0, Math.floor((now.getTime() - ms) / (24 * 60 * 60 * 1000)));
	return `${days}d ago`;
}

function sortProfiles(profiles: StoredModelAdaptation[]): StoredModelAdaptation[] {
	return [...profiles].sort((left, right) => left.model.localeCompare(right.model));
}

export function formatToolRepairHealthReport(store: ModelAdaptationStore, now: Date = new Date()): string {
	const profiles = sortProfiles(store.getForHost());
	if (profiles.length === 0) return "Tool repair health: no model adaptation records for this host.";

	const lines = [chalk.bold("Tool repair health")];
	for (const entry of profiles) {
		lines.push(`${entry.model}`);
		const protocol = entry.profile.protocol;
		if (!protocol) {
			lines.push("  protocol: none");
		} else if (protocol.status === "failed") {
			lines.push(`  protocol: v${protocol.version} failed ${formatAgeDays(protocol.attemptedAt, now)}`);
			lines.push(`  variants tried: ${protocol.variantsTried.join(", ")}`);
			lines.push(`  reset: /toolprotocol-reset ${entry.model}`);
		} else {
			lines.push(
				`  protocol: v${protocol.version} ${protocol.variant} calibrated ${formatAgeDays(protocol.calibratedAt, now)}`,
			);
		}
		if (entry.profile.rules.length === 0) {
			lines.push("  rules: none");
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
			lines.push("  teach stats: none");
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
