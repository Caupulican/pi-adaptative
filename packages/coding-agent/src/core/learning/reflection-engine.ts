import type { Usage } from "@caupulican/pi-ai";
import {
	OKF_MEMORY_LIMITS,
	PI_OKF_TYPES,
	type PiOkfType,
	validateOkfMemoryDocumentInput,
} from "../context/okf-memory.ts";
import { REFLECTION_SYSTEM_PROMPT } from "../provider-prompt-contracts.ts";
import { MAX_ACTIVE_SKILL_BODY_BYTES } from "../skill-vault.ts";
import { MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_NAME_LENGTH } from "../skills.ts";

export { REFLECTION_SYSTEM_PROMPT };

export type StopReason = "stop" | "toolUse" | "aborted" | "error" | string;

export interface IsolatedCompletionResult {
	text: string;
	usage: Usage;
	stopReason: StopReason;
}

export type ReflectionTrigger = "complex" | "corrective" | "durable" | "session-end" | "none";

export interface DemandSignals {
	trigger: ReflectionTrigger;
	toolCallCount: number;
	hadCorrection: boolean;
	contextHeadroomPct: number; // 0..100
	usefulLately: number; // 0..1 rolling score
}

export interface DemandPlan {
	act: "skip" | "reflect";
	reason: string;
	tokenBudget: number;
}

/**
 * Pure zero-I/O heuristic to decide whether the current turn justifies a reflection run
 * and determine the token budget under the cheap-tool net-negative doctrine.
 */
export function decideDemand(signals: DemandSignals): DemandPlan {
	if (signals.trigger === "none") {
		return { act: "skip", reason: "No trigger detected", tokenBudget: 0 };
	}
	if (signals.contextHeadroomPct < 10) {
		return { act: "skip", reason: "Context headroom is critically low (< 10%)", tokenBudget: 0 };
	}

	// Dynamic token budget based on headroom (keep reflection bounded between 500 and 1500 tokens)
	const baseBudget = 1000;
	const tokenBudget = Math.max(500, Math.min(1500, Math.round(baseBudget * (signals.contextHeadroomPct / 100))));

	if (signals.hadCorrection) {
		return { act: "reflect", reason: "Correction detected in the turn", tokenBudget };
	}
	if (signals.trigger === "durable") {
		return { act: "reflect", reason: "Durable fact or preference detected in the turn", tokenBudget };
	}
	if (signals.trigger === "session-end") {
		return { act: "reflect", reason: "Session end reflection triggered", tokenBudget };
	}
	if (signals.trigger === "complex") {
		if (signals.toolCallCount >= 3) {
			return { act: "reflect", reason: `Complex turn with ${signals.toolCallCount} tool calls`, tokenBudget };
		}
	}

	return { act: "skip", reason: "Signals do not justify reflection overhead", tokenBudget: 0 };
}

export interface ReflectionInput {
	recentTurnText: string; // host serializes the just-finished turn
	existingMemory: string; // current MEMORY.md + USER.md snapshot
	plan: DemandPlan;
	// host-injected isolated completion function:
	complete: (systemPrompt: string, userPrompt: string) => Promise<IsolatedCompletionResult>;
}

export type ReflectionWrite =
	| { kind: "memory_add"; section: "MEMORY" | "USER"; text: string }
	| {
			kind: "okf_add";
			type: PiOkfType;
			title: string;
			description: string;
			scope: "project";
			text: string;
			tags?: string[];
			evidenceRefs: string[];
	  }
	| {
			kind: "okf_organize";
			type: PiOkfType;
			title: string;
			description: string;
			scope: "project";
			text: string;
			sourceText: string;
			tags?: string[];
			evidenceRefs: string[];
	  }
	| { kind: "memory_replace"; target: string; text: string }
	| { kind: "memory_remove"; target: string }
	// R7 memory-to-behavior: promote a recurring procedural workflow into an executable skill.
	| { kind: "promote_skill"; name: string; description: string; body: string };

