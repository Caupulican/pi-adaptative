import { runBoundedCompletion } from "../autonomy/bounded-completion.ts";
import type { RouteDecision } from "../autonomy/contracts.ts";

/**
 * Routing-only judge: a bounded, tool-less completion (default: the medium model) that decides the
 * final cheap/medium/expensive tier for a user prompt, refining the regex classifier's baseline.
 * Core rule: planning is never cheap unless the judge explicitly deems the task trivial. The judge
 * proposes; the existing pipeline (model resolution, auth, escalation, gates) still decides.
 * Failure is honest: unparseable/timeout/unavailable falls back to the baseline with a visible
 * reasonCode, never silently.
 */

/** Static across calls — callers pass cacheRetention "short" so only the variable tail is billed. */
export const ROUTE_JUDGE_SYSTEM_PROMPT = [
	"You are a routing judge for a coding agent. You only route; you never answer the task.",
	"Pick which model tier should handle the user prompt:",
	'- "cheap": trivial, mechanical, read-only lookups only.',
	'- "medium": normal implementation, scoped edits, tests, and NON-trivial planning/design.',
	'- "expensive": architecture, ambiguity, security/auth, destructive or release operations, high-impact changes.',
	"Planning, design, and strategy prompts are NEVER cheap unless the task is genuinely trivial.",
	"Respond with STRICT JSON only - no prose:",
	'{"tier":"cheap"|"medium"|"expensive","risk":"read-only"|"scoped-write"|"high-impact"|"approval-required","trivial":true|false,"reason":"<short reason>"}',
].join("\n");

export const ROUTE_JUDGE_MAX_OUTPUT_TOKENS = 128;
export const ROUTE_JUDGE_MAX_WALL_CLOCK_MS = 10_000;

export interface RouteJudgeVerdict {
	tier: "cheap" | "medium" | "expensive";
	risk: RouteDecision["risk"];
	trivial: boolean;
	reason: string;
}

export function buildRouteJudgeUserPrompt(args: { prompt: string; baseline: RouteDecision }): string {
	return [
		`Baseline (regex) verdict: tier=${args.baseline.tier}, risk=${args.baseline.risk}, reason=${args.baseline.reasonCode}.`,
		"User prompt:",
		args.prompt.slice(0, 4000),
	].join("\n");
}

const JUDGE_TIERS: readonly string[] = ["cheap", "medium", "expensive"];
const JUDGE_RISKS: readonly string[] = ["read-only", "scoped-write", "high-impact", "approval-required"];

export function parseRouteJudgeVerdict(text: string): RouteJudgeVerdict | undefined {
	const trimmed = text.trim();
	const candidates: string[] = [trimmed];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
	if (fenced?.[1]) candidates.push(fenced[1].trim());
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
		const record = parsed as Record<string, unknown>;
		// The judge may never select the learning tier or anything outside the three foreground tiers.
		if (typeof record.tier !== "string" || !JUDGE_TIERS.includes(record.tier)) continue;
		const risk =
			typeof record.risk === "string" && JUDGE_RISKS.includes(record.risk)
				? (record.risk as RouteDecision["risk"])
				: undefined;
		if (!risk) continue;
		return {
			tier: record.tier as RouteJudgeVerdict["tier"],
			risk,
			trivial: record.trivial === true,
			reason: typeof record.reason === "string" ? record.reason.slice(0, 200) : "",
		};
	}
	return undefined;
}

/** Merge a judge verdict into the baseline decision (pure; never returns learning). */
export function applyRouteJudgeVerdict(baseline: RouteDecision, verdict: RouteJudgeVerdict): RouteDecision {
	return {
		...baseline,
		tier: verdict.tier,
		risk: verdict.risk,
		confidence: Math.max(baseline.confidence, 0.75),
		reasonCode: `judge_${verdict.tier}${verdict.trivial ? "_trivial" : ""}`,
		reasons: [...baseline.reasons, `Route judge: ${verdict.reason || "no reason given"}`],
	};
}

export interface RouteJudgeRunResult {
	decision: RouteDecision;
	verdict?: RouteJudgeVerdict;
	/** Set when the judge could not decide and the baseline was kept. */
	fallbackReason?: string;
	costUsd: number;
}

/**
 * Run the judge over a baseline decision. The completion executor is injected (production:
 * AgentSession.runIsolatedCompletion on the judge model). Never throws; every failure keeps the
 * baseline with a visible fallbackReason.
 */
export async function runRouteJudge(args: {
	prompt: string;
	baseline: RouteDecision;
	complete: (input: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }) => Promise<{
		text: string;
		costUsd: number;
		stopReason: string;
	}>;
	signal?: AbortSignal;
	maxWallClockMs?: number;
}): Promise<RouteJudgeRunResult> {
	const bounded = await runBoundedCompletion({
		maxWallClockMs: args.maxWallClockMs ?? ROUTE_JUDGE_MAX_WALL_CLOCK_MS,
		signal: args.signal,
		execute: (signal) =>
			args.complete({
				systemPrompt: ROUTE_JUDGE_SYSTEM_PROMPT,
				userPrompt: buildRouteJudgeUserPrompt({ prompt: args.prompt, baseline: args.baseline }),
				signal,
			}),
	});
	const costUsd = bounded.completion?.costUsd ?? 0;

	if (bounded.failure || !bounded.completion) {
		return {
			decision: {
				...args.baseline,
				reasons: [...args.baseline.reasons, "Route judge unavailable; baseline kept"],
			},
			fallbackReason: bounded.failure ? `judge_${bounded.failure.reasonCode}` : "judge_unavailable_fallback",
			costUsd,
		};
	}
	if (bounded.completion.stopReason === "error" || bounded.completion.stopReason === "aborted") {
		return {
			decision: { ...args.baseline, reasons: [...args.baseline.reasons, "Route judge errored; baseline kept"] },
			fallbackReason: "judge_model_error",
			costUsd,
		};
	}

	const verdict = parseRouteJudgeVerdict(bounded.completion.text);
	if (!verdict) {
		return {
			decision: { ...args.baseline, reasons: [...args.baseline.reasons, "Route judge unparseable; baseline kept"] },
			fallbackReason: "judge_unparseable_fallback",
			costUsd,
		};
	}

	return { decision: applyRouteJudgeVerdict(args.baseline, verdict), verdict, costUsd };
}
