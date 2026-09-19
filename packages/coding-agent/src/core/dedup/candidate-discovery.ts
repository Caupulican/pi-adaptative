/**
 * Deterministic Candidate Discovery for Semantic Deduplication.
 * Implements S1A-203..S1A-207, S1A-214, S1A-215, and PH-134..PH-139.
 * Bounded candidate limit: 12.
 */

import type { ResponsibilityRegistry } from "./responsibility-registry.ts";
import type { ResponsibilityCandidate, ResponsibilityStatement } from "./types.ts";

export const CANDIDATE_LIMIT = 12;

export interface CandidateDiscoveryCoverage {
	readonly attemptedMethods: readonly string[];
	readonly succeededMethods: readonly string[];
	readonly failures: readonly { readonly method: string; readonly error: string }[];
	readonly candidateCount: number;
	readonly coverageClass: "full" | "degraded" | "failed";
}

export interface DiscoveredCandidates extends Array<ResponsibilityCandidate> {
	readonly coverage: CandidateDiscoveryCoverage;
}

export interface CandidateDiscoveryDeps {
	readonly registry: ResponsibilityRegistry;
	readonly codeSearcher?: {
		searchKeywords(keywords: readonly string[]): Promise<readonly { file: string; line: number; snippet: string }[]>;
	};
	readonly cloneChecker?: {
		findClones(location: string, content?: string): Promise<readonly { targetFile: string; similarity: number }[]>;
	};
	readonly symbolGraph?: {
		findReferences(symbol: string): Promise<readonly { file: string; line: number }[]>;
	};
	readonly astAnalyzer?: {
		findStructuralMatches(signature: string): Promise<readonly { file: string; matchType: string }[]>;
	};
	readonly semanticIndex?: {
		searchSemantic(query: string): Promise<readonly { id: string; text: string; score: number }[]>;
	};
}

export class CandidateDiscoveryService {
	private readonly registry: ResponsibilityRegistry;
	private readonly codeSearcher?: CandidateDiscoveryDeps["codeSearcher"];
	private readonly cloneChecker?: CandidateDiscoveryDeps["cloneChecker"];
	private readonly symbolGraph?: CandidateDiscoveryDeps["symbolGraph"];
	private readonly astAnalyzer?: CandidateDiscoveryDeps["astAnalyzer"];
	private readonly semanticIndex?: CandidateDiscoveryDeps["semanticIndex"];

	constructor(deps: CandidateDiscoveryDeps) {
		this.registry = deps.registry;
		this.codeSearcher = deps.codeSearcher;
		this.cloneChecker = deps.cloneChecker;
		this.symbolGraph = deps.symbolGraph;
		this.astAnalyzer = deps.astAnalyzer;
		this.semanticIndex = deps.semanticIndex;
	}

