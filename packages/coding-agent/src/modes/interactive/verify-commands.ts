/**
 * `/verify` — the operator's view of, and authority over, verification obligations.
 *
 * An obligation opens when a trusted test run fails; it resolves when the same check passes, or
 * here, by the operator's own decision (an environment fault, a check that cannot run on this
 * machine). The dismissal is a user-plane record: the model has no tool for it, and it is never a
 * passing test.
 */
import { interfaceText } from "../../core/language/interface-text.ts";
import type { VerificationObligationView } from "../../kernel/verification-obligations.ts";

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
	const words = interfaceText().autonomyCommands.verify;
	const where = obligation.cwd ? words.where(obligation.cwd) : "";
	const what = obligation.command ? `${obligation.command}${where}` : words.commandMissing;
	const setup = obligation.setupRepairGroup ? words.setupFailure : "";
	return `${index + 1}. ${what}${setup}${words.idLine(obligation.id)}`;
}

export async function handleVerifyCommand(host: VerifyHost, text: string): Promise<void> {
	const args = text.replace(/^\/verify\b/, "").trim();
	const [action = "list", ...rest] = args.split(/\s+/).filter(Boolean);
	const obligations = host.getVerificationObligations();
	if (action === "list" || action === "") {
		if (obligations.length === 0) {
			host.showStatus(interfaceText().autonomyCommands.verify.none);
			return;
		}
		host.showText(
			[interfaceText().autonomyCommands.verify.active(obligations.length), ...obligations.map(describe)].join("\n"),
		);
		return;
	}
	if (action === "show") {
		const id = rest[0];
		const obligation = obligations.find((candidate) => candidate.id === id);
		if (!obligation) {
			host.showError(id ? interfaceText().autonomyCommands.verify.unknown(id) : VERIFY_USAGE);
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
				target === "all"
					? interfaceText().autonomyCommands.verify.none
					: interfaceText().autonomyCommands.verify.unknown(target),
			);
			return;
		}
		const dismissed = await host.dismissVerificationObligations(ids, note);
		if (dismissed.length === 0) {
			host.showError(interfaceText().autonomyCommands.verify.nothingDismissed);
			return;
		}
		host.showStatus(interfaceText().autonomyCommands.verify.dismissed(dismissed.length));
		return;
	}
	host.showError(VERIFY_USAGE);
}
