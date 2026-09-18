/**
 * Session-tree navigation (in-file branch switching + fork-selector reads).
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). `navigateTree` moves the leaf
 * to another node in the SAME session file (unlike fork(), which creates a new file), optionally
 * summarizing the abandoned branch via the model or an extension override. It owns the active
 * navigation controller; session cancellation and busy-state queries delegate to this owner.
 */

import { randomUUID } from "node:crypto";
import type { Agent } from "@caupulican/pi-agent-core/agent";
import { collectEntriesForBranchSummary, generateBranchSummary } from "@caupulican/pi-agent-core/compaction";
import type { BranchSummaryEntry, SessionManager } from "@caupulican/pi-agent-core/session";
import { combineUsage } from "@caupulican/pi-agent-core/usage";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import type { ExtensionRunner, TreePreparation } from "./extensions/index.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { reportSpawnedUsage, type SpawnedUsageReporter } from "./spawned-usage.ts";

export interface SessionTreeNavigatorDeps extends SpawnedUsageReporter {
	/** Session log — leaf/branch reads and writes go through this. */
	getSessionManager(): SessionManager;
	/** Current model — required to run the default branch summarizer. */
	getModel(): Model<Api> | undefined;
	/** Extension runner — `session_before_tree`/`session_tree` hooks fire here. */
	getExtensionRunner(): ExtensionRunner;
	/** Resolve request auth for the summarizer call (session-owned, also used by compaction). */
	getRequiredRequestAuth(model: Model<Api>): Promise<RequestAuth>;
	/** Settings — branch-summary reserve tokens. */
	getSettingsManager(): SettingsManager;
	/** The underlying agent — the rebuilt message view is assigned to `agent.state.messages`. */
	getAgent(): Agent;
	/** Invalidate branch-dependent host state before notifying asynchronous observers. */
	onBranchChanged(): void;
}

export class SessionTreeNavigator {
	private readonly deps: SessionTreeNavigatorDeps;
	private activeAbortController: AbortController | undefined;

	constructor(deps: SessionTreeNavigatorDeps) {
		this.deps = deps;
	}

	isRunning(): boolean {
		return this.activeAbortController !== undefined;
	}

	abort(): void {
		this.activeAbortController?.abort();
	}

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const sessionManager = this.deps.getSessionManager();
		const extensionRunner = this.deps.getExtensionRunner();
		const oldLeafId = sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			// Selecting the current leaf supersedes a pending move away from it.
			this.abort();
			return { cancelled: false };
		}

		// Model required for summarization
		if (options.summarize && !this.deps.getModel()) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		const branchSummaryAbort = new AbortController();
		const usageIdentity = {
			kind: "branch-summary",
			label: "discarded branch summary",
			sessionId: sessionManager.getSessionId(),
			identity: randomUUID(),
		};
		let summaryUsage: Usage | undefined;
		let summaryUsageCommitted = false;
		let navigationFailure: { error: unknown } | undefined;
		let usageRecordingFailure: unknown | undefined;
		let result:
			| { editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }
			| undefined;
		const previous = this.activeAbortController;
		this.activeAbortController = branchSummaryAbort;

		const executeNavigation = async (): Promise<{
			editorText?: string;
			cancelled: boolean;
			aborted?: boolean;
			summaryEntry?: BranchSummaryEntry;
		}> => {
			// Install the owner before aborting: an abort listener may start a newer
			// navigation synchronously, and that request must supersede this one too.
			previous?.abort();
			if (branchSummaryAbort.signal.aborted) return { cancelled: true, aborted: true };
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (extensionRunner.hasHandlers("session_before_tree")) {
				const { result, reportedUsage } = await extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: branchSummaryAbort.signal,
				});
				summaryUsage = reportedUsage;

				// Extensions may finish successfully after the caller cancels navigation.
				if (branchSummaryAbort.signal.aborted) {
					return { cancelled: true, aborted: true };
				}

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.deps.getModel()!;
				const { apiKey, headers } = await this.deps.getRequiredRequestAuth(model);
				if (branchSummaryAbort.signal.aborted) {
					return { cancelled: true, aborted: true };
				}
				const branchSummarySettings = this.deps.getSettingsManager().getBranchSummarySettings();
				const extensionUsage = summaryUsage;
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					signal: branchSummaryAbort.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this.deps.getAgent().streamFn,
					onUsage: (usage) => {
						// The generator publishes cumulative snapshots before a later attempt can
						// throw. Replace its previous contribution; retain extension charges once.
						summaryUsage = combineUsage(extensionUsage, usage);
					},
				});
				if (result.aborted || branchSummaryAbort.signal.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Extension result accessors may synchronously start a newer navigation after
			// an await check. Recheck ownership after reading those values, before writes.
			if (branchSummaryAbort.signal.aborted) return { cancelled: true, aborted: true };

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			let labelTargetId = targetId;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
					branchSummaryAbort.signal,
				);
				summaryUsageCommitted = true;
				summaryEntry = sessionManager.getEntry(summaryId) as BranchSummaryEntry;
				labelTargetId = summaryId;
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				sessionManager.branch(newLeafId);
			}

			// Update agent state
			const sessionContext = sessionManager.buildSessionContext();
			const agent = this.deps.getAgent();
			agent.state.messages = sessionContext.messages;
			// Branch/leaf just changed: the session-scoped sanitizer mark indexes into the array we
			// just replaced and must not survive into this different lineage (see
			// Agent.resetSanitizerPrefixHorizon's doc comment).
			agent.resetSanitizerPrefixHorizon();
			this.deps.onBranchChanged();

			// The branch is already selected. Publish its model context before optional
			// label persistence can fail; labels do not add model messages.
			if (label) sessionManager.appendLabelChange(labelTargetId, label);

			// Emit session_tree event
			await extensionRunner.emit({
				type: "session_tree",
				newLeafId: sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		};

		try {
			result = await executeNavigation();
		} catch (error) {
			// Storage checks this same signal after serialization, before any physical write.
			// Only its exact abort reason is cancellation; unrelated write errors still escape.
			if (branchSummaryAbort.signal.aborted && error === branchSummaryAbort.signal.reason) {
				result = { cancelled: true, aborted: true };
			} else {
				navigationFailure = { error };
			}
		} finally {
			try {
				// A successful summary entry already owns its charge. Discarded results still
				// carry received usage, recorded through the session's existing idempotent ledger.
				if (summaryUsage && !summaryUsageCommitted) reportSpawnedUsage(this.deps, summaryUsage, usageIdentity);
			} catch (error) {
				usageRecordingFailure = error;
			}
			if (this.activeAbortController === branchSummaryAbort) this.activeAbortController = undefined;
		}

		if (navigationFailure && usageRecordingFailure) {
			throw new AggregateError(
				[navigationFailure.error, usageRecordingFailure],
				"Branch navigation and usage recording failed.",
			);
		}
		if (navigationFailure) throw navigationFailure.error;
		if (usageRecordingFailure) throw usageRecordingFailure;
		return result!;
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.deps.getSessionManager().getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}
}
