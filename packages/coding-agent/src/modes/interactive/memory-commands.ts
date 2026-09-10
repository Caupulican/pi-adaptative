/**
 * `/memory` — the operator's authority over the managed memory files.
 *
 * The file store refuses to mutate a file that no longer matches its managed revision (drift). The
 * model cannot resolve that and must not; the operator can: adopt the on-disk content, or restore
 * the managed content. `drift` shows where each file stands.
 */
import type { ManagedMemoryDriftEntry, ManagedMemoryTarget } from "../../core/memory/providers/file-store.ts";

export interface MemoryCommandHost {
	memoryDriftReport(): Promise<ManagedMemoryDriftEntry[]>;
	memoryAcceptDrift(target: ManagedMemoryTarget): Promise<{ ok: boolean; message: string }>;
	memoryRestoreManaged(target: ManagedMemoryTarget): Promise<{ ok: boolean; message: string }>;
	showStatus(message: string): void;
	showError(message: string): void;
	showText(text: string): void;
}

export const MEMORY_COMMAND_USAGE =
	"/memory drift · /memory accept <memory|project|user> · /memory restore <memory|project|user>";

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

export async function handleMemoryCommand(host: MemoryCommandHost, text: string): Promise<void> {
	const args = text.replace(/^\/memory\b/, "").trim();
	const [action = "drift", target] = args.split(/\s+/).filter(Boolean);
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
	host.showError(MEMORY_COMMAND_USAGE);
}
