/**
 * Deterministic Candidate Discovery for Semantic Deduplication.
 * Implements S1A-203..S1A-207, S1A-214, S1A-215.
 * Bounded candidate limit: 12.
 */

import type { ResponsibilityRegistry } from "./responsibility-registry.ts";
import type { ResponsibilityCandidate, ResponsibilityStatement } from "./types.ts";

export const CANDIDATE_LIMIT = 12;

export interface CandidateDiscoveryDeps {
	readonly registry: ResponsibilityRegistry;
	readonly codeSearcher?: {
		searchKeywords(keywords: readonly string[]): Promise<readonly { file: string; line: number; snippet: string }[]>;
	};
	readonly cloneChecker?: {
		findClones(location: string, content?: string): Promise<readonly { targetFile: string; similarity: number }[]>;
	};
}

export class CandidateDiscoveryService {
	private readonly registry: ResponsibilityRegistry;
	private readonly codeSearcher?: CandidateDiscoveryDeps["codeSearcher"];
	private readonly cloneChecker?: CandidateDiscoveryDeps["cloneChecker"];

	constructor(deps: CandidateDiscoveryDeps) {
		this.registry = deps.registry;
		this.codeSearcher = deps.codeSearcher;
		this.cloneChecker = deps.cloneChecker;
	}

	/**
	 * Discovers candidates for a proposed responsibility statement across the bounded methods.
	 * Returns at most 12 candidates sorted by relevance score.
	 */
	async findCandidates(proposed: ResponsibilityStatement): Promise<readonly ResponsibilityCandidate[]> {
		const candidatesMap = new Map<string, ResponsibilityCandidate>();

		// 1. Check ResponsibilityRegistry (S1A-207)
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

		// 2. Extract symbol and identifier signals (S1A-205)
		const words = proposed.statement
			.toLowerCase()
			.split(/\W+/)
			.filter((w) => w.length > 2);
		const keySymbols = words.filter(
			(w) => !["the", "and", "for", "only", "when", "with", "from", "that", "this"].includes(w),
		);

		// 3. Search codebase if searcher available
		if (this.codeSearcher && keySymbols.length > 0) {
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
			} catch {
				// Non-fatal
			}
		}

		// 4. Check textual clone signals if available (S1A-204)
		if (this.cloneChecker) {
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
			} catch {
				// Non-fatal
			}
		}

		// S1A-203: Bounded candidate limit of 12
		const sorted = Array.from(candidatesMap.values())
			.sort((a, b) => b.score - a.score)
			.slice(0, CANDIDATE_LIMIT);

		return sorted;
	}
}
