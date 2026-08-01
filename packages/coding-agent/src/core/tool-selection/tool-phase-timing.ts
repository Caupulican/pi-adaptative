export type ToolPhase = "selection" | "execution" | "observation_write" | "validation_write" | "hint_snapshot";

export interface ToolPhaseTimingStats {
	phase: ToolPhase;
	count: number;
	recentCount: number;
	p50Ms: number;
	p95Ms: number;
	maxMs: number;
}

interface ToolPhaseSamples {
	values: Float64Array;
	next: number;
	size: number;
	count: number;
}

const PHASES: readonly ToolPhase[] = [
	"selection",
	"execution",
	"observation_write",
	"validation_write",
	"hint_snapshot",
];

const PHASE_LABELS: Record<ToolPhase, string> = {
	selection: "selection",
	execution: "execution and result hooks",
	observation_write: "observation evidence write",
	validation_write: "validation evidence write",
	hint_snapshot: "hint snapshot",
};

const DEFAULT_RECENT_SAMPLE_CAPACITY = 128;

function percentile(sorted: readonly number[], fraction: number): number {
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

/** Passive, allocation-free-on-record timing samples for the tool-call path. */
export class ToolPhaseTimings {
	private readonly capacity: number;
	private readonly samples: Record<ToolPhase, ToolPhaseSamples>;

	constructor(capacity = DEFAULT_RECENT_SAMPLE_CAPACITY) {
		this.capacity = Math.max(1, Math.trunc(capacity));
		this.samples = Object.fromEntries(
			PHASES.map((phase) => [phase, { values: new Float64Array(this.capacity), next: 0, size: 0, count: 0 }]),
		) as Record<ToolPhase, ToolPhaseSamples>;
	}

	record(phase: ToolPhase, durationMs: number): void {
		if (!Number.isFinite(durationMs) || durationMs < 0) return;
		const samples = this.samples[phase];
		samples.values[samples.next] = durationMs;
		samples.next = (samples.next + 1) % this.capacity;
		samples.size = Math.min(this.capacity, samples.size + 1);
		samples.count += 1;
	}

	getStats(): ToolPhaseTimingStats[] {
		const stats: ToolPhaseTimingStats[] = [];
		for (const phase of PHASES) {
			const samples = this.samples[phase];
			if (samples.size === 0) continue;
			const recent = Array.from(samples.values.subarray(0, samples.size)).sort((left, right) => left - right);
			stats.push({
				phase,
				count: samples.count,
				recentCount: samples.size,
				p50Ms: percentile(recent, 0.5),
				p95Ms: percentile(recent, 0.95),
				maxMs: recent[recent.length - 1] ?? 0,
			});
		}
		return stats;
	}

	formatReport(): string {
		const stats = this.getStats();
		if (stats.length === 0) return "Tool phase timings: no samples recorded yet.";
		const lines = [`Tool phase timings (most recent ${this.capacity} samples per phase)`];
		for (const entry of stats) {
			lines.push(
				`  ${PHASE_LABELS[entry.phase]}: n=${entry.count} p50=${entry.p50Ms.toFixed(2)}ms p95=${entry.p95Ms.toFixed(2)}ms max=${entry.maxMs.toFixed(2)}ms`,
			);
		}
		return lines.join("\n");
	}
}
