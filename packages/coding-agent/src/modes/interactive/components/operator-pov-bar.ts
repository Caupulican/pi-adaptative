import { type Component, truncateToWidth, visibleWidth } from "@caupulican/pi-tui";
import type { SessionCostSummary } from "../../../core/cost/cost-summary.ts";
import type { ForegroundRouteSnapshot } from "../../../core/model-router-controller.ts";
import { isIdleProjection } from "../../../core/operator-projection/decision-stage-log.ts";
import type { OperatorProjection } from "../../../core/operator-projection/types.ts";
import type { SessionWorkState } from "../../../core/session-work-state.ts";
import {
	type SemanticPlaneHealth,
	SYSTEM_ONE_BAR_LABEL,
	semanticPlaneHealthValue,
} from "../../../core/system-one/semantic-plane-health.ts";
import { theme } from "../theme/theme.ts";

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
}

export type OperatorPovSegmentId =
	| "working"
	| "control"
	| "block"
	| "next"
	| "actor"
	| "root"
	| "active"
	| "route"
	| "system-one"
	| "cost"
	| "proof"
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
}

export const OPERATOR_POV_SEPARATOR = " | ";

/** The short model name an operator recognises: the id without its provider prefix. */
export function shortModelName(ref: string | null | undefined): string {
	if (!ref) return "none";
	const slash = ref.indexOf("/");
	return slash === -1 ? ref : ref.slice(slash + 1);
}

function formatCost(value: number): string {
	return `$${value.toFixed(3)}`;
}

/** The ROUTE value: who chose the active model, in the operator's words, never claiming more. */
export function formatRouteValue(route: ForegroundRouteSnapshot): string {
	switch (route.source) {
		case "direct":
			return "direct";
		case "manual":
			return `manual:${shortModelName(route.activeModel)}`;
		case "model_router_retry":
			return `escalated→${shortModelName(route.activeModel)} via model-router`;
		case "model_router_hmoe":
			return `${route.tier ?? "routed"} via model-router/H-MoE`;
		case "model_router_system_one":
			return `${route.tier ?? "routed"} via model-router/System One`;
		default: {
			const tier = route.tier ?? "routed";
			return route.risk === "read-only" ? `${tier}/read-only via model-router` : `${tier} via model-router`;
		}
	}
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
	});

	segments.push({
		id: "control",
		label: "CONTROL",
		value: control.owner === "system_one" ? "S1" : control.owner === "user" ? "USER" : "ROOT",
		dropOrder: 0,
		tone: control.owner === "system_one" ? "accent" : control.owner === "user" ? "warning" : undefined,
	});

	if (projection.next_action) {
		segments.push({ id: "next", label: "NEXT", value: projection.next_action, dropOrder: 40 });
	}

	const primaryActor = projection.active_actors[0];
	const isRootActor = !primaryActor || primaryActor.kind === "root";
	segments.push({
		id: "actor",
		label: "ACTOR",
		value: isRootActor ? "root" : `${primaryActor.kind} ${primaryActor.label}`,
		// A root actor is the default and is an early detail to go; a worker/specialist stays longer.
		dropOrder: isRootActor ? 25 : 45,
	});

	if (route.switched) {
		segments.push({ id: "root", label: "ROOT", value: shortModelName(route.rootModel), dropOrder: 20 });
		segments.push({
			id: "active",
			label: "ACTIVE",
			value: shortModelName(route.activeModel),
			dropOrder: 0,
			tone: "accent",
		});
	} else {
		segments.push({ id: "active", label: "MODEL", value: shortModelName(route.activeModel), dropOrder: 0 });
	}

	const routeValue = formatRouteValue(route);
	segments.push({
		id: "route",
		label: "ROUTE",
		value: routeValue,
		compact: routeValue.replace("via model-router", "via router"),
		dropOrder: 0,
	});

	segments.push({
		id: "system-one",
		label: SYSTEM_ONE_BAR_LABEL,
		value: semanticPlaneHealthValue(health),
		dropOrder: 0,
		tone: health.state === "degraded" ? "warning" : undefined,
	});

	segments.push({
		id: "cost",
		label: "COST",
		value: formatCost(cost.currentCost),
		...(cost.subagentReports > 0 || cost.subagentCost > 0
			? { extension: `(sub ${formatCost(cost.subagentCost)})` }
			: {}),
		dropOrder: 0,
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

	if (projection.context) {
		const percent = projection.context.percent;
		segments.push({
			id: "ctx",
			label: "CTX",
			value: percent === undefined ? (projection.context.compacted ? "?%" : "n/a") : `${percent.toFixed(1)}%`,
			dropOrder: 10,
		});
	}

	return segments;
}

function renderSegment(segment: OperatorPovSegment, withExtension: boolean, plain: boolean, compact = false): string {
	const base = compact && segment.compact ? segment.compact : segment.value;
	const value = withExtension && segment.extension ? `${base} ${segment.extension}` : base;
	if (plain) return `${segment.label} ${value}`;
	const label = theme.fg("dim", segment.label);
	const tone = segment.tone;
	const styled =
		tone === "error" || tone === "warning" || tone === "success" || tone === "accent" ? theme.fg(tone, value) : value;
	return `${label} ${styled}`;
}

/** The left block never shrinks below this many cells before a right segment is dropped instead. */
const MIN_WORKING_WIDTH = 16;

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
 * OperatorPovBarComponent: the one normal-mode operator status surface. A single `|`-separated row
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