	/**
	 * Discovers candidates for a proposed responsibility statement across the bounded methods.
	 * Returns at most 12 candidates sorted by relevance score, with coverage metadata.
	 */
	async findCandidates(proposed: ResponsibilityStatement): Promise<DiscoveredCandidates> {
		const candidatesMap = new Map<string, ResponsibilityCandidate>();
		const attemptedMethods: string[] = [];
		const succeededMethods: string[] = [];
		const failures: { method: string; error: string }[] = [];

		// 1. Check ResponsibilityRegistry (PH-134, S1A-207)
		attemptedMethods.push("responsibility_registry");
		try {
			const registryMatches = this.registry.findCandidates(proposed.statement, proposed.targetLocation);
			for (const rec of registryMatches) {
				candidatesMap.set(rec.responsibility_id, {
					id: rec.responsibility_id,
					statement: rec.statement,
					locations: rec.owner_locations,
					matchMethod: "responsibility_registry",
					score: 0.95,
					compact: {
						id: rec.responsibility_id,
						statement: rec.statement,
						locations: rec.owner_locations,
						source_revision: rec.source_revision,
					},
				});
			}
			succeededMethods.push("responsibility_registry");
		} catch (err) {
			failures.push({
				method: "responsibility_registry",
				error: err instanceof Error ? err.message : String(err),
			});
		}

		// 2. Extract symbol and identifier signals (PH-136, S1A-205)
		const words = proposed.statement
			.toLowerCase()
			.split(/\W+/)
			.filter((w) => w.length > 2);
		const keySymbols = words.filter(
			(w) => !["the", "and", "for", "only", "when", "with", "from", "that", "this"].includes(w),
		);

		// 3. Search codebase if searcher available
		if (this.codeSearcher && keySymbols.length > 0) {
			attemptedMethods.push("repo_search");
			try {
				const hits = await this.codeSearcher.searchKeywords(keySymbols.slice(0, 4));
				for (const hit of hits) {
					const hitId = `search_${hit.file}_${hit.line}`;
					if (!candidatesMap.has(hitId)) {
						candidatesMap.set(hitId, {
							id: hitId,
							statement: hit.snippet,
							locations: [hit.file],
							matchMethod: "repo_search",
							score: 0.8,
							compact: {
								id: hitId,
								file: hit.file,
								line: hit.line,
								snippet: hit.snippet,
							},
						});
					}
				}
				succeededMethods.push("repo_search");
			} catch (err) {
				failures.push({
					method: "repo_search",
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// 4. Check textual clone signals if available (PH-135, S1A-204)
		if (this.cloneChecker) {
			attemptedMethods.push("textual_clone");
			try {
				const clones = await this.cloneChecker.findClones(proposed.targetLocation);
				for (const clone of clones) {
					const cloneId = `clone_${clone.targetFile}`;
					if (!candidatesMap.has(cloneId)) {
						candidatesMap.set(cloneId, {
							id: cloneId,
							statement: `Textual clone in ${clone.targetFile} with similarity ${clone.similarity}`,
							locations: [clone.targetFile],
							matchMethod: "textual_clone",
							score: clone.similarity,
							compact: {
								id: cloneId,
								targetFile: clone.targetFile,
								similarity: clone.similarity,
							},
						});
					}
				}
				succeededMethods.push("textual_clone");
			} catch (err) {
				failures.push({
					method: "textual_clone",
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// 5. Symbol graph / references if available (PH-136)
		if (this.symbolGraph && keySymbols.length > 0) {
			attemptedMethods.push("symbol_graph");
			try {
				for (const sym of keySymbols.slice(0, 2)) {
					const refs = await this.symbolGraph.findReferences(sym);
					for (const ref of refs) {
						const symId = `sym_${ref.file}_${ref.line}`;
						if (!candidatesMap.has(symId)) {
							candidatesMap.set(symId, {
								id: symId,
								statement: `Symbol reference '${sym}' in ${ref.file}`,
								locations: [ref.file],
								matchMethod: "symbol_reference",
								score: 0.75,
								compact: {
									id: symId,
									file: ref.file,
									line: ref.line,
									symbol: sym,
								},
							});
						}
					}
				}
				succeededMethods.push("symbol_graph");
			} catch (err) {
				failures.push({
					method: "symbol_graph",
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// 6. AST / structural fingerprint where supported (PH-137)
		if (this.astAnalyzer) {
			attemptedMethods.push("structural_ast");
			try {
				const matches = await this.astAnalyzer.findStructuralMatches(proposed.statement);
				for (const m of matches) {
					const astId = `ast_${m.file}`;
					if (!candidatesMap.has(astId)) {
						candidatesMap.set(astId, {
							id: astId,
							statement: `Structural AST match (${m.matchType}) in ${m.file}`,
							locations: [m.file],
							matchMethod: "structural_fingerprint",
							score: 0.85,
							compact: {
								id: astId,
								file: m.file,
								matchType: m.matchType,
							},
						});
					}
				}
				succeededMethods.push("structural_ast");
			} catch (err) {
				failures.push({
					method: "structural_ast",
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// 7. Semantic index search if available
		if (this.semanticIndex) {
			attemptedMethods.push("semantic_index");
			try {
				const hits = await this.semanticIndex.searchSemantic(proposed.statement);
				for (const hit of hits) {
					const semId = `sem_${hit.id}`;
					if (!candidatesMap.has(semId)) {
						candidatesMap.set(semId, {
							id: semId,
							statement: hit.text,
							locations: [],
							matchMethod: "repo_search",
							score: hit.score,
							compact: {
								id: semId,
								text: hit.text,
								score: hit.score,
							},
						});
					}
				}
				succeededMethods.push("semantic_index");
			} catch (err) {
				failures.push({
					method: "semantic_index",
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// S1A-203: Bounded candidate limit of 12
		const sorted = Array.from(candidatesMap.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, CANDIDATE_LIMIT);

		// PH-138: Compute coverage class
		let coverageClass: CandidateDiscoveryCoverage["coverageClass"] = "full";
		if (succeededMethods.length === 0) {
			coverageClass = "failed";
		} else if (failures.length > 0) {
			coverageClass = "degraded";
		}

		const coverage: CandidateDiscoveryCoverage = {
			attemptedMethods,
			succeededMethods,
			failures,
			candidateCount: sorted.length,
			coverageClass,
		};

		const result = Object.assign(sorted, { coverage });
		return result;
	}
}
