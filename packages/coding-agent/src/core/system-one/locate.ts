/**
 * `systemone locate`: where does X live, answered by judgment over the code instead of reading raw hits.
 *
 * The caller chooses literal or regex queries; the host owns everything else. Deterministic code finds the
 * candidate files and cuts one short excerpt per file (locate-candidates.ts), System One answers one closed
 * Noul per candidate over that excerpt ("does it define or implement what the target describes?"), and code
 * ranks and thresholds the answers. Questions never see each other's answers and the answers never go back to
 * a model as conclusions: the caller gets a short ranked list and still reads the file it will edit, because a
 * label is not proof. When System One is unavailable the lexical ranking is returned marked `unjudged`.
 */

import { isNoulProbability, noulBand } from "../decision/noul.ts";
import type { CredentialExposureBoundary } from "../secrets/credential-exposure-guard.ts";
import type { JevAdapter } from "./adapter.ts";
import { type QuestionDefinition, SYSTEM_ONE_PINNED_MODEL, toTypeSafeEvaluationQuestions } from "./catalog.ts";
import { SYSTEM_ONE_SCAN_CONCURRENCY } from "./code-duplicates.ts";
import { SYSTEM_ONE_STAGE_DEADLINE_MS } from "./controller.ts";
import {
	clipLine,
	collectLocateCandidates,
	type LocateCandidate,
	type LocateSearch,
	resolveLocateRoots,
	ripgrepLocateSearch,
} from "./locate-candidates.ts";
import { type LocateInput, LocateInputError, normalizeLocateInput } from "./locate-input.ts";
import { type EvaluationBatch, planEvaluationBatches } from "./model-evaluation-batches.ts";
import type { SemanticEvaluationObserver } from "./semantic-evaluation-ledger.ts";

export const LOCATE_PROGRAM_ID = "system-one:locate";
/** Questions per System One request; System One evaluates them in parallel. */
export const LOCATE_QUESTIONS_PER_REQUEST = 25;
const LOCATE_HEAD_WIDTH = 100;
/** Reason lines kept per request on the evaluation ledger. */
const LEDGER_REASONS = 3;
/** Answers shown before a list is topped up with candidates below the floor. */
const MIN_SHOWN = 3;

export interface LocateMatch {
	readonly path: string;
	readonly line: number;
	/** P(the excerpt defines or implements the target); absent for an unjudged candidate. */
	readonly probability?: number;
	readonly matchLine: string;
}

/** What one System One request cost, for the ledger and for measurement. */
export interface LocateRequestStats {
	readonly questions: number;
	readonly bytes: number;
	readonly latencyMs: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly failed: boolean;
}

export interface LocateOutcome {
	/** The model-facing result. */
	readonly text: string;
	/** At or above the noul acceptance floor, ranked: probability descending, path ascending on ties. */
	readonly matches: readonly LocateMatch[];
	/** Shown below the floor when fewer than a few answers reached it: the highest-probability remainder. */
	readonly closest: readonly LocateMatch[];
	/** Whether at least one candidate was judged; false marks the lexical fallback. */
	readonly judged: boolean;
	readonly candidates: number;
	readonly filesMatched: number;
	readonly requests: readonly LocateRequestStats[];
}

export interface FileLocatorDeps {
	getCwd(): string;
	/** The judge; undefined while System One is not bound to the session. */
	getAdapter(): Pick<JevAdapter, "evaluate"> | undefined;
	getObserver(): SemanticEvaluationObserver | undefined;
	redact(text: string): string;
	credentialBoundary?: CredentialExposureBoundary;
	search?: LocateSearch;
	concurrency?: number;
}

export function locateQuestionId(index: number): string {
	return `locate_c${index}`;
}

function locateQuestion(index: number): QuestionDefinition {
	return {
		type: "boolean",
		instructions: `Is \`c${index}\` the code that \`target\` asks about?`,
		criteria: {
			true: "Yes: this file defines or performs it",
			false: "No: it only refers to, calls, tests or documents it, or is about something else",
		},
	};
}

/** What the judge reads about one file: its path, what it says it is, what it declares, and the window around the hit. */
function fileCard(candidate: LocateCandidate): Record<string, string> {
	return {
		path: candidate.path,
		...(candidate.doc ? { purpose: candidate.doc } : {}),
		...(candidate.declarations.length > 0 ? { declares: candidate.declarations.join(", ") } : {}),
		excerpt: candidate.excerpt,
	};
}

