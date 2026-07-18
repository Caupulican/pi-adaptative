import {
	decideExpectedUtility,
	type ExpectedUtilityCandidate,
	type ToolSelectionDecision,
} from "./expected-utility.ts";
import { evaluateToolPromotion, type ToolSelectionHint } from "./promotion.ts";
import type {
	ToolExecutionObservation,
	ToolPerformanceKey,
	ToolPerformanceStore,
	ToolSelectionIntentClass,
	ToolSelectionObservation,
} from "./tool-performance-store.ts";

export interface ToolSelectionTool {
	name: string;
	description?: string;
	parameters?: unknown;
	profileAllowed?: boolean;
	capabilityAllowed?: boolean;
	pathValidated?: boolean;
	riskCost?: number;
	contextCost?: number;
}

export interface ToolSelectionControllerDeps {
	store: ToolPerformanceStore;
	getModelRef: () => string;
	getActiveTools: () => readonly ToolSelectionTool[];
	isCandidateAllowed?: (toolName: string) => boolean;
	/**
	 * Env-var source for the kill switches, injected for hermetic testing; defaults to
	 * `process.env`. `PI_TOOL_SELECTION_OBSERVE=0` disables recording (the observe/stats layer,
	 * default ON); `PI_TOOL_SELECTION_HINTS=0` disables surfacing the evidence-gated prompt hint
	 * (default ON, but the hint itself only ever activates once evidence thresholds are met).
	 */
	env?: Record<string, string | undefined>;
}

export interface ToolSelectionPendingObservation {
	id: string;
	key: ToolPerformanceKey;
	firstTool: boolean;
	startedAt: number;
	inputTokenEstimate?: number;
	selection: Omit<ToolSelectionObservation, "at" | "modelRef" | "intentClass" | "actualTool" | "succeeded">;
	/** Was a promotion hint already active for this (model,intent) bucket before this call? */
	hintActiveAtCallTime: boolean;
}

/** Report row for the observe/agreement/promotion loop — see {@link ToolSelectionController.getReport}. */
export interface ToolSelectionReportEntry {
	modelRef: string;
	intentClass: ToolSelectionIntentClass;
	sampleCount: number;
	agreementRate?: number;
	hintTool?: string;
	hintSampleCount: number;
	hintAgreementRate?: number;
}

const INTENT_CLASSES: readonly ToolSelectionIntentClass[] = [
	"read",
	"search",
	"execute",
	"write",
	"retrieve",
	"explain",
	"other",
];

const INTENT_WORDS: Record<ToolSelectionIntentClass, readonly string[]> = {
	read: ["read", "cat", "ls", "list", "stat", "head", "tail"],
	search: ["search", "grep", "find", "glob", "ripgrep", "query"],
	execute: ["bash", "python", "powershell", "shell", "exec", "run", "process", "command", "script"],
	write: ["write", "edit", "patch", "apply", "delete", "mkdir", "move", "rename"],
	retrieve: ["retrieve", "artifact", "recall", "memory", "fetch", "download"],
	explain: ["explain", "help", "describe", "inspect", "context"],
	other: [],
};

function tokenize(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter(Boolean);
}

function classifyToolIntent(tool: ToolSelectionTool): ToolSelectionIntentClass {
	const tokens = tokenize(`${tool.name} ${tool.description ?? ""}`);
	let best: ToolSelectionIntentClass = "other";
	let bestScore = 0;
	for (const intent of INTENT_CLASSES) {
		if (intent === "other") continue;
		const score = INTENT_WORDS[intent].reduce((total, word) => total + (tokens.includes(word) ? 1 : 0), 0);
		if (score > bestScore) {
			best = intent;
			bestScore = score;
		}
	}
	return best;
}

function intentValue(intent: ToolSelectionIntentClass, toolIntent: ToolSelectionIntentClass): number {
	if (toolIntent === intent) return 0.85;
	if (intent === "other") return 0.35;
	if (toolIntent === "other") return 0.2;
	return 0.12;
}

function noToolValue(intent: ToolSelectionIntentClass): number {
	switch (intent) {
		case "explain":
			return 0.35;
		case "read":
		case "search":
		case "retrieve":
			return 0.12;
		case "write":
		case "execute":
			return 0.05;
		default:
			return 0.2;
	}
}

function estimateTokens(value: unknown): number | undefined {
	try {
		const serialized = typeof value === "string" ? value : JSON.stringify(value);
		if (!serialized) return undefined;
		return Math.max(1, Math.ceil(serialized.length / 4));
	} catch {
		return undefined;
	}
}

function estimateContentTokens(content: readonly unknown[]): number | undefined {
	const text = content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const candidate = block as { type?: unknown; text?: unknown };
			return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
		})
		.join("\n");
	return estimateTokens(text);
}

function modelToolKey(modelRef: string, intentClass: ToolSelectionIntentClass, tool: string): ToolPerformanceKey {
	return { modelRef, intentClass, tool };
}

