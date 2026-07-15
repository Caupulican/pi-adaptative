import {
	decideExpectedUtility,
	type ExpectedUtilityCandidate,
	type ToolSelectionDecision,
} from "./expected-utility.ts";
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
}

export interface ToolSelectionPendingObservation {
	id: string;
	key: ToolPerformanceKey;
	firstTool: boolean;
	startedAt: number;
	inputTokenEstimate?: number;
	selection: Omit<ToolSelectionObservation, "at" | "modelRef" | "intentClass" | "actualTool" | "succeeded">;
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

	constructor(deps: ToolSelectionControllerDeps) {
		this.deps = deps;
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
		const pending: ToolSelectionPendingObservation = {
			id: toolCallId,
			key: modelToolKey(modelRef, intentClass, toolName),
			firstTool: this.firstToolInTurn,
			startedAt: Date.now(),
			inputTokenEstimate: estimateTokens(args),
			selection,
		};
		this.firstToolInTurn = false;
		this.pending.set(toolCallId, pending);
		return pending;
	}

	complete(toolCallId: string, succeeded: boolean, content: readonly unknown[] = []): void {
		const pending = this.pending.get(toolCallId);
		if (!pending) return;
		this.pending.delete(toolCallId);
		const execution: ToolExecutionObservation = {
			key: pending.key,
			success: succeeded,
			latencyMs: Math.max(0, Date.now() - pending.startedAt),
			inputTokenEstimate: pending.inputTokenEstimate,
			outputTokenEstimate: estimateContentTokens(content),
			selection: pending.selection,
		};
		this.deps.store.recordExecution(execution);
	}

	recordValidation(toolName: string, outcome: "repaired" | "bounced"): void {
		const modelRef = this.deps.getModelRef();
		const tool = this.deps.getActiveTools().find((candidate) => candidate.name === toolName) ?? { name: toolName };
		this.deps.store.recordValidation(modelToolKey(modelRef, classifyToolIntent(tool), toolName), outcome);
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

export { classifyToolIntent, estimateContentTokens, estimateTokens };
