import type { CapabilityEnvelope, EvidenceBundle, EvidenceRef, Finding, GateOutcome } from "../autonomy/contracts.ts";
import { createEvidenceBundle } from "./evidence-bundle.ts";
import { evaluateResearchRequest } from "./research-gate.ts";

/**
 * Pure orchestration for one autonomous research pass: gate -> bounded isolated completion ->
 * parse -> evidence bundle. The model executor is injected so this stays provider-free and
 * session-free; production wires `AgentSession.runIsolatedCompletion` in.
 *
 * The lane is read-only by construction: the executor receives text prompts only, and the output
 * is an `EvidenceBundle` whose model-synthesized findings are marked untrusted.
 */

/** Static across calls so callers can use `cacheRetention: "short"` and only pay for the variable tail. */
export const RESEARCH_LANE_SYSTEM_PROMPT = [
	"You are a read-only research lane for a coding agent.",
	"You receive a research query plus bounded context and produce findings that help satisfy open goal requirements.",
	"Respond with STRICT JSON only - no prose, no markdown fences:",
	'{"findings":[{"summary":"<one concrete, actionable finding>","confidence":<0..1>}]}',
	"Base findings only on the provided context. Never invent file paths, APIs, or facts.",
].join("\n");

export interface ResearchCompletion {
	text: string;
	costUsd: number;
	stopReason: string;
}

export interface ResearchRunnerOptions {
	query: string;
	/** Bounded, pre-redacted context handed to the research model (goal text, open requirements). */
	context?: string;
	/** Stripped research envelope - never the foreground/architect envelope. */
	envelope: CapabilityEnvelope;
	/** Budget for this pass; a post-hoc breach marks the run budget_exhausted (spend stays visible). */
	maxUsd: number;
	maxSources: number;
	maxFindings: number;
	/** Wall-clock budget in milliseconds; 0 disables. */
	maxWallClockMs: number;
	/** Executes one isolated completion. Production: AgentSession.runIsolatedCompletion. */
	complete: (args: { systemPrompt: string; userPrompt: string; signal?: AbortSignal }) => Promise<ResearchCompletion>;
	/** External cancellation (e.g. session disposal). */
	signal?: AbortSignal;
}

export type ResearchRunStatus = "succeeded" | "failed" | "canceled" | "timeout" | "budget_exhausted";

export interface ResearchRunResult {
	status: ResearchRunStatus;
	reasonCode: string;
	gateOutcome: GateOutcome;
	bundle?: EvidenceBundle;
	costUsd: number;
}

export function buildResearchUserPrompt(args: { query: string; context?: string; maxFindings: number }): string {
	const parts = [`Research query: ${args.query}`];
	if (args.context && args.context.length > 0) {
		parts.push("", "Context:", args.context);
	}
	parts.push("", `Return at most ${args.maxFindings} findings.`);
	return parts.join("\n");
}

export interface ParsedResearchFindings {
	findings: Array<{ summary: string; confidence?: number }>;
}

export function parseResearchFindings(text: string, maxFindings: number): ParsedResearchFindings | undefined {
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
		const findingsRaw = (parsed as { findings?: unknown }).findings;
		if (!Array.isArray(findingsRaw)) continue;

		const findings: Array<{ summary: string; confidence?: number }> = [];
		for (const item of findingsRaw) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const summary = (item as { summary?: unknown }).summary;
			if (typeof summary !== "string" || summary.trim().length === 0) continue;
			const confidenceRaw = (item as { confidence?: unknown }).confidence;
			const confidence =
				typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
					? Math.min(Math.max(confidenceRaw, 0), 1)
					: undefined;
			findings.push({ summary: summary.trim(), confidence });
			if (findings.length >= maxFindings) break;
		}
		// A well-formed-but-empty findings array is a valid "nothing found"; a findings array whose
		// every item is malformed is not.
		if (findings.length > 0 || findingsRaw.length === 0) {
			return { findings };
		}
	}
	return undefined;
}

