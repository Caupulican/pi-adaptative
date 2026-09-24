import type { SelfCompactionPhase, SelfCompactionView } from "../../../core/compaction/self-compaction-controller.ts";

export const SELF_COMPACTION_GAUGE_CELLS = 20;

export const SELF_COMPACTION_GAUGE_GLYPHS = {
	cached: "#",
	used: "=",
	free: ".",
	notice: "+",
	warning: "!",
	forced: "|",
} as const;

export type SelfCompactionGaugeTone = "accent" | "warning" | "error";

export interface SelfCompactionGauge {
	readonly bar: string;
	readonly percent: string;
	readonly tag: string | null;
	readonly tone: SelfCompactionGaugeTone | null;
	readonly cycle: string | null;
}

const PHASE_TAGS: Readonly<Record<SelfCompactionPhase, string | null>> = {
	off: null,
	clear: null,
	notice: "NOTICE",
	warning: "WARNING",
	forced: "FORCED",
	compacting: "COMPACTING",
	compacted: "COMPACTED",
	resuming: "RESUMING",
};

const PHASE_TONES: Readonly<Record<SelfCompactionPhase, SelfCompactionGaugeTone | null>> = {
	off: null,
	clear: null,
	notice: "accent",
	warning: "warning",
	forced: "error",
	compacting: "accent",
	compacted: "accent",
	resuming: "accent",
};

function cellIndex(share: number, cells: number): number {
	return Math.min(cells - 1, Math.max(0, Math.ceil(share * cells) - 1));
}

export function selfCompactionGauge(
	view: SelfCompactionView,
	cells = SELF_COMPACTION_GAUGE_CELLS,
): SelfCompactionGauge | null {
	const thresholds = view.thresholds;
	if (!thresholds || thresholds.contextWindow <= 0) return null;
	const window = thresholds.contextWindow;
	const out: string[] = new Array(cells).fill(SELF_COMPACTION_GAUGE_GLYPHS.free);
	if (view.usedTokens !== null) {
		const used = Math.min(cells, Math.max(0, Math.ceil((view.usedTokens / window) * cells)));
		const cached = Math.min(used, Math.max(0, Math.ceil(((view.cachedTokens ?? 0) / window) * cells)));
		for (let index = 0; index < used; index++) {
			out[index] = index < cached ? SELF_COMPACTION_GAUGE_GLYPHS.cached : SELF_COMPACTION_GAUGE_GLYPHS.used;
		}
	}
	out[cellIndex(thresholds.noticeTokens / window, cells)] = SELF_COMPACTION_GAUGE_GLYPHS.notice;
	out[cellIndex(thresholds.warningTokens / window, cells)] = SELF_COMPACTION_GAUGE_GLYPHS.warning;
	out[cellIndex(thresholds.forcedTokens / window, cells)] = SELF_COMPACTION_GAUGE_GLYPHS.forced;
	return {
		bar: `[${out.join("")}]`,
		percent: view.usedTokens === null ? "?%" : `${((view.usedTokens / window) * 100).toFixed(1)}%`,
		tag: PHASE_TAGS[view.phase],
		tone: PHASE_TONES[view.phase],
		cycle: view.cycles > 0 ? `cycle ${view.cycles}` : null,
	};
}
