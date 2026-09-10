/**
 * `/verify` — the operator's view of, and authority over, verification obligations.
 *
 * An obligation opens when a trusted test run fails; it resolves when the same check passes, or
 * here, by the operator's own decision (an environment fault, a check that cannot run on this
 * machine). The dismissal is a user-plane record: the model has no tool for it, and it is never a
 * passing test.
 */
import type { VerificationObligationView } from "@caupulican/pi-agent-core/verification-obligations";

export interface VerifyHost {
	getVerificationObligations(): VerificationObligationView[];
	dismissVerificationObligations(ids: readonly string[], note?: string): Promise<string[]>;
	showStatus(message: string): void;
	showError(message: string): void;
	/** Multi-line output in the conversation (status lines are single rows). */
	showText(text: string): void;
}

export const VERIFY_USAGE = "/verify [list] · /verify show <id> · /verify dismiss <id|all> [note]";

function describe(obligation: VerificationObligationView, index: number): string {
	const where = obligation.cwd ? ` (in ${obligation.cwd})` : "";
	const what = obligation.command ? `${obligation.command}${where}` : "(command not recorded)";
	const setup = obligation.setupRepairGroup ? " · empty-test setup failure" : "";
	return `${index + 1}. ${what}${setup}\n   id ${obligation.id}`;
}

export async function handleVerifyCommand(host: VerifyHost, text: string): Promise<void> {
	const args = text.replace(/^\/verify\b/, "").trim();
	const [action = "list", ...rest] = args.split(/\s+/).filter(Boolean);
	const obligations = host.getVerificationObligations();
	if (action === "list" || action === "") {
		if (obligations.length === 0) {
			host.showStatus("No verification obligations are active.");
			return;
		}
		host.showText(
			[
				`${obligations.length} verification obligation${obligations.length > 1 ? "s" : ""} active — rerun the same check, or /verify dismiss <id|all> [note]`,
				...obligations.map(describe),
			].join("\n"),
		);
		return;
	}
	if (action === "show") {
		const id = rest[0];
		const obligation = obligations.find((candidate) => candidate.id === id);
		if (!obligation) {
			host.showError(id ? `No active obligation ${id}.` : VERIFY_USAGE);
			return;
		}
		host.showText(describe(obligation, 0));
		return;
	}
	if (action === "dismiss") {
		const target = rest[0];
		if (!target) {
			host.showError(VERIFY_USAGE);
			return;
		}
		const ids = target === "all" ? obligations.map((obligation) => obligation.id) : [target];
		const note = rest.slice(1).join(" ").trim() || undefined;
		if (ids.length === 0 || (target !== "all" && !obligations.some((obligation) => obligation.id === target))) {
			host.showError(
				target === "all" ? "No verification obligations are active." : `No active obligation ${target}.`,
			);
			return;
		}
		const dismissed = await host.dismissVerificationObligations(ids, note);
		if (dismissed.length === 0) {
			host.showError("Nothing was dismissed.");
			return;
		}
		host.showStatus(
			`Dismissed ${dismissed.length} verification obligation${dismissed.length > 1 ? "s" : ""} by operator authority; goal completion no longer waits on ${dismissed.length > 1 ? "them" : "it"}.`,
		);
		return;
	}
	host.showError(VERIFY_USAGE);
}
