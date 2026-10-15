import { type Component, truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type { CiStatusView } from "../../../core/ci-status-view.ts";
import type { SelfCompactionView } from "../../../core/compaction/self-compaction-controller.ts";
import type { SessionCostSummary } from "../../../core/cost/cost-summary.ts";
import type { ForegroundRouteSnapshot } from "../../../core/model-router-controller.ts";
import { isIdleProjection } from "../../../core/operator-projection/decision-stage-log.ts";
import type { OperatorProjection } from "../../../core/operator-projection/types.ts";
import { formatRouteValue } from "../../../core/route-text.ts";
import type { SessionWorkState } from "../../../core/session-work-state.ts";
import { type SemanticPlaneHealth, semanticPlaneHealthValue } from "../../../core/system-one/semantic-plane-health.ts";
import { theme } from "../../../presentation/theme-model.ts";
import { SELF_COMPACTION_GAUGE_GLYPHS, selfCompactionGauge } from "./self-compaction-gauge.ts";

/**
 * Everything the POV bar reads. Each getter is a live read of canonical runtime state — the
 * session's projection, the router's foreground snapshot, the semantic plane's observed health and
 * the session's cost summary. The bar holds no state of its own and never renders a literal.
 */
export interface OperatorPovSource {
	getProjection(): OperatorProjection;
	getRouteSnapshot(): ForegroundRouteSnapshot;
	getSemanticPlaneHealth(): SemanticPlaneHealth;
	getCostSummary(): Pick<SessionCostSummary, "currentCost" | "subagentCost" | "subagentReports">;
	getSessionWorkState?(): SessionWorkState;
	getSelfCompactionView?(): SelfCompactionView;
	/** The branch's recorded CI verdict (core/ci-status-view.ts); absent when none is recorded. */
	getCiStatus?(): CiStatusView | undefined;
	/** Mandatory peer findings, separate from advisory System One doubts. */
	getPeerFindingCount?(): number;
	/** Output tokens per second of the latest run that generated any; undefined before the first. */
	getTokensPerSecond?(): number | undefined;
	/** Milliseconds until the provider's prompt cache for the last request expires (0 once it has); undefined where no lifetime is known. */
	getCacheRemainingMs?(): number | undefined;
}

export type OperatorPovSegmentId =
	| "working"
	| "block"
	| "next"
	| "route"
	| "system-one"
	| "peer-findings"
	| "tps"
	| "cache"
	| "cost"
	| "proof"
	| "ci"
	| "ctx";

export interface OperatorPovSegment {
	readonly id: OperatorPovSegmentId;
	readonly label: string;
	readonly value: string;
	/** Optional tail shown only while the width allows (e.g. spawned cost). */
	readonly extension?: string;
	/** Shorter value with the same meaning, used before any text is cut. */
	readonly compact?: string;
	/** Lower drops first; 0 is never dropped. */
	readonly dropOrder: number;
	readonly tone?: "accent" | "warning" | "error" | "success";
	/** The value says what it is on its own (`$0.012`, `42%`, a symbol): the row draws it without its label. */
	readonly bare?: boolean;
	/** The value as drawn, with its own colors (a gauge, a status symbol). Plain mode and compact use `value`. */
	readonly styled?: string;
}

/** Facts are told apart by their quiet labels and the space between them, never by rules. */
export const OPERATOR_POV_SEPARATOR = "   ";

function formatCost(value: number): string {
	return `$${value.toFixed(3)}`;
}

const GAUGE_TONES: Readonly<Record<string, "accent" | "text" | "dim" | "muted" | "warning" | "error">> = {
	[SELF_COMPACTION_GAUGE_GLYPHS.cached]: "accent",
	[SELF_COMPACTION_GAUGE_GLYPHS.used]: "text",
	[SELF_COMPACTION_GAUGE_GLYPHS.free]: "dim",
	[SELF_COMPACTION_GAUGE_GLYPHS.notice]: "muted",
	[SELF_COMPACTION_GAUGE_GLYPHS.warning]: "warning",
	[SELF_COMPACTION_GAUGE_GLYPHS.forced]: "error",
};

/** The gauge's glyphs in their own tones: cached and used fill, free recedes, the trigger marks warn. */
function paintGauge(bar: string): string {
	return [...bar].map((glyph) => theme.fg(GAUGE_TONES[glyph] ?? "dim", glyph)).join("");
}

/**
 * System One in words, only when it is doing or needing something: judging (accent), degraded with the reason, or
 * holding uncertain judgments. A healthy or idle System One says nothing; an abbreviation and a dot at rest told
 * the operator nothing they could act on.
 */
function systemOneStyled(health: SemanticPlaneHealth): string | undefined {
	const doubts = health.unresolvedDoubts?.length ?? 0;
	if (health.state === "evaluating")
		return theme.fg("accent", `◆ System One judging${doubts ? ` · ${doubts} uncertain` : ""}`);
	if (health.state === "degraded") return theme.fg("warning", `System One ${semanticPlaneHealthValue(health)}`);
	if (doubts) return theme.fg("warning", `System One · ${doubts} uncertain`);
	return undefined;
}

/** CI that needs attention, in words: a passing or unknown run says nothing and is not drawn. */
function ciStyled(state: "running" | "red"): string {
	return state === "red" ? theme.fg("error", "CI failed") : theme.fg("warning", "CI running");
}

/**
 * Builds the full segment list from live state. Width handling is separate so the content is
 * testable as data; see {@link layoutOperatorPovSegments}.
 */
export function buildOperatorPovSegments(source: OperatorPovSource): OperatorPovSegment[] {
	const projection = source.getProjection();
	const route = source.getRouteSnapshot();
	const health = source.getSemanticPlaneHealth();
	const cost = source.getCostSummary();
	const segments: OperatorPovSegment[] = [];

	const control = projection.control;
	const workState = source.getSessionWorkState?.();
	const livenessFault = Boolean(workState?.livenessFault);
	const needsInput = control.owner === "user" || workState?.phase === "waiting_user";
	const idle =
		!needsInput && !livenessFault && (workState ? workState.phase === "idle" : isIdleProjection(projection));

	let phaseLabel = "WORKING";
	let phaseTone: "accent" | "warning" | "error" | "success" | undefined;
	let phaseValue = projection.current_action;
	let phaseBare = false;

	if (livenessFault) {
		phaseLabel = "LIVENESS FAULT";
		phaseTone = "error";
		phaseValue = workState?.faultReason ?? projection.why ?? "active objective without execution path";
	} else if (needsInput) {
		phaseLabel = "NEEDS INPUT";
		phaseTone = "warning";
		phaseValue = projection.why || "waiting for your input";
	} else if (projection.phase === "blocked" || workState?.phase === "blocked") {
		phaseLabel = "BLOCKED";
		phaseTone = "error";
		phaseValue = projection.why || "execution blocked";
	} else if (projection.phase === "done" || workState?.phase === "done") {
		phaseLabel = "DONE";
		phaseTone = "success";
		phaseValue = projection.current_action || "objective completed";
	} else if (idle) {
		phaseLabel = "READY";
		phaseTone = undefined;
		phaseBare = true;
		phaseValue = projection.current_action || "Ready";
	} else if (workState?.phase === "system_one_evaluating") {
		phaseLabel = "S1 EVAL";
		phaseTone = "accent";
		phaseValue = projection.current_action || "System One evaluating";
	} else if (workState?.phase === "continuation_armed") {
		phaseLabel = "CONTINUING";
		phaseTone = "accent";
		phaseValue = projection.current_action || "Continuation armed";
	} else if (workState?.phase === "retrying") {
		phaseLabel = "RETRYING";
		phaseTone = "warning";
		phaseValue = projection.why || projection.current_action || "Retrying transient failure";
	} else if (workState?.phase === "waiting_tool" || workState?.phase === "waiting_worker") {
		// Only background work runs: the foreground turn is over, so its last action is not what is happening.
		phaseLabel = "BACKGROUND";
		phaseTone = undefined;
		phaseValue = workState.label;
	} else {
		phaseLabel = "WORKING";
		phaseTone = undefined;
		phaseValue = `${projection.phase}: ${projection.current_action}`;
	}

	segments.push({
		id: "working",
		label: phaseLabel,
		value: phaseValue,
		dropOrder: 0,
		tone: phaseTone,
		...(phaseBare ? { bare: true } : {}),
	});

	if (projection.next_action) {
		segments.push({ id: "next", label: "NEXT", value: projection.next_action, dropOrder: 40 });
	}

	// Only a turn someone other than the session's own choice is routing is worth a word; the default is silence.
	if (route.source !== "direct") {
		const routeValue = formatRouteValue(route);
		segments.push({
			id: "route",
			label: "ROUTE",
			value: `⇢ ${routeValue}`,
			compact: `⇢ ${routeValue.replace("via model-router", "via router")}`,
			dropOrder: 0,
			tone: "accent",
			bare: true,
		});
	}

	const peerFindingCount = source.getPeerFindingCount?.() ?? 0;
	if (peerFindingCount > 0) {
		segments.push({
			id: "peer-findings",
			label: "PEER",
			value: `${peerFindingCount} peer ${peerFindingCount === 1 ? "finding" : "findings"}`,
			compact: `⚑ ${peerFindingCount}`,
			dropOrder: 30,
			tone: "warning",
			bare: true,
		});
	}

	const systemOne = systemOneStyled(health);
	if (systemOne) {
		segments.push({
			id: "system-one",
			label: "S1",
			value: semanticPlaneHealthValue(health),
			dropOrder: 0,
			bare: true,
			styled: systemOne,
		});
	}

	const ci = source.getCiStatus?.();
	if (ci && (ci.state === "red" || ci.state === "running")) {
		segments.push({
			id: "ci",
			label: "CI",
			value: ci.state === "red" ? "CI failed" : "CI running",
			// A red branch is the fact to keep in view; a running one yields width early.
			dropOrder: ci.state === "red" ? 50 : 12,
			bare: true,
			styled: ciStyled(ci.state),
		});
	}

	const tokensPerSecond = source.getTokensPerSecond?.();
	if (tokensPerSecond !== undefined) {
		const rate = `${tokensPerSecond.toFixed(tokensPerSecond < 10 ? 1 : 0)} tok/s`;
		segments.push({
			id: "tps",
			label: "TPS",
			value: rate,
			dropOrder: 14,
			bare: true,
			styled: theme.fg("muted", rate),
		});
	}

	segments.push({
		id: "cost",
		label: "COST",
		value: formatCost(cost.currentCost),
		...(cost.subagentReports > 0 || cost.subagentCost > 0
			? { extension: `(sub ${formatCost(cost.subagentCost)})` }
			: {}),
		dropOrder: 0,
		bare: true,
	});

	if (control.blocker) {
		segments.push({ id: "block", label: "BLOCK", value: control.blocker, dropOrder: 35 });
	}

	if (projection.proof.total > 0) {
		segments.push({
			id: "proof",
			label: "PROOF",
			value: `${projection.proof.satisfied}/${projection.proof.total}`,
			dropOrder: 15,
		});
	}

	const cacheRemainingMs = source.getCacheRemainingMs?.();
	if (cacheRemainingMs !== undefined) {
		const live = cacheRemainingMs > 0;
		const seconds = Math.ceil(cacheRemainingMs / 1000);
		const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
		const text = live ? `◷ ${clock}` : "◷ cold";
		segments.push({
			id: "cache",
			label: "CACHE",
			value: text,
			dropOrder: 16,
			bare: true,
			styled: theme.fg(!live ? "dim" : cacheRemainingMs < 60_000 ? "warning" : "muted", text),
		});
	}

	const view = source.getSelfCompactionView?.();
	const gauge = view ? selfCompactionGauge(view) : null;
	const contextPercent = projection.context?.percent;
	if (gauge) {
		const reading = [gauge.percent, gauge.tag].filter(Boolean).join(" ");
		segments.push({
			id: "ctx",
			label: "CTX",
			value: `${gauge.bar} ${reading}`,
			compact: reading,
			styled: `${paintGauge(gauge.bar)} ${gauge.tone ? theme.fg(gauge.tone, reading) : reading}`,
			...(gauge.cycle ? { extension: gauge.cycle } : {}),
			dropOrder: gauge.tag ? 45 : 10,
			bare: true,
		});
	} else if (projection.context) {
		const reading = contextPercent === undefined ? "?%" : `${contextPercent.toFixed(1)}%`;
		segments.push({ id: "ctx", label: "CTX", value: reading, dropOrder: 10, bare: true });
	}

	return segments;
}

function renderSegment(segment: OperatorPovSegment, withExtension: boolean, plain: boolean, compact = false): string {
	const base = compact && segment.compact ? segment.compact : segment.value;
	const extension = withExtension && segment.extension ? ` ${segment.extension}` : "";
	if (plain) return `${segment.label} ${base}${extension}`;
	// The phase leads the row: its state word carries the tone, or a dot when the word would repeat the value.
	if (segment.id === "working") {
		const styled = theme.fg(segment.tone ?? "text", `${base}${extension}`);
		return segment.bare
			? `${theme.fg("muted", "●")} ${styled}`
			: `${theme.bold(theme.fg(segment.tone ?? "accent", segment.label))} ${styled}`;
	}
	const styled =
		segment.styled && !(compact && segment.compact)
			? `${segment.styled}${extension ? theme.fg("muted", extension) : ""}`
			: theme.fg(segment.tone ?? "text", `${base}${extension}`);
	return segment.bare ? styled : `${theme.fg("dim", segment.label.toLowerCase())} ${styled}`;
}

/**
 * The left block never shrinks below this many cells before a right segment is dropped instead: what is
 * happening is the first answer on the row, so it stays readable ("READY Ready for operator instructions")
 * and the low-priority facts (PEER, CI, CTX) yield width to it.
 */
const MIN_WORKING_WIDTH = 40;

/** Only the phase text stays on the left; every operator fact, BLOCK included, anchors right. */
function isLeftSegment(segment: OperatorPovSegment): boolean {
	return segment.id === "working";
}

/**
 * Lays the segments out as two blocks, exactly `width` cells: the phase text (WORKING / NEEDS INPUT
 * plus its BLOCK) on the left, and the operator facts (CONTROL, ACTOR, models, ROUTE, JEV, COST,
 * PROOF, CTX) anchored to the right edge, so those columns never move while the left text changes
 * length. The left text truncates first; right segments drop in priority order, then extensions
 * shed, then values compact, only when the width cannot hold them beside a minimal left block.
 * Routing, System One and cost are never dropped: an operator must always be able to answer who is
 * running and what it costs, even on a narrow terminal.
 */
export function layoutOperatorPovSegments(
	segments: readonly OperatorPovSegment[],
	width: number,
	options: { plain?: boolean } = {},
): string {
	const plain = options.plain ?? false;
	let kept = [...segments];
	let extensions = true;
	let compact = false;
	const renderBlock = (block: readonly OperatorPovSegment[]): string =>
		block.map((segment) => renderSegment(segment, extensions, plain, compact)).join(OPERATOR_POV_SEPARATOR);
	const separator = visibleWidth(OPERATOR_POV_SEPARATOR);

	const leftRoom = (): number => {
		const right = kept.filter((segment) => !isLeftSegment(segment));
		const rightWidth = right.length ? visibleWidth(renderBlock(right)) : 0;
		return width - rightWidth - (right.length ? separator : 0);
	};
	while (leftRoom() < MIN_WORKING_WIDTH) {
		const droppable = kept.filter((segment) => segment.dropOrder > 0).sort((a, b) => a.dropOrder - b.dropOrder);
		if (droppable.length > 0) {
			const victim = droppable[0];
			kept = kept.filter((segment) => segment !== victim);
			continue;
		}
		if (extensions && kept.some((segment) => segment.extension)) {
			extensions = false;
			continue;
		}
		if (!compact && kept.some((segment) => segment.compact)) {
			compact = true;
			continue;
		}
		break;
	}

	const right = kept.filter((segment) => !isLeftSegment(segment));
	const left = kept.filter(isLeftSegment);
	const rightText = right.length ? renderBlock(right) : "";
	const rightWidth = visibleWidth(rightText);
	const room = width - rightWidth - (right.length ? separator : 0);
	if (room < 0) {
		// Narrower than the mandatory facts themselves: the only honest output is the cut row.
		return truncateToWidth(renderBlock([...left, ...right]), width, "…");
	}
	const leftText = truncateToWidth(renderBlock(left), room, "…");
	const gap = Math.max(right.length ? separator : 0, width - visibleWidth(leftText) - rightWidth);
	return `${leftText}${" ".repeat(gap)}${rightText}`;
}

/**
 * OperatorPovBarComponent: the one normal-mode operator status surface. A single row of label-and-value facts
 * answering who is working, on what, what comes next, which model is actually executing (and which
 * root model it will return to), who chose it, what System One is doing, and what the session has cost.
 */
export class OperatorPovBarComponent implements Component {
	private readonly source: OperatorPovSource;

	constructor(source: OperatorPovSource) {
		this.source = source;
	}

	render(width: number): string[] {
		return [` ${layoutOperatorPovSegments(buildOperatorPovSegments(this.source), Math.max(0, width - 1))}`];
	}

	invalidate(): void {}
}