function byProbability(a: LocateMatch, b: LocateMatch): number {
	return (
		(b.probability ?? 0) - (a.probability ?? 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line
	);
}

function matchOf(candidate: LocateCandidate, probability?: number): LocateMatch {
	return {
		path: candidate.path,
		line: candidate.line,
		matchLine: candidate.matchLine,
		...(probability !== undefined ? { probability } : {}),
	};
}

function describeMatch(match: LocateMatch, tag: string): string {
	return `${match.path}:${match.line}  ${tag}  ${clipLine(match.matchLine, LOCATE_HEAD_WIDTH)}`;
}

interface Judgment {
	readonly probabilities: ReadonlyMap<number, number>;
	readonly requests: readonly LocateRequestStats[];
	/** Why some or all candidates went unjudged; undefined when every request answered. */
	readonly failure?: string;
}

/** The session owner's file locator: deterministic search, System One judgment, code ranking. */
export class FileLocator {
	private readonly deps: FileLocatorDeps;

	constructor(deps: FileLocatorDeps) {
		this.deps = deps;
	}

	async locate(input: LocateInput, signal?: AbortSignal): Promise<LocateOutcome> {
		const { target, queries, limit } = normalizeLocateInput(input);
		const cwd = this.deps.getCwd();
		const roots = await resolveLocateRoots(input.paths, cwd, this.deps.credentialBoundary);
		const set = await collectLocateCandidates({
			queries,
			roots,
			cwd,
			redact: this.deps.redact,
			search: this.deps.search ?? ripgrepLocateSearch(),
			...(this.deps.credentialBoundary ? { credentialBoundary: this.deps.credentialBoundary } : {}),
			...(signal ? { signal } : {}),
		});
		if (set.invalidQueries.length === queries.length)
			throw new LocateInputError(`No query could run: ${set.invalidQueries[0]!.message}`);
		const header = [
			...set.invalidQueries.map((entry) => `Query not run (${entry.query}): ${entry.message}`),
			...set.truncatedQueries.map((query) => `Query matched too much to search fully (${query}); narrow it.`),
			...(set.excluded > 0
				? [`${set.excluded} matching files left out (out of scope, protected, binary or too large).`]
				: []),
			...(set.beyondCap > 0
				? [`${set.beyondCap} further matching files were not judged; narrow the queries or paths.`]
				: []),
		];
		if (set.candidates.length === 0)
			return {
				text: [...header, "No file contains a hit for the queries."].join("\n"),
				matches: [],
				closest: [],
				judged: false,
				candidates: 0,
				filesMatched: set.filesMatched,
				requests: [],
			};
		const judgment = await this.judge(target, set.candidates, signal);
		return this.present(set.candidates, judgment, limit, header, set.filesMatched);
	}

	private async judge(
		target: string,
		candidates: readonly LocateCandidate[],
		signal?: AbortSignal,
	): Promise<Judgment> {
		const adapter = this.deps.getAdapter();
		if (!adapter)
			return { probabilities: new Map(), requests: [], failure: "System One is not bound to this session" };
		const shared = this.deps.redact(target);
		let batches: readonly EvaluationBatch<Record<string, unknown>>[];
		try {
			batches = planEvaluationBatches<Record<string, unknown>>({
				count: candidates.length,
				model: SYSTEM_ONE_PINNED_MODEL,
				empty: () => ({ target: shared }),
				withItem: (state, index) => ({
					...state,
					[`c${index}`]: fileCard(candidates[index]!),
				}),
				questionId: locateQuestionId,
				question: locateQuestion,
				maxQuestions: LOCATE_QUESTIONS_PER_REQUEST,
			});
		} catch (error) {
			return {
				probabilities: new Map(),
				requests: [],
				failure: error instanceof Error ? error.message : String(error),
			};
		}
		const probabilities = new Map<number, number>();
		const requests: LocateRequestStats[] = [];
		let failure: string | undefined;
		let next = 0;
		const worker = async () => {
			while (next < batches.length) {
				const batch = batches[next++];
				if (!batch) break;
				const observer = this.deps.getObserver();
				const evaluationId = observer?.start({
					programId: LOCATE_PROGRAM_ID,
					consequence: "low",
					model: SYSTEM_ONE_PINNED_MODEL,
				});
				const wire = toTypeSafeEvaluationQuestions(batch.questions);
				const bytes = Buffer.byteLength(JSON.stringify({ state: batch.state, questions: wire }));
				const started = Date.now();
				try {
					const response = await adapter.evaluate(
						{ state: batch.state, questions: wire },
						{ impact: "read_only", timeoutMs: SYSTEM_ONE_STAGE_DEADLINE_MS, ...(signal ? { signal } : {}) },
					);
					const scored: LocateMatch[] = [];
					for (const index of batch.indexes) {
						const answer = response.answers[locateQuestionId(index)] as { noul?: unknown } | undefined;
						if (!isNoulProbability(answer?.noul)) continue;
						probabilities.set(index, answer.noul);
						scored.push(matchOf(candidates[index]!, answer.noul));
					}
					requests.push({
						questions: batch.indexes.length,
						bytes,
						latencyMs: Date.now() - started,
						...(response.usage?.input_tokens !== undefined ? { inputTokens: response.usage.input_tokens } : {}),
						...(response.usage?.output_tokens !== undefined
							? { outputTokens: response.usage.output_tokens }
							: {}),
						failed: false,
					});
					if (evaluationId !== undefined)
						observer?.settleOk(
							evaluationId,
							"evaluated",
							scored
								.sort(byProbability)
								.slice(0, LEDGER_REASONS)
								.map((match) => `${match.path}:${match.line} P(implements)=${match.probability!.toFixed(2)}`),
						);
				} catch (error) {
					requests.push({ questions: batch.indexes.length, bytes, latencyMs: Date.now() - started, failed: true });
					if (signal?.aborted) {
						if (evaluationId !== undefined) observer?.settleCancelled(evaluationId);
						throw error;
					}
					if (evaluationId !== undefined) observer?.settleFailed(evaluationId, error);
					failure ??= error instanceof Error ? error.message : String(error);
				}
			}
		};
		await Promise.all(
			Array.from({ length: Math.min(this.deps.concurrency ?? SYSTEM_ONE_SCAN_CONCURRENCY, batches.length) }, worker),
		);
		const unanswered = candidates.length - probabilities.size;
		return {
			probabilities,
			requests,
			...(unanswered > 0 ? { failure: failure ?? "System One returned no answer for some candidates" } : {}),
		};
	}

	private present(
		candidates: readonly LocateCandidate[],
		judgment: Judgment,
		limit: number,
		header: readonly string[],
		filesMatched: number,
	): LocateOutcome {
		const judged = candidates.flatMap((candidate, index) => {
			const probability = judgment.probabilities.get(index);
			return probability === undefined ? [] : [matchOf(candidate, probability)];
		});
		const unjudged = candidates.flatMap((candidate, index) =>
			judgment.probabilities.has(index) ? [] : [matchOf(candidate)],
		);
		const accepted = judged
			.filter((match) => {
				const band = noulBand(match.probability!, "required_true");
				return band === "hard_pass" || band === "soft_pass";
			})
			.sort(byProbability);
		const below = judged.length - accepted.length;
		const lines = [...header];
		const summary = `judged ${judged.length} of ${candidates.length} candidate files in ${judgment.requests.length} request${judgment.requests.length === 1 ? "" : "s"}`;
		if (judged.length === 0) {
			lines.push(
				`locate unjudged (${judgment.failure ?? "no judgment ran"}): lexical ranking by hit count, not a claim about where the target lives.`,
			);
			lines.push(
				...candidates
					.slice(0, limit)
					.map((candidate) => describeMatch(matchOf(candidate), `hits=${candidate.hitCount}`)),
			);
			const rest = candidates.length - limit;
			if (rest > 0) lines.push(`${rest} more candidate files not listed; re-run with narrower queries.`);
			return {
				text: lines.join("\n"),
				matches: [],
				closest: [],
				judged: false,
				candidates: candidates.length,
				filesMatched,
				requests: judgment.requests,
			};
		}
		lines.push(`locate: ${summary}.`);
		lines.push(
			...accepted.slice(0, limit).map((match) => describeMatch(match, `p=${match.probability!.toFixed(2)}`)),
		);
		// Calibration is coarse: a right file often scores under the floor. Fewer than a few accepted answers are
		// topped up with the best of the rest, labeled, so the caller is never left without somewhere to look.
		const closest = judged
			.filter((match) => !accepted.includes(match))
			.sort(byProbability)
			.slice(0, Math.max(0, Math.min(MIN_SHOWN, limit) - accepted.length));
		if (closest.length > 0) {
			lines.push(
				accepted.length === 0
					? "No candidate reached the acceptance floor. Highest below it:"
					: "Next, below the acceptance floor:",
			);
			lines.push(
				...closest.map((match) => describeMatch(match, `p=${match.probability!.toFixed(2)} (below floor)`)),
			);
		}
		const notes: string[] = [];
		if (accepted.length > limit) notes.push(`${accepted.length - limit} more at or above the floor not listed`);
		if (below - closest.length > 0) notes.push(`${below - closest.length} further below the floor`);
		if (unjudged.length > 0) notes.push(`${unjudged.length} unjudged (${judgment.failure ?? "no answer"})`);
		if (notes.length > 0) lines.push(`${notes.join("; ")}. Re-run with narrower queries to refine.`);
		if (unjudged.length > 0)
			lines.push(
				...unjudged
					.slice(0, Math.max(0, limit - accepted.length - closest.length))
					.map((match) => describeMatch(match, "unjudged")),
			);
		lines.push("A ranking is not proof: read the file before editing it.");
		return {
			text: lines.join("\n"),
			matches: accepted,
			closest,
			judged: true,
			candidates: candidates.length,
			filesMatched,
			requests: judgment.requests,
		};
	}
}
