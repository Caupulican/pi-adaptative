import { parentInputOf, parentWakeOf } from "../../kernel/session/parent-input-ledger.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import type { ContinuousChatIngestor } from "./continuous-chat-ingest.ts";
import type {
	ContinuousChatLegacyEntrySource,
	ContinuousChatLegacyImportState,
	ContinuousChatLegacySource,
} from "./continuous-chat-legacy-import.ts";
import { readContinuousChatLegacySessionFile } from "./continuous-chat-migration.ts";
import {
	isLegacyParentProjectionCandidate,
	legacyParentProjectionFamily,
	type ParentProjectionDecision,
	type ParentProjectionReconciliationPort,
} from "./continuous-chat-parent-projection-contract.ts";

export interface ParentInputReconciliationOptions {
	readonly projection: ParentProjectionReconciliationPort;
	readonly legacy: ContinuousChatLegacySource;
	readonly ingestor: Pick<ContinuousChatIngestor, "importParentInputConsumptions" | "settled">;
	readonly currentSessionId: string;
	openCurrent(): ContinuousChatLegacyEntrySource;
	readonly active: readonly { sessionId: string; sessionFile?: string }[];
	readonly settled: readonly string[];
	readonly legacyImport: ContinuousChatLegacyImportState | undefined;
	warn(message: string): void;
}

/** Stage quarantines before any old rendered view or summary may be published. */
export async function stageParentInputReconciliation(
	projection: ParentProjectionReconciliationPort,
	signal?: AbortSignal,
): Promise<void> {
	await projection.listParentProjectionSessionIds(undefined, 1, signal);
}

/** One pinned source at a time; all durable scan, mask and replay progress belongs to the Store. */
export async function reconcileParentInputHistory(
	options: ParentInputReconciliationOptions,
	signal?: AbortSignal,
): Promise<void> {
	const listing = await options.legacy.sessions(signal);
	const sources = new Map(listing.sessions.map((source) => [source.sessionId, source]));
	const excluded = new Set(options.legacyImport?.skipped.map((entry) => entry.sessionId) ?? []);
	const active = new Map(options.active.map((entry) => [entry.sessionId, entry]));
	const settled = new Set(options.settled);
	const allowed = (id: string): boolean =>
		id === options.currentSessionId ||
		active.has(id) ||
		(options.legacyImport !== undefined && settled.has(id) && !excluded.has(id));

	const reconcileSource = async (sessionId: string): Promise<void> => {
		signal?.throwIfAborted();
		const forgotten = await options.legacy.isForgotten(sessionId, signal);
		let opened: ContinuousChatLegacyEntrySource | undefined;
		let attempted = false;
		let failure: unknown;
		const open = async (): Promise<ContinuousChatLegacyEntrySource | undefined> => {
			if (attempted || forgotten) return opened;
			attempted = true;
			try {
				if (sessionId === options.currentSessionId) opened = options.openCurrent();
				else {
					let source = sources.get(sessionId);
					const file = active.get(sessionId)?.sessionFile;
					if (!source && file) {
						const read = await readContinuousChatLegacySessionFile(file, signal);
						if (read.kind === "session" && read.session.sessionId === sessionId) source = read.session;
					}
					opened = await source?.openEntries(signal);
				}
				if (!opened) throw new Error("The canonical source session is unavailable.");
			} catch (error) {
				signal?.throwIfAborted();
				failure = error;
			}
			return opened;
		};
		try {
			let after: string | undefined;
			do {
				const page = await options.projection.listParentProjectionGroups(sessionId, after, 16, signal);
				const decisions: ParentProjectionDecision[] = [];
				for (const group of page.groups) {
					signal?.throwIfAborted();
					if (group.state === "superseded" || group.state === "unchanged") continue;
					if (!legacyParentProjectionFamily(group.firstRecord)) continue;
					const candidate = isLegacyParentProjectionCandidate(group.firstRecord) || group.state === "quarantined";
					let state: ParentProjectionDecision["state"] = "unchanged";
					if (!candidate) state = "unchanged";
					else if (forgotten) state = "superseded";
					else {
						const source = await open();
						if (source) {
							try {
								const entry = (await source.readEntries([group.entryId], signal)).get(group.entryId);
								if (!entry || entry.id !== group.entryId) throw new Error("Source entry is unavailable.");
								state = parentInputOf(entry) || parentWakeOf(entry) ? "superseded" : "unchanged";
							} catch (error) {
								signal?.throwIfAborted();
								failure = error;
								state = candidate ? "quarantined" : "unchanged";
							}
						} else state = candidate ? "quarantined" : "unchanged";
					}
					if (state !== group.state) decisions.push({ sessionId, entryId: group.entryId, state });
				}
				await options.projection.applyParentProjectionDecisions(decisions, signal);
				after = page.nextEntryId;
			} while (after !== undefined);
			if (forgotten) await options.projection.markParentProjectionSourceReplayed(sessionId, signal);
			else if (allowed(sessionId) && !(await options.projection.parentProjectionSourceReplayed(sessionId))) {
				const source = await open();
				if (source && failure === undefined) {
					try {
						await options.ingestor.importParentInputConsumptions(sessionId, source, signal);
						await options.ingestor.settled();
						await options.projection.markParentProjectionSourceReplayed(sessionId, signal);
					} catch (error) {
						signal?.throwIfAborted();
						failure = error;
					}
				}
				if (failure !== undefined) {
					const reason =
						boundedRedactedDiagnosticText(failure instanceof Error ? failure.message : String(failure)) ??
						"Source proof is unavailable.";
					await options.projection.noteParentProjectionSourceUnavailable(sessionId, reason.slice(0, 512), signal);
				}
			}
		} finally {
			await opened?.close();
		}
	};
	let afterSession: string | undefined;
	do {
		const page = await options.projection.listParentProjectionSessionIds(afterSession, 64, signal);
		for (const id of page.sessionIds) await reconcileSource(id);
		afterSession = page.nextSessionId;
	} while (afterSession !== undefined);
	for (const id of new Set([options.currentSessionId, ...active.keys(), ...settled, ...sources.keys()])) {
		if (allowed(id) && !(await options.projection.parentProjectionSourceReplayed(id))) await reconcileSource(id);
	}
	const remaining = await options.projection.finishParentProjectionPass(signal);
	if (remaining.unresolvedGroups || remaining.unresolvedSources)
		options.warn(
			`Background-input history reconciliation retains ${remaining.unresolvedGroups} quarantined source groups and ${remaining.unresolvedSources} unavailable source sessions; they will be retried when this chat reopens.`,
		);
}

/** Captures only the currently persisted canonical entries; no parallel history or body store. */
export function currentParentInputSource(options: {
	getSource(): Omit<ContinuousChatLegacyEntrySource, "entries" | "close">;
	entryIds(): readonly string[];
	isEntryPersisted(id: string): boolean;
	readEntry(id: string): SessionEntry | undefined;
}): ContinuousChatLegacyEntrySource {
	const source = options.getSource();
	const ids = options.entryIds().filter((id) => options.isEntryPersisted(id));
	return {
		...source,
		entries: (async function* () {
			for (const id of ids) {
				const entry = options.readEntry(id);
				if (!entry || entry.id !== id) throw new Error("Current parent input source changed.");
				yield entry;
			}
		})(),
		close: async () => {},
	};
}
