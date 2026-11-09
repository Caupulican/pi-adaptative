/**
 * Ports and settings of the transcript memory coordinator: the seams its owner fills (summarizer, admission judge,
 * store, lineage reader, clock, timers, background availability, settings) and the start, forget and terminal shapes
 * it reports back. Types only; the behavior lives in transcript-memory.ts.
 */

import type { TranscriptLineageReader } from "./transcript-memory-contracts.ts";
import type { TranscriptSummaryAdmissionPort } from "./transcript-summary-admission.ts";
import type { TranscriptSummarySchedulerOptions } from "./transcript-summary-scheduler.ts";
import type {
	TranscriptSummaryRecoveryIssue,
	TranscriptSummaryStore,
	TranscriptSummaryTerminalCause,
	TranscriptSummaryTerminalRecord,
} from "./transcript-summary-store.ts";

/** The restricted summary task: a tool-free completion. The adapter owns model choice, auth and readiness. */
export interface TranscriptSummarizerPort {
	/** Where the prompt goes. `external` needs `allowExternalSummaryEgress`; the coordinator enforces it before any call. */
	egress: "local" | "external";
	/** The model every reply comes from (`provider/id`): part of the key a kept reply is reused under. */
	readonly model: string;
	summarize(
		input: { system: string; prompt: string; maxOutputBytes: number },
		signal: AbortSignal,
	): Promise<{ text: string; model: string }>;
}

export interface TranscriptMemorySettings {
	hierarchy: boolean;
	allowExternalSummaryEgress: boolean;
	/**
	 * Sending the captured history to the remote System One evaluator that admits model summaries. Independent
	 * of the summarizer's egress: a local summary model does not make the evaluator local.
	 */
	allowExternalAdmissionEgress: boolean;
	maxConcurrentSummaries: number;
	frontierMaxBytes: number;
	/**
	 * DERIVED summary retention only: sources older than this many days are not summarized, and summary nodes
	 * (and every summary built on them) depending on older sources are revoked. It never erases or hides
	 * canonical transcripts and never limits exact history search or source reads. A source without a usable
	 * event time ages from a persisted anchor (the canonical session timestamp, else its first capture).
	 */
	retentionDays?: number;
}

export type TranscriptMemoryTerminalCause = TranscriptSummaryTerminalCause;
export type TranscriptMemoryTerminalEvent = TranscriptSummaryTerminalRecord;

export interface TranscriptMemoryPorts {
	/** The session whose usage record paid answers are receipted to; a receipt owed to another session is held, not written here. */
	ownerSessionId(): string;
	reader: TranscriptLineageReader;
	store: TranscriptSummaryStore;
	scheduler?: TranscriptSummarySchedulerOptions;
	summarizer: TranscriptSummarizerPort | undefined;
	/**
	 * The evidence-quality judge a model summary must pass before it is accepted. Exact copies never reach it.
	 * Without one (or while it cannot judge) model summaries are held, never accepted unjudged.
	 */
	admission: TranscriptSummaryAdmissionPort | undefined;
	settings(): TranscriptMemorySettings;
	/** False while foreground work needs the provider; background work waits for `onBackgroundAvailable`. */
	canRunBackground(): boolean;
	onBackgroundAvailable(listener: () => void): () => void;
	/** The memory generation / policy fence: false once this coordinator's generation was replaced. */
	isCurrent(): boolean;
	now(): number;
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(handle: unknown): void;
	onTerminal(event: TranscriptMemoryTerminalEvent): void;
	onFrontierChanged(lineageKey: string, revision: number): void;
}

/** What forgetting one session did: `forgotten` once it is durable and applied, else the real cause. */
export type TranscriptForgetOutcome =
	/** `cleanupPending`: the permanent marker is durable (the session is denied everywhere) but removing its derived data did not finish. */
	{ status: "forgotten"; cleanupPending?: string } | { status: "refused"; reason: string };

export type TranscriptMemoryStartResult =
	| { enabled: true; recoveryIssues: readonly TranscriptSummaryRecoveryIssue[] }
	| { enabled: false; reason: string };