export interface ReflectionResult {
	writes: ReflectionWrite[];
	usage: Usage;
	rationale: string;
}

/** Maximum number of durable writes accepted from one isolated reflection response. */
export const MAX_REFLECTION_WRITES = 32;
/** Maximum number of response entries inspected while looking for accepted writes. */
export const MAX_REFLECTION_SCAN_ENTRIES = MAX_REFLECTION_WRITES * 4;

type StructuredReflectionWrite = Extract<ReflectionWrite, { kind: "okf_add" | "okf_organize" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** A rendered hot-memory section header: the general file or a project file, never USER.md or OKF. */
const HOT_MEMORY_SECTION_RE = /^## MEMORY\.md(?: \([^)\n]*\))?:\n/gm;

/**
 * The hot-memory lines an organize write may cite: every `## MEMORY.md …:` section of the rendered
 * persistent-memory block (the general file and the project file each render as one), cut at the
 * next section header or at fenced untrusted content. Neither USER.md nor OKF text is hot memory.
 */
function currentHotMemory(existingMemory: string): string {
	const sections: string[] = [];
	for (const match of existingMemory.matchAll(HOT_MEMORY_SECTION_RE)) {
		const body = existingMemory.slice(match.index + match[0].length);
		const boundaries = [body.indexOf("\n## "), body.search(/<\s*untrusted_content\b/i)].filter((index) => index >= 0);
		sections.push(boundaries.length > 0 ? body.slice(0, Math.min(...boundaries)) : body);
	}
	if (sections.length > 0) return sections.join("\n");
	// Unit callers may provide a raw MEMORY.md snapshot. A rendered persistent-memory block without a
	// hot-memory section, however, proves that the hot files are empty; never treat OKF text as hot memory.
	return existingMemory.includes("=== Persistent Memory (file-store) ===") ||
		/<\s*untrusted_content\b/i.test(existingMemory)
		? ""
		: existingMemory;
}

function containsExactHotMemoryItem(existingMemory: string, sourceText: string): boolean {
	if (sourceText.length === 0) return false;
	const memoryLines = currentHotMemory(existingMemory).split("\n");
	const sourceLines = sourceText.split("\n");
	return memoryLines.some((_, index) => sourceLines.every((line, offset) => memoryLines[index + offset] === line));
}

function boundedText(value: unknown, maxChars: number): value is string {
	return typeof value === "string" && value.length <= maxChars;
}

function boundedSkillBody(value: unknown): value is string {
	return typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_ACTIVE_SKILL_BODY_BYTES;
}

/** One parser/validation path for both structured reflection operations. */
function parseStructuredReflectionWrite(value: unknown, existingMemory: string): StructuredReflectionWrite | undefined {
	if (!isRecord(value) || (value.kind !== "okf_add" && value.kind !== "okf_organize")) return undefined;
	if (
		!PI_OKF_TYPES.includes(value.type as PiOkfType) ||
		typeof value.title !== "string" ||
		typeof value.description !== "string" ||
		value.scope !== "project" ||
		typeof value.text !== "string" ||
		!isStringArray(value.evidenceRefs) ||
		value.evidenceRefs.length === 0 ||
		(value.tags !== undefined && !isStringArray(value.tags))
	) {
		return undefined;
	}
	const common = {
		type: value.type as PiOkfType,
		title: value.title,
		description: value.description,
		scope: "project" as const,
		text: value.text,
		...(value.tags !== undefined ? { tags: value.tags } : {}),
		evidenceRefs: value.evidenceRefs,
	};
	let write: StructuredReflectionWrite;
	if (value.kind === "okf_organize") {
		if (
			typeof value.sourceText !== "string" ||
			value.sourceText.length === 0 ||
			value.sourceText.length > OKF_MEMORY_LIMITS.bodyChars ||
			!containsExactHotMemoryItem(existingMemory, value.sourceText)
		) {
			return undefined;
		}
		write = { kind: "okf_organize", ...common, sourceText: value.sourceText };
	} else {
		write = { kind: "okf_add", ...common };
	}
	return validateOkfMemoryDocumentInput(
		{
			type: write.type,
			title: write.title,
			description: write.description,
			scope: write.scope,
			body: write.text,
			tags: write.tags,
			evidenceRefs: write.evidenceRefs,
		},
		{ projectOnly: true, requireEvidence: true },
	).length === 0
		? write
		: undefined;
}

/**
 * STATIC reflection system prompt (Hermes-parity #33). It is byte-identical across every reflection
 * pass — the variable parts (existing memory snapshot + the turn transcript) live in the USER prompt —
 * so the provider prompt-cache reuses this prefix instead of re-billing it each pass (cost guard).
 * Do NOT interpolate per-call data into this constant or caching breaks.
 */
export class ReflectionEngine {
	/**
	 * Build the reflection prompt, call the injected isolated complete(),
	 * parse the response, confront existing memory, and return memory writes.
	 * Zero direct I/O.
	 */
	async reflect(input: ReflectionInput): Promise<ReflectionResult> {
		const systemPrompt = REFLECTION_SYSTEM_PROMPT;

		// Variable inputs go in the USER prompt so the system prefix above stays cache-stable (#33).
		const userPrompt = `Existing memory:
${input.existingMemory}

Recent turn transcript:
${input.recentTurnText}

Return JSON updates.`;

		let usage: Usage | undefined;
		try {
			const compResult = await input.complete(systemPrompt, userPrompt);
			usage = compResult.usage;
			const text = compResult.text;

			const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/{[\s\S]*}/);
			if (!jsonMatch) {
				return {
					writes: [],
					usage: compResult.usage,
					rationale: `Failed to locate JSON response. Raw text:\n${text}`,
				};
			}

			const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
			const rationale = parsed.rationale || "";
			const writes: ReflectionWrite[] = [];

			if (Array.isArray(parsed.writes)) {
				const scanCount = Math.min(parsed.writes.length, MAX_REFLECTION_SCAN_ENTRIES);
				for (let index = 0; index < scanCount && writes.length < MAX_REFLECTION_WRITES; index++) {
					const w = parsed.writes[index];
					if (w && typeof w === "object") {
						const structuredWrite = parseStructuredReflectionWrite(w, input.existingMemory);
						if (
							w.kind === "memory_add" &&
							(w.section === "MEMORY" || w.section === "USER") &&
							boundedText(w.text, OKF_MEMORY_LIMITS.bodyChars)
						) {
							writes.push({ kind: "memory_add", section: w.section, text: w.text });
						} else if (structuredWrite) {
							writes.push(structuredWrite);
						} else if (
							w.kind === "memory_replace" &&
							boundedText(w.target, OKF_MEMORY_LIMITS.bodyChars) &&
							boundedText(w.text, OKF_MEMORY_LIMITS.bodyChars)
						) {
							writes.push({ kind: "memory_replace", target: w.target, text: w.text });
						} else if (w.kind === "memory_remove" && boundedText(w.target, OKF_MEMORY_LIMITS.bodyChars)) {
							writes.push({ kind: "memory_remove", target: w.target });
						} else if (
							w.kind === "promote_skill" &&
							boundedText(w.name, MAX_SKILL_NAME_LENGTH) &&
							boundedText(w.description, MAX_SKILL_DESCRIPTION_LENGTH) &&
							boundedSkillBody(w.body)
						) {
							writes.push({ kind: "promote_skill", name: w.name, description: w.description, body: w.body });
						}
					}
				}
			}

			return {
				writes,
				usage: compResult.usage,
				rationale,
			};
		} catch (err) {
			// Zeroed/fallback usage representation
			const emptyUsage: Usage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			return {
				writes: [],
				usage: usage ?? emptyUsage,
				rationale: `Error during reflection: ${String(err)}`,
			};
		}
	}
}
