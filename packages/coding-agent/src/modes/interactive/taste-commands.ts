/**
 * `/taste`: the owner's learned taste (how they want code and other work products written) as Markdown, on screen or in
 * a file. It reads accepted `taste` records through the owner's knowledge controls; changes stay with `/knowledge`.
 * It also holds the owner's decisions on proposals: a proposal is a candidate fact that waits, and only
 * `/taste accept` states it, by the owner's own command, after the owner confirms its exact text.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import type { KnowledgeOwnerControls } from "../../core/memory/knowledge-admission.ts";
import type { KnowledgeProposal } from "../../core/memory/knowledge-proposal-journal.ts";
import {
	type KnowledgeRecord,
	MAX_KNOWLEDGE_PAGE_SIZE,
	MAX_KNOWLEDGE_TEXT_CHARS,
} from "../../core/memory/knowledge-record.ts";
import { bounded } from "./knowledge-commands.ts";

export interface TasteCommandHost {
	readonly session: Pick<AgentSession, "memoryOperator" | "ownerConfirm">;
	/** The working directory a relative export path is held inside. */
	readonly cwd: string;
	showStatus(message: string): void;
	showError(message: string): void;
	showText(text: string): void;
}

export const TASTE_COMMAND_USAGE =
	"/taste [<after-id>] · /taste export [path] · /taste proposals · /taste accept <id> · /taste reject <id>";

const TASTE_PAGE = 20;
const TASTE_KIND = "taste";
const SHORT_ID = 8;
const DEFAULT_EXPORT_PATH = ".pi/taste.md";
const NO_TASTE =
	'No taste learned yet. Taste is learned from what you state about how you want code and other work written, for example "I prefer early returns over nested conditionals".';

function basisWords(record: KnowledgeRecord): string {
	return record.basis === "explicit" ? "stated" : "inferred";
}

function bullet(controls: KnowledgeOwnerControls, record: KnowledgeRecord): string {
	const sources = controls.store.sourceCount(record.id);
	return `- ${bounded(record.text, 400)} (${basisWords(record)}, ${sources} ${sources === 1 ? "source" : "sources"}, last evidence ${record.lastEvidencedAt.slice(0, 10)}) \`${record.id.slice(0, SHORT_ID)}\``;
}

function section(controls: KnowledgeOwnerControls, heading: string, records: readonly KnowledgeRecord[]): string[] {
	if (records.length === 0) return [];
	const bySubject = new Map<string, KnowledgeRecord[]>();
	for (const record of records) {
		const subject = bounded(record.subject, 80);
		bySubject.set(subject, [...(bySubject.get(subject) ?? []), record]);
	}
	return [
		`## ${heading}`,
		"",
		...[...bySubject].flatMap(([subject, group]) => [
			`### ${subject}`,
			"",
			...group.map((record) => bullet(controls, record)),
			"",
		]),
	];
}

function markdown(controls: KnowledgeOwnerControls, records: readonly KnowledgeRecord[]): string {
	const project = records.filter((record) => record.scope.project !== "");
	const global = records.filter((record) => record.scope.project === "");
	return [
		"# Taste",
		"",
		...section(controls, "This project's taste", project),
		...section(controls, "Global taste", global),
	]
		.join("\n")
		.trimEnd();
}

function page(controls: KnowledgeOwnerControls, after: string | undefined, limit: number): KnowledgeRecord[] {
	return controls.store.list(controls.scope, { kind: "taste", after, limit });
}

function allRecords(controls: KnowledgeOwnerControls): KnowledgeRecord[] {
	const records: KnowledgeRecord[] = [];
	for (let after: string | undefined; ; after = records.at(-1)!.id) {
		const next = page(controls, after, MAX_KNOWLEDGE_PAGE_SIZE);
		records.push(...next);
		if (next.length < MAX_KNOWLEDGE_PAGE_SIZE) return records;
	}
}

/** A relative path stays inside the working directory; an absolute path is the owner's explicit choice. */
function exportTarget(cwd: string, requested: string | undefined): string | undefined {
	const target = resolve(cwd, requested ?? DEFAULT_EXPORT_PATH);
	if (isAbsolute(requested ?? "")) return target;
	const inside = relative(resolve(cwd), target);
	return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? undefined : target;
}

function exportCommand(host: TasteCommandHost, controls: KnowledgeOwnerControls, requested: string | undefined): void {
	const target = exportTarget(host.cwd, requested);
	if (!target) {
		host.showError("Nothing written: a relative path must stay inside the working directory.");
		return;
	}
	const records = allRecords(controls);
	const body = records.length === 0 ? NO_TASTE : markdown(controls, records);
	const header = `<!-- Generated view of what the harness has learned, ${new Date().toISOString().slice(0, 10)}. Edit with /knowledge correct and /knowledge forget, not here. -->`;
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${header}\n\n${body}\n`);
	host.showStatus(`Wrote ${target}`);
}

function isTaste(proposal: KnowledgeProposal): boolean {
	return proposal.kind === TASTE_KIND;
}

function proposalBlock(proposal: KnowledgeProposal): string {
	const content = proposal.content!;
	const evidence = content.evidence.map((entry) => `  - \`${bounded(entry.ref, 80)}\` ${bounded(entry.note, 200)}`);
	return [
		`- ${bounded(content.text, 400)} \`${proposal.id.slice(0, SHORT_ID)}\``,
		`  ${proposal.project ? "This project" : "Global"} · from ${bounded(proposal.origin, 60)} · offered ${proposal.offeredAt.slice(0, 10)}`,
		...(evidence.length ? ["  Evidence:", ...evidence] : []),
	].join("\n");
}