function candidateFor(
	store: ToolPerformanceStore,
	modelRef: string,
	intentClass: ToolSelectionIntentClass,
	tool: ToolSelectionTool,
	actualTool: string,
): ExpectedUtilityCandidate {
	const key = modelToolKey(modelRef, intentClass, tool.name);
	const stats = store.get(key);
	return {
		tool: tool.name,
		value: intentValue(intentClass, classifyToolIntent(tool)),
		alpha: stats.alpha,
		beta: stats.beta,
		sampleCount: stats.sampleCount,
		latencyMs: stats.latencyEwmaMs,
		tokenEstimate:
			stats.inputTokenEstimateEwma === undefined && stats.outputTokenEstimateEwma === undefined
				? undefined
				: (stats.inputTokenEstimateEwma ?? 0) + (stats.outputTokenEstimateEwma ?? 0),
		riskCost: tool.riskCost,
		contextCost: tool.contextCost,
		deterministicMatch: tool.name === actualTool && tool.pathValidated !== false,
		automaticEligible: tool.pathValidated !== false,
	};
}

export class ToolSelectionController {
	private readonly deps: ToolSelectionControllerDeps;
	private readonly pending = new Map<string, ToolSelectionPendingObservation>();
	private firstToolInTurn = true;
	/** Kill switch: observe/stats recording, default ON. `PI_TOOL_SELECTION_OBSERVE=0` disables it. */
	private readonly observeEnabled: boolean;

	constructor(deps: ToolSelectionControllerDeps) {
		this.deps = deps;
		this.observeEnabled = (deps.env ?? process.env).PI_TOOL_SELECTION_OBSERVE !== "0";
	}

	startTurn(): void {
		this.firstToolInTurn = true;
	}

	begin(toolCallId: string, toolName: string, args: unknown): ToolSelectionPendingObservation {
		const modelRef = this.deps.getModelRef();
		const activeTools = this.deps
			.getActiveTools()
			.filter(
				(tool) =>
					tool.profileAllowed !== false &&
					tool.capabilityAllowed !== false &&
					(this.deps.isCandidateAllowed?.(tool.name) ?? true),
			);
		const actualTool = activeTools.find((tool) => tool.name === toolName) ?? {
			name: toolName,
			pathValidated: true,
		};
		const intentClass = classifyToolIntent(actualTool);
		const candidates = activeTools.map((tool) =>
			candidateFor(
				this.deps.store,
				modelRef,
				intentClass,
				tool.name === toolName ? tool : { ...tool, pathValidated: false },
				toolName,
			),
		);
		if (!candidates.some((candidate) => candidate.tool === toolName)) {
			candidates.push(candidateFor(this.deps.store, modelRef, intentClass, actualTool, toolName));
		}
		candidates.push({
			tool: "no_tool",
			value: noToolValue(intentClass),
			alpha: 1,
			beta: 1,
			sampleCount: 0,
			successProbability: 1,
			latencyMs: 0,
			tokenEstimate: 0,
			riskCost: 0,
			contextCost: 0,
		});
		const decision = decideExpectedUtility(candidates);
		const firstTool = this.firstToolInTurn;
		const selection = this.selectionSnapshot(decision, firstTool);
		// Evaluated BEFORE this call is recorded, so it reflects evidence up to (not including) this
		// observation — captured now because complete() (later, async) can no longer distinguish
		// "before" from "after" once the store has been written.
		const hintActiveAtCallTime = this.observeEnabled
			? this.evaluatePromotion(modelRef, intentClass).tool !== undefined
			: false;
		const pending: ToolSelectionPendingObservation = {
			id: toolCallId,
			key: modelToolKey(modelRef, intentClass, toolName),
			firstTool: this.firstToolInTurn,
			startedAt: Date.now(),
			inputTokenEstimate: estimateTokens(args),
			selection,
			hintActiveAtCallTime,
		};
		this.firstToolInTurn = false;
		this.pending.set(toolCallId, pending);
		return pending;
	}

	complete(toolCallId: string, succeeded: boolean, content: readonly unknown[] = []): void {
		const pending = this.pending.get(toolCallId);
		if (!pending) return;
		this.pending.delete(toolCallId);
		if (!this.observeEnabled) return;
		const execution: ToolExecutionObservation = {
			key: pending.key,
			success: succeeded,
			latencyMs: Math.max(0, Date.now() - pending.startedAt),
			inputTokenEstimate: pending.inputTokenEstimate,
			outputTokenEstimate: estimateContentTokens(content),
			selection: pending.selection,
			hintActiveAtCallTime: pending.hintActiveAtCallTime,
		};
		this.deps.store.recordExecution(execution);
	}

