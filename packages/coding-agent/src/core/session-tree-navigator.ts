/**
 * Session-tree navigation (in-file branch switching + fork-selector reads).
 *
 * Extracted verbatim from agent-session.ts (god-file decomposition). `navigateTree` moves the leaf
 * to another node in the SAME session file (unlike fork(), which creates a new file), optionally
 * summarizing the abandoned branch via the model or an extension override. It owns no state: the
 * branch-summary abort controller stays on the session (also read by `isCompacting`) and is set/cleared
 * here through a dep so the session's abort/compacting surface is untouched.
 */

import type { Agent } from "@caupulican/pi-agent-core";
import {
	type BranchSummaryEntry,
	collectEntriesForBranchSummary,
	generateBranchSummary,
	type SessionManager,
} from "@caupulican/pi-agent-core/node";
import type { Model } from "@caupulican/pi-ai";
import type { ExtensionRunner, SessionBeforeTreeResult, TreePreparation } from "./extensions/index.ts";
import type { SettingsManager } from "./settings-manager.ts";

export interface SessionTreeNavigatorDeps {
	/** Session log — leaf/branch reads and writes go through this. */
	getSessionManager(): SessionManager;
	/** Current model — required to run the default branch summarizer. */
	getModel(): Model<any> | undefined;
	/** Extension runner — `session_before_tree`/`session_tree` hooks fire here. */
	getExtensionRunner(): ExtensionRunner;
	/** Resolve request auth for the summarizer call (session-owned, also used by compaction). */
	getRequiredRequestAuth(model: Model<any>): Promise<{ apiKey: string; headers?: Record<string, string> }>;
	/** Settings — branch-summary reserve tokens. */
	getSettingsManager(): SettingsManager;
	/** The underlying agent — the rebuilt message view is assigned to `agent.state.messages`. */
	getAgent(): Agent;
	/** Store/clear the in-flight branch-summary abort controller on the session (read by isCompacting). */
	setBranchSummaryAbort(controller: AbortController | undefined): void;
}

export class SessionTreeNavigator {
	private readonly deps: SessionTreeNavigatorDeps;

	constructor(deps: SessionTreeNavigatorDeps) {
		this.deps = deps;
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
		this.deps.setBranchSummaryAbort(branchSummaryAbort);

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: branchSummaryAbort.signal,
				})) as SessionBeforeTreeResult | undefined;

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
				const branchSummarySettings = this.deps.getSettingsManager().getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					signal: branchSummaryAbort.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
				});
				if (result.aborted) {
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

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = sessionManager.branchWithSummary(newLeafId, summaryText, summaryDetails, fromExtension);
				summaryEntry = sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = sessionManager.buildSessionContext();
			this.deps.getAgent().state.messages = sessionContext.messages;

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
		} finally {
			this.deps.setBranchSummaryAbort(undefined);
		}
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