function proposalsText(controls: KnowledgeOwnerControls): string {
	const pending = controls.store.proposals.listPending(controls.scope.project).filter(isTaste);
	if (pending.length === 0) return "No taste proposals are waiting.";
	return [
		"# Taste proposals",
		"",
		"Nothing here is knowledge yet. `/taste accept <id>` states one as your own taste; `/taste reject <id>` drops it for good.",
		"",
		...pending.map(proposalBlock),
	].join("\n");
}

/** One proposal by id prefix, still pending; an unknown, ambiguous or decided one is an error that changes nothing. */
function pendingProposal(controls: KnowledgeOwnerControls, token: string | undefined): KnowledgeProposal | string {
	if (!token || !/^[a-f0-9]{8,64}$/.test(token)) return "Give the proposal's id: at least eight hex characters.";
	const found = controls.store.proposals.resolve(controls.scope.project, token);
	if (found.length === 0) return `No proposal starts with ${token}.`;
	if (found.length > 1) return `More than one proposal starts with ${token}; give more characters.`;
	const [proposal] = found;
	if (!isTaste(proposal!))
		return `Proposal ${token.slice(0, SHORT_ID)} is not a taste proposal; /taste does not decide it.`;
	return proposal!.status === "pending"
		? proposal!
		: `Proposal ${token.slice(0, SHORT_ID)} was already ${proposal!.status}.`;
}

async function acceptCommand(
	host: TasteCommandHost,
	controls: KnowledgeOwnerControls,
	command: string,
	token: string | undefined,
): Promise<void> {
	const proposal = pendingProposal(controls, token);
	if (typeof proposal === "string") {
		host.showError(proposal);
		return;
	}
	const content = proposal.content!;
	if (command.length > MAX_KNOWLEDGE_TEXT_CHARS) {
		host.showError(`Nothing changed: the command is longer than ${MAX_KNOWLEDGE_TEXT_CHARS} characters.`);
		return;
	}
	const confirm = host.session.ownerConfirm;
	if (!confirm) {
		host.showError("Nothing changed: owner confirmation is unavailable.");
		return;
	}
	const scope = proposal.project ? "project" : "global";
	const confirmed = await confirm(
		"Accept taste",
		`State this ${proposal.kind} fact as yours, for ${scope === "project" ? "this project" : "every project"}?\n${bounded(content.text, 400)}`,
	);
	if (!confirmed) {
		host.showStatus("Nothing changed: the owner did not confirm.");
		return;
	}
	// The dialog can stay open while another session decides the same proposal.
	const current = pendingProposal(controls, proposal.id);
	if (typeof current === "string") {
		host.showError(`Nothing changed: ${current}`);
		return;
	}
	// Fact first, mark second: the same statement in the same scope is one operation, so repeating this command after
	// a crash between the two replays the fact's receipt and then marks the proposal.
	const outcome = controls.command({
		action: "state",
		kind: TASTE_KIND,
		scope,
		subject: content.subject,
		key: content.key,
		text: content.text,
		command,
	});
	if (outcome.status === "held") {
		host.showError(`Nothing changed: ${outcome.reason}. The proposal stays pending.`);
		return;
	}
	controls.store.proposals.decide(proposal.id, "accepted");
	host.showStatus(
		`Accepted proposal ${proposal.id.slice(0, SHORT_ID)} as taste ${outcome.id.slice(0, SHORT_ID)}.  /knowledge show ${outcome.id.slice(0, SHORT_ID)}`,
	);
}

function rejectCommand(host: TasteCommandHost, controls: KnowledgeOwnerControls, token: string | undefined): void {
	const proposal = pendingProposal(controls, token);
	if (typeof proposal === "string") {
		host.showError(proposal);
		return;
	}
	controls.store.proposals.decide(proposal.id, "rejected");
	host.showStatus(`Rejected proposal ${proposal.id.slice(0, SHORT_ID)}. It will not be proposed again.`);
}

export async function handleTasteCommand(host: TasteCommandHost, text: string): Promise<void> {
	const args = text
		.replace(/^\/taste\b/, "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	const controls = host.session.memoryOperator.getKnowledgeOwnerControls();
	if (!controls) {
		host.showError("Taste is available while ICM memory is active in a root session.");
		return;
	}
	try {
		if (args[0] === "export" && args.length <= 2) {
			exportCommand(host, controls, args[1]);
			return;
		}
		if (args[0] === "proposals" && args.length === 1) {
			host.showText(proposalsText(controls));
			return;
		}
		if ((args[0] === "accept" || args[0] === "reject") && args.length === 2) {
			if (args[0] === "accept") await acceptCommand(host, controls, text.trim(), args[1]);
			else rejectCommand(host, controls, args[1]);
			return;
		}
		const after = args[0];
		if (args.length > 1 || (after !== undefined && !/^[a-f0-9]{64}$/.test(after))) {
			host.showError(TASTE_COMMAND_USAGE);
			return;
		}
		const records = page(controls, after, TASTE_PAGE);
		if (records.length === 0) {
			host.showText(after ? "No more taste." : NO_TASTE);
			return;
		}
		host.showText(
			[
				markdown(controls, records),
				...(records.length === TASTE_PAGE ? [`\nMore: /taste ${records.at(-1)!.id}`] : []),
			].join("\n"),
		);
	} catch (error) {
		host.showError(`Taste: ${error instanceof Error ? error.message : String(error)}`);
	}
}
