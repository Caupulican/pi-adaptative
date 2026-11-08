/**
 * `/soul` -- the owner's view of the agent's soul file.
 *
 * `/soul` edits `<agentDir>/soul.md` in a panel, `/soul show` prints it, `/soul review` runs the System One soul review
 * on the current text, `/soul history` lists the recorded writes and `/soul restore <n>` writes one back. An owner write
 * passes the deterministic screen and skips the System One judgment: the owner is the authority on the soul.
 */
import type { SoulController } from "../../core/soul/soul-controller.ts";
import { formatSoulReview } from "../../core/soul/soul-review.ts";
import { harnessLog } from "../../kernel/harness-log.ts";

export interface SoulCommandHost {
	soul: SoulController;
	promptForEdit(title: string, prefill: string): Promise<string | undefined>;
	showStatus(message: string): void;
	showError(message: string): void;
}

const USAGE = "Usage: /soul [show|review|history|restore <n>]";

function formatHistory(soul: SoulController): string {
	const entries = soul.history();
	if (entries.length === 0) return "No soul history yet.";
	harnessLog.debug("ui", "soul history entries shown", { digests: entries.map((entry) => entry.sha256.slice(0, 8)) });
	return [
		"Soul history, newest first (restore with /soul restore <n>):",
		...entries.map(
			(entry, index) =>
				`${index + 1}. ${entry.at}  ${entry.author}, review ${entry.reviewer}${entry.event ? `, ${entry.event}` : ""}${entry.withheld ? ", withheld" : ""}  ${entry.bytes} bytes`,
		),
	].join("\n");
}

export async function handleSoulCommand(host: SoulCommandHost, text: string): Promise<void> {
	const { soul } = host;
	const [subcommand = "", ...rest] = text.slice("/soul".length).trim().split(/\s+/).filter(Boolean);
	switch (subcommand) {
		case "": {
			const current = soul.read();
			const edited = await host.promptForEdit(
				"Edit soul (applies from the next session)",
				current ?? soul.template(),
			);
			if (edited === undefined) {
				host.showStatus("Soul edit cancelled.");
				return;
			}
			if (edited === current) {
				host.showStatus("Soul unchanged.");
				return;
			}
			const saved = soul.saveFromOwner(edited, { text: current });
			if (!saved.ok) {
				host.showError(`Soul not saved: ${saved.reason}.`);
				return;
			}
			host.showStatus(`Soul saved (${saved.bytes} bytes). It applies from the next session.`);
			return;
		}
		case "show": {
			const current = soul.read();
			host.showStatus(current ?? `No soul file at ${soul.path}.`);
			return;
		}
		case "review": {
			const report = await soul.review();
			if (report.kind === "missing") host.showStatus(`No soul file at ${report.path}: nothing to review.`);
			else if (report.kind === "unavailable")
				host.showStatus(
					"System One is not available: the soul was not reviewed. Writes still pass the deterministic screen.",
				);
			else if (report.outcome.kind === "failed") host.showError(formatSoulReview(report.outcome));
			else host.showStatus(formatSoulReview(report.outcome));
			return;
		}
		case "history":
			host.showStatus(formatHistory(soul));
			return;
		case "restore": {
			const n = Number(rest[0]);
			if (rest.length !== 1 || !Number.isInteger(n) || n < 1) {
				host.showError("Usage: /soul restore <n> (the number /soul history shows)");
				return;
			}
			const restored = soul.restore(n);
			if (!restored.ok) host.showError(`Soul not restored: ${restored.reason}.`);
			else
				host.showStatus(
					`Soul restored from history entry ${n} (${restored.bytes} bytes). It applies from the next session.`,
				);
			return;
		}
		default:
			host.showError(USAGE);
	}
}
