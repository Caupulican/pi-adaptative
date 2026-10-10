/**
 * `/memory` — the operator's authority over the managed memory files.
 *
 * The file store refuses to mutate a file that no longer matches its managed revision (drift). The
 * model cannot resolve that and must not; the operator can: adopt the on-disk content, or restore
 * the managed content. `drift` shows where each file stands.
 */
import {
	formatTranscriptMemoryLines,
	sanitizeTranscriptHistoryForDiagnostics,
	type TranscriptHistoryStatus,
} from "../../core/context/memory-diagnostics.ts";
import type { ManagedMemoryDriftEntry, ManagedMemoryTarget } from "../../core/memory/providers/file-store.ts";

import type { MemorySystem } from "../../core/settings/settings-schema.ts";

export interface MemoryCommandHost {
	getTranscriptHistoryStatus(): TranscriptHistoryStatus;
	memoryDriftReport(): Promise<ManagedMemoryDriftEntry[]>;
	memoryAcceptDrift(target: ManagedMemoryTarget): Promise<{ ok: boolean; message: string }>;
	memoryRestoreManaged(target: ManagedMemoryTarget): Promise<{ ok: boolean; message: string }>;
	forgetHistorySession(sessionId: string): Promise<{ ok: boolean; message: string }>;
	getMemorySystem(): MemorySystem;
	setMemorySystem(system: MemorySystem): Promise<{ ok: boolean; message: string }>;
	showStatus(message: string): void;
	showError(message: string): void;
	showText(text: string): void;
}

export const MEMORY_COMMAND_USAGE =
	"/memory drift · /memory history · /memory history forget <session> <session> · /memory accept <memory|project|user> · /memory restore <memory|project|user> · /memory system [okf|icm]";

const TARGETS = new Set<ManagedMemoryTarget>(["memory", "project", "user"]);

function describe(entry: ManagedMemoryDriftEntry): string {
	const state =
		entry.stateStatus !== "valid"
			? `managed state ${entry.stateStatus}`
			: entry.drift
				? entry.emptyOnDisk
					? "EMPTY on disk — drifted"
					: "drifted (edited outside the managed protocol)"
				: "in sync";
	const managed =
		entry.managedChars !== undefined ? `managed ${entry.managedChars} chars stored` : "managed content not stored";
	return `- ${entry.target}: ${entry.label} — ${state}; on disk ${entry.currentChars} chars; ${managed}\n  ${entry.path}`;
}

/**
 * Past-session history recall as the operator sees it: the safe diagnostic lines plus the real failure
 * text the model-facing projection withholds (it may name a path). No history content is printed.
 */
function describeHistory(status: TranscriptHistoryStatus): string {
	const lines = formatTranscriptMemoryLines(sanitizeTranscriptHistoryForDiagnostics(status));
	const indexingError = status.coverage?.lastError;
	if (indexingError) {
		const failing = (status.coverage?.activeFailures ?? 0) > 0;
		lines.push(
			`  ${failing ? "indexing error detail" : "historical indexing error detail, no source failing now"} (${indexingError.at}): ${indexingError.message}`,
		);
	}
	// Only a worker that stopped serving (it carries `stoppedAt`) is a transport failure; a child session, a
	// memory switch or a failed start is not, and is labelled as plain unavailability.
	if (status.unavailableReason) {
		const label = status.transport?.stoppedAt !== undefined ? "transport stopped" : "history unavailable";
		lines.push(`  ${label}: ${status.unavailableReason}`);
	}
	const retrievalError = status.latestRetrieval?.error;
	if (retrievalError) lines.push(`  retrieval error detail: ${retrievalError}`);
	const hierarchy = status.hierarchy;
	if (hierarchy?.disabledReason) lines.push(`  hierarchy not running: ${hierarchy.disabledReason}`);
	if (hierarchy?.readAccessReason) lines.push(`  summary read access detail: ${hierarchy.readAccessReason}`);
	for (const failure of hierarchy?.failures.slice(-5) ?? []) {
		lines.push(`  hierarchy failure (level ${failure.level}, ${failure.reason}): ${failure.message}`);
	}
	for (const issue of hierarchy?.recoveryIssues ?? []) lines.push(`  hierarchy recovery: ${issue}`);
	// One slot the next cause overwrites, not cleared when its condition ends: its time says how old it is.
	const internalCause = hierarchy?.lastInternalError;
	if (internalCause) {
		lines.push(
			`  coordinator's latest internal cause (newest only, recorded ${internalCause.at}, may be over): ${internalCause.cause}`,
		);
	}
	const admission = hierarchy?.admission;
	if (admission?.blocked) lines.push(`  model summaries held: ${admission.blocked.reason}`);
	if (admission?.heldReason) {
		lines.push(
			`  first held job cause${admission.heldKind !== undefined ? ` (hold: ${admission.heldKind})` : ""}: ${admission.heldReason}`,
		);
	}
	return lines.join("\n");
}

export async function handleMemoryCommand(host: MemoryCommandHost, text: string): Promise<void> {
	const args = text.replace(/^\/memory\b/, "").trim();
	const [action = "drift", target, ...rest] = args.split(/\s+/).filter(Boolean);
	if (action === "drift" || action === "") {
		const entries = await host.memoryDriftReport();
		if (entries.length === 0) {
			host.showStatus("Managed memory is not available in this session.");
			return;
		}
		const drifted = entries.filter((entry) => entry.drift).length;
		host.showText(
			[
				drifted
					? `${drifted} managed memory file${drifted > 1 ? "s" : ""} drifted — /memory accept <target> adopts the file, /memory restore <target> brings the managed content back`
					: "Managed memory files are in sync with their managed revisions.",
				...entries.map(describe),
			].join("\n"),
		);
		return;
	}
	if (action === "history") {
		if (target === undefined) {
			host.showText(describeHistory(host.getTranscriptHistoryStatus()));
			return;
		}
		// Forgetting revokes a session's derived summaries for good; the repeated session id is the confirmation.
		const [sessionId, repeated] = rest;
		if (target !== "forget" || sessionId === undefined || repeated !== sessionId || rest.length !== 2) {
			host.showError(
				target === "forget"
					? "Repeat the session id to confirm: /memory history forget <session> <session>"
					: MEMORY_COMMAND_USAGE,
			);
			return;
		}
		const result = await host.forgetHistorySession(sessionId);
		if (result.ok) host.showStatus(result.message);
		else host.showError(result.message);
		return;
	}
	if (action === "accept" || action === "restore") {
		if (!target || !TARGETS.has(target as ManagedMemoryTarget)) {
			host.showError(MEMORY_COMMAND_USAGE);
			return;
		}
		const result =
			action === "accept"
				? await host.memoryAcceptDrift(target as ManagedMemoryTarget)
				: await host.memoryRestoreManaged(target as ManagedMemoryTarget);
		if (result.ok) host.showStatus(result.message);
		else host.showError(result.message);
		return;
	}
	if (action === "system") {
		if (target === undefined) {
			host.showStatus(`Memory system: ${host.getMemorySystem()}`);
			return;
		}
		if (target !== "okf" && target !== "icm") {
			host.showError(MEMORY_COMMAND_USAGE);
			return;
		}
		const result = await host.setMemorySystem(target as MemorySystem);
		if (result.ok) host.showStatus(result.message);
		else host.showError(result.message);
		return;
	}
	host.showError(MEMORY_COMMAND_USAGE);
}
