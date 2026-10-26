/**
 * `/verification` — the owner's view of, and authority over, open semantic verification findings.
 *
 * A finding holds the work until it is answered with evidence. Some findings cannot be answered where the work runs, for
 * example a behavior only the CI journeys or a look at the interface can show. The model has no way to close those; the
 * owner does, with a reason, and the closing is recorded on the finding as `waived`.
 */
import type { SemanticVerificationObligationView } from "../../core/system-one/verification-obligations.ts";

export interface VerificationHost {
	listVerificationFindings(): readonly SemanticVerificationObligationView[];
	waiveVerificationFindings(
		ids: readonly string[] | "all",
		note: string,
	): readonly SemanticVerificationObligationView[];
	showStatus(message: string): void;
	showError(message: string): void;
	/** Multi-line output in the conversation (status lines are single rows). */
	showText(text: string): void;
}

export const VERIFICATION_USAGE = "/verification [list] · /verification waive <id…|all> <reason>";

const MAX_NOTE_LENGTH = 500;

function describeFinding(finding: SemanticVerificationObligationView): string {
	return `${finding.id}  [${finding.source}]\n    ${finding.reason}`;
}

export async function handleVerificationCommand(host: VerificationHost, text: string): Promise<void> {
	const args = text.replace(/^\/verification\b/, "").trim();
	const [action = "list", ...rest] = args.split(/\s+/).filter(Boolean);
	if (action === "list") {
		const findings = host.listVerificationFindings();
		host.showText(
			findings.length === 0
				? "Verification — no open findings."
				: [
						`Verification — ${findings.length} open finding${findings.length === 1 ? "" : "s"}; each holds the work until it is answered with evidence or waived`,
						...findings.map(describeFinding),
						VERIFICATION_USAGE,
					].join("\n"),
		);
		return;
	}
	if (action !== "waive") {
		host.showError(`Unknown /verification action "${action}". ${VERIFICATION_USAGE}`);
		return;
	}
	const open = new Map(host.listVerificationFindings().map((finding) => [finding.id, finding]));
	const ids: string[] = [];
	let all = false;
	let index = 0;
	for (; index < rest.length; index++) {
		const token = rest[index] as string;
		if (token === "all") {
			all = true;
			continue;
		}
		if (!open.has(token)) break;
		ids.push(token);
	}
	const note = rest.slice(index).join(" ").trim();
	if (!all && ids.length === 0) {
		host.showError(`Name an open finding id or "all". ${VERIFICATION_USAGE}`);
		return;
	}
	if (note.length === 0) {
		host.showError(`A waiver needs a reason: it is recorded on the finding. ${VERIFICATION_USAGE}`);
		return;
	}
	if (note.length > MAX_NOTE_LENGTH) {
		host.showError(`The reason is ${note.length} characters; the limit is ${MAX_NOTE_LENGTH}.`);
		return;
	}
	const closed = host.waiveVerificationFindings(all ? "all" : ids, note);
	host.showStatus(
		closed.length === 0
			? "No open finding matched; nothing was waived."
			: `Waived ${closed.length} finding${closed.length === 1 ? "" : "s"}: ${closed.map((finding) => finding.id).join(", ")}.`,
	);
}
