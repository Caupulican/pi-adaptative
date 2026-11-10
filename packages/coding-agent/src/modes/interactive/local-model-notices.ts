/**
 * The small lines a local-model command prints about what it did: the store it read, the probe it remembers, the
 * disclosure that precedes a delete, and a registration the catalogue refused. Keeping them here leaves the command
 * bodies to the work itself.
 */

import { interfaceText } from "../../core/language/interface-text.ts";
import type { StoredFitnessReport } from "../../core/models/fitness-store.ts";

/** The store the listing names: its path, its kind and how many models it holds. */
export function formatOllamaStore(store: { kind: string; path: string; modelCount: number } | undefined): string {
	const words = interfaceText().localModels.models;
	if (!store) return words.unknownStore;
	return words.store(store.path, store.kind, store.modelCount);
}

/** The arguments of the probe line: the day it ran, what settled, and how fast it went. */
export function probeReport(report: StoredFitnessReport) {
	return {
		at: report.at.slice(0, 10),
		digestSucceeded: String(report.report.digest?.succeeded ?? "?"),
		digestTotal: String(report.report.digest?.total ?? "?"),
		toolSucceeded: report.report.toolCall.succeeded,
		toolTotal: report.report.toolCall.total,
		tokensPerSecond: report.report.tokensPerSecond,
	};
}

/** The disclosure that precedes a delete: what goes, then the command that confirms it. */
export function removalDisclosure(lines: readonly string[], confirmCommand: string): string {
	const words = interfaceText().localModels.models;
	return [...lines, words.removalRun(confirmCommand)].join("\n");
}

/** Report a registration the catalogue refused, with the snippet the owner can paste instead. */
export function reportRefusedRegistration(
	host: { showStatus(message: string): void },
	registration: { reason?: string; manualSnippet?: string; modelsJsonPath: string },
	refused: (reason: string) => string,
): void {
	const words = interfaceText().localModels.models;
	host.showStatus(refused(String(registration.reason)));
	if (registration.manualSnippet) {
		host.showStatus(words.addToModelsJson(registration.modelsJsonPath, registration.manualSnippet));
	}
}
