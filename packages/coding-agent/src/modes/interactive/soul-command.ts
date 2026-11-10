/**
 * `/soul` -- the owner's view of the agent's soul file.
 *
 * `/soul` edits `<agentDir>/soul.md` in a panel, `/soul show` prints it, `/soul review` runs the System One soul review
 * on the current text, `/soul history` lists the recorded writes and `/soul restore <n>` writes one back. An owner write
 * passes the deterministic screen and skips the System One judgment: the owner is the authority on the soul.
 */
import { interfaceText } from "../../core/language/interface-text.ts";
import type { SoulController } from "../../core/soul/soul-controller.ts";
import { formatSoulReview } from "../../core/soul/soul-review.ts";
import { harnessLog } from "../../kernel/harness-log.ts";

export interface SoulCommandHost {
	soul: SoulController;
	promptForEdit(title: string, prefill: string): Promise<string | undefined>;
	showStatus(message: string): void;
	showError(message: string): void;
}

function formatHistory(soul: SoulController): string {
	const text = interfaceText().smallCommands.soul;
	const entries = soul.history();
	if (entries.length === 0) return text.historyEmpty;
	harnessLog.debug("ui", "soul history entries shown", { digests: entries.map((entry) => entry.sha256.slice(0, 8)) });
	return [
		text.historyHeader,
		...entries.map((entry, index) =>
			text.historyEntry({
				index,
				at: entry.at,
				author: entry.author,
				reviewer: entry.reviewer,
				event: entry.event,
				withheld: Boolean(entry.withheld),
				bytes: entry.bytes,
			}),
		),
	].join("\n");
}

export async function handleSoulCommand(host: SoulCommandHost, text: string): Promise<void> {
	const { soul } = host;
	const words = interfaceText().smallCommands.soul;
	const [subcommand = "", ...rest] = text.slice("/soul".length).trim().split(/\s+/).filter(Boolean);
	switch (subcommand) {
		case "": {
			const current = soul.read();
			const edited = await host.promptForEdit(words.editTitle, current ?? soul.template());
			if (edited === undefined) {
				host.showStatus(words.editCancelled);
				return;
			}
			if (edited === current) {
				host.showStatus(words.unchanged);
				return;
			}
			const saved = soul.saveFromOwner(edited, { text: current });
			if (!saved.ok) {
				host.showError(words.notSaved(saved.reason));
				return;
			}
			host.showStatus(words.saved(saved.bytes));
			return;
		}
		case "show": {
			const current = soul.read();
			host.showStatus(current ?? words.missing(soul.path));
			return;
		}
		case "review": {
			const report = await soul.review();
			if (report.kind === "missing") host.showStatus(words.reviewMissing(report.path));
			else if (report.kind === "unavailable") host.showStatus(words.reviewUnavailable);
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
				host.showError(words.restoreUsage);
				return;
			}
			const restored = soul.restore(n);
			if (!restored.ok) host.showError(words.notRestored(restored.reason));
			else host.showStatus(words.restored(n, restored.bytes));
			return;
		}
		default:
			host.showError(words.usage);
	}
}