function truncateExcerpt(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function buildBundle(options: ResearchRunnerOptions, parsed: ParsedResearchFindings): EvidenceBundle {
	const contextRef: EvidenceRef = {
		id: "src-context",
		kind: "user",
		title: "Goal/context provided to the research lane",
		trusted: true,
		excerpt: truncateExcerpt(options.context && options.context.length > 0 ? options.context : options.query, 2000),
	};
	const synthesisRef: EvidenceRef = {
		id: "src-synthesis",
		kind: "tool",
		title: "Research-model synthesis",
		trusted: false,
	};
	const sources = [contextRef, synthesisRef].slice(0, Math.max(1, options.maxSources));
	const findings: Finding[] = parsed.findings.slice(0, options.maxFindings).map((finding, index) => ({
		id: `finding-${index + 1}`,
		summary: finding.summary,
		evidenceIds: [synthesisRef.id],
		...(finding.confidence !== undefined ? { confidence: finding.confidence } : {}),
	}));
	return createEvidenceBundle({ query: options.query, sources, findings });
}

export async function runResearch(options: ResearchRunnerOptions): Promise<ResearchRunResult> {
	const gateOutcome = evaluateResearchRequest({
		envelope: options.envelope,
		sourceKind: "tool",
		estimatedUsd: options.maxUsd,
	});
	if (gateOutcome.outcome !== "allow") {
		// Skip-and-record, never prompt: gate denials inform diagnostics instead of blocking anything.
		const status: ResearchRunStatus = gateOutcome.reasonCode === "over_budget" ? "budget_exhausted" : "failed";
		return { status, reasonCode: gateOutcome.reasonCode, gateOutcome, costUsd: 0 };
	}

	const timeoutController = new AbortController();
	const timeoutTimer =
		options.maxWallClockMs > 0 ? setTimeout(() => timeoutController.abort(), options.maxWallClockMs) : undefined;
	if (timeoutTimer && typeof timeoutTimer === "object" && "unref" in timeoutTimer) {
		const { unref } = timeoutTimer as { unref?: () => void };
		unref?.call(timeoutTimer);
	}
	const signals: AbortSignal[] = [timeoutController.signal];
	if (options.signal) signals.push(options.signal);
	const signal = AbortSignal.any(signals);

	let completion: ResearchCompletion;
	try {
		completion = await options.complete({
			systemPrompt: RESEARCH_LANE_SYSTEM_PROMPT,
			userPrompt: buildResearchUserPrompt(options),
			signal,
		});
	} catch {
		if (options.signal?.aborted) {
			return { status: "canceled", reasonCode: "external_abort", gateOutcome, costUsd: 0 };
		}
		if (timeoutController.signal.aborted) {
			return { status: "timeout", reasonCode: "wall_clock_exceeded", gateOutcome, costUsd: 0 };
		}
		return { status: "failed", reasonCode: "completion_error", gateOutcome, costUsd: 0 };
	} finally {
		if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
	}

	// An abort can race a completion that settled without throwing; abort still wins.
	if (options.signal?.aborted) {
		return { status: "canceled", reasonCode: "external_abort", gateOutcome, costUsd: completion.costUsd };
	}
	if (timeoutController.signal.aborted) {
		return { status: "timeout", reasonCode: "wall_clock_exceeded", gateOutcome, costUsd: completion.costUsd };
	}
	if (completion.stopReason === "error" || completion.stopReason === "aborted") {
		return { status: "failed", reasonCode: "model_error", gateOutcome, costUsd: completion.costUsd };
	}

	const parsed = parseResearchFindings(completion.text, options.maxFindings);
	if (!parsed) {
		return { status: "failed", reasonCode: "unparseable_output", gateOutcome, costUsd: completion.costUsd };
	}

	const bundle = buildBundle(options, parsed);
	const overBudget = options.maxUsd > 0 && completion.costUsd > options.maxUsd;
	return {
		status: overBudget ? "budget_exhausted" : "succeeded",
		reasonCode: overBudget
			? "cost_budget_exceeded"
			: parsed.findings.length === 0
				? "no_findings"
				: "research_completed",
		gateOutcome,
		bundle,
		costUsd: completion.costUsd,
	};
}