	recordValidation(toolName: string, outcome: "repaired" | "bounced"): void {
		if (!this.observeEnabled) return;
		const modelRef = this.deps.getModelRef();
		const tool = this.deps.getActiveTools().find((candidate) => candidate.name === toolName) ?? { name: toolName };
		this.deps.store.recordValidation(modelToolKey(modelRef, classifyToolIntent(tool), toolName), outcome);
	}

	/**
	 * Evidence-gated promotion for one (model,intent) bucket — see promotion.ts. Pure read, no
	 * mutation; used both to stamp `hintActiveAtCallTime` and to build the live hint list below.
	 */
	private evaluatePromotion(modelRef: string, intentClass: ToolSelectionIntentClass) {
		return evaluateToolPromotion(this.deps.store.getStatsForIntent(modelRef, intentClass));
	}

	/**
	 * The currently active evidence-gated hints for the session's current model — one per
	 * (intentClass) at most, only where accumulated evidence clears the promotion gate. Consumed by
	 * `system-prompt-builder.ts` to render a compact, cache-stable prompt block. Empty when the
	 * hint kill switch (`PI_TOOL_SELECTION_HINTS=0`) is set, observing is disabled, or no bucket has
	 * cleared the gate yet.
	 */
	getActiveHints(modelRef: string = this.deps.getModelRef()): ToolSelectionHint[] {
		if ((this.deps.env ?? process.env).PI_TOOL_SELECTION_HINTS === "0") return [];
		if (!this.observeEnabled) return [];
		const hints: ToolSelectionHint[] = [];
		for (const intentClass of INTENT_CLASSES) {
			const promotion = this.evaluatePromotion(modelRef, intentClass);
			if (!promotion.tool) continue;
			hints.push({
				modelRef,
				intentClass,
				tool: promotion.tool,
				sampleCount: promotion.sampleCount,
				margin: promotion.margin,
				entropy: promotion.entropy,
			});
		}
		return hints;
	}

	/**
	 * Report surface for the observe/agreement/promotion loop: per (model,intent), the durable
	 * agreement rate (did the raw ranking's top pick match what was actually called), plus the
	 * currently active hint (if any) and its own efficacy (agreement rate while it has been active).
	 * A read-only diagnostic — never used to gate behavior. Render with
	 * {@link formatToolSelectionReport}.
	 */
	getReport(modelRef: string = this.deps.getModelRef()): ToolSelectionReportEntry[] {
		const activeHints = new Map(this.getActiveHints(modelRef).map((hint) => [hint.intentClass, hint]));
		return this.deps.store
			.getAllIntentAgreements(modelRef)
			.filter((agreement) => agreement.sampleCount > 0)
			.map((agreement) => ({
				modelRef: agreement.modelRef,
				intentClass: agreement.intentClass,
				sampleCount: agreement.sampleCount,
				agreementRate: agreement.agreementCount / agreement.sampleCount,
				hintTool: activeHints.get(agreement.intentClass)?.tool,
				hintSampleCount: agreement.hintActiveSampleCount,
				hintAgreementRate:
					agreement.hintActiveSampleCount > 0
						? agreement.hintActiveAgreementCount / agreement.hintActiveSampleCount
						: undefined,
			}));
	}

	private selectionSnapshot(
		decision: ToolSelectionDecision,
		firstTool: boolean,
	): ToolSelectionPendingObservation["selection"] {
		return {
			firstTool,
			disposition: decision.disposition,
			recommendation: decision.recommendation,
			shortlist: decision.shortlist,
			entropy: decision.entropy,
			margin: decision.margin,
			ranked: decision.ranked.map((candidate) => ({
				tool: candidate.tool,
				utility: candidate.utility,
				probability: candidate.probability,
			})),
		};
	}
}

/** Renders {@link ToolSelectionController.getReport} rows into the /toolhealth-style diagnostic text. */
export function formatToolSelectionReport(entries: readonly ToolSelectionReportEntry[]): string {
	if (entries.length === 0) {
		return "Tool-selection loop: no observations recorded yet for this host.";
	}
	const sorted = [...entries].sort(
		(left, right) => left.modelRef.localeCompare(right.modelRef) || left.intentClass.localeCompare(right.intentClass),
	);
	const lines = ["Tool-selection loop (observe -> agreement -> evidence-gated hint)"];
	for (const entry of sorted) {
		const agreementText =
			entry.agreementRate === undefined
				? "n/a"
				: `${Math.round(entry.agreementRate * 100)}% (n=${entry.sampleCount})`;
		lines.push(`  ${entry.modelRef} / ${entry.intentClass}: agreement ${agreementText}`);
		if (entry.hintTool) {
			const hintAgreementText =
				entry.hintAgreementRate === undefined
					? "n/a"
					: `${Math.round(entry.hintAgreementRate * 100)}% (n=${entry.hintSampleCount})`;
			lines.push(`    hint active: prefer \`${entry.hintTool}\` — agreement while active ${hintAgreementText}`);
		}
	}
	return lines.join("\n");
}

export { classifyToolIntent, estimateContentTokens, estimateTokens };
