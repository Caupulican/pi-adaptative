/**
 * `/taste`: the owner's learned taste (how they want code and other work products written) as Markdown, on screen or in
 * a file. It reads accepted `taste` records through the owner's knowledge controls; changes stay with `/knowledge`.
 * It also holds the owner's decisions on proposals: a proposal is a candidate fact that waits, and only
 * `/taste accept` states it, by the owner's own command, after the owner confirms its exact text.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
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
function basisWords(record: KnowledgeRecord): string {
	const words = interfaceText().knowledgeCommands.taste;
	return record.basis === "explicit" ? words.basisStated : words.basisInferred;
}

function bullet(controls: KnowledgeOwnerControls, record: KnowledgeRecord): string {
	const words = interfaceText().knowledgeCommands.taste;
	const sources = controls.store.sourceCount(record.id);
	return words.bullet(
		bounded(record.text, 400),
		basisWords(record),
		words.sourceCount(sources),
		record.lastEvidencedAt.slice(0, 10),
		record.id.slice(0, SHORT_ID),
	);
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
	const words = interfaceText().knowledgeCommands.taste;
	const project = records.filter((record) => record.scope.project !== "");
	const global = records.filter((record) => record.scope.project === "");
	return [
		words.title,
		"",
		...section(controls, words.projectHeading, project),
		...section(controls, words.globalHeading, global),
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
	const words = interfaceText().knowledgeCommands.taste;
	const target = exportTarget(host.cwd, requested);
	if (!target) {
		host.showError(words.exportRelativePath);
		return;
	}
	const records = allRecords(controls);
	const body = records.length === 0 ? words.empty : markdown(controls, records);
	const header = words.exportHeader(new Date().toISOString().slice(0, 10));
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, `${header}\n\n${body}\n`);
	host.showStatus(words.exported(target));
}

function isTaste(proposal: KnowledgeProposal): boolean {
	return proposal.kind === TASTE_KIND;
}

function proposalBlock(proposal: KnowledgeProposal): string {
	const words = interfaceText().knowledgeCommands.taste;
	const content = proposal.content!;
	const evidence = content.evidence.map((entry) => `  - \`${bounded(entry.ref, 80)}\` ${bounded(entry.note, 200)}`);
	const scope = proposal.project ? words.proposalScopeProject : words.proposalScopeGlobal;
	return [
		words.proposalHead(bounded(content.text, 400), proposal.id.slice(0, SHORT_ID)),
		words.proposalMeta(scope, bounded(proposal.origin, 60), proposal.offeredAt.slice(0, 10)),
		...(evidence.length ? [words.proposalEvidence, ...evidence] : []),
	].join("\n");
}

function proposalsText(controls: KnowledgeOwnerControls): string {
	const words = interfaceText().knowledgeCommands.taste;
	const pending = controls.store.proposals.listPending(controls.scope.project).filter(isTaste);
	if (pending.length === 0) return words.noProposals;
	return [words.proposalsTitle, "", words.proposalsIntro, "", ...pending.map(proposalBlock)].join("\n");
}

/** One proposal by id prefix, still pending; an unknown, ambiguous or decided one is an error that changes nothing. */
function pendingProposal(controls: KnowledgeOwnerControls, token: string | undefined): KnowledgeProposal | string {
	const words = interfaceText().knowledgeCommands.taste;
	if (!token || !/^[a-f0-9]{8,64}$/.test(token)) return words.needProposalId;
	const found = controls.store.proposals.resolve(controls.scope.project, token);
	if (found.length === 0) return words.noProposalStartsWith(token);
	if (found.length > 1) return words.ambiguousProposal(token);
	const [proposal] = found;
	if (!isTaste(proposal!)) return words.notTasteProposal(token.slice(0, SHORT_ID));
	return proposal!.status === "pending" ? proposal! : words.alreadyDecided(token.slice(0, SHORT_ID), proposal!.status);
}

async function acceptCommand(
	host: TasteCommandHost,
	controls: KnowledgeOwnerControls,
	command: string,
	token: string | undefined,
): Promise<void> {
	const words = interfaceText().knowledgeCommands.taste;
	const proposal = pendingProposal(controls, token);
	if (typeof proposal === "string") {
		host.showError(proposal);
		return;
	}
	const content = proposal.content!;
	if (command.length > MAX_KNOWLEDGE_TEXT_CHARS) {
		host.showError(words.commandTooLong(MAX_KNOWLEDGE_TEXT_CHARS));
		return;
	}
	const confirm = host.session.ownerConfirm;
	if (!confirm) {
		host.showError(words.noConfirmation);
		return;
	}
	const scope = proposal.project ? "project" : "global";
	const confirmed = await confirm(
		words.acceptTitle,
		words.acceptQuestion(
			proposal.kind,
			scope === "project" ? words.scopeProject : words.scopeEveryProject,
			bounded(content.text, 400),
		),
	);
	if (!confirmed) {
		host.showStatus(words.notConfirmed);
		return;
	}
	// The dialog can stay open while another session decides the same proposal.
	const current = pendingProposal(controls, proposal.id);
	if (typeof current === "string") {
		host.showError(words.unchanged(current));
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
		host.showError(words.held(outcome.reason));
		return;
	}
	controls.store.proposals.decide(proposal.id, "accepted");
	host.showStatus(words.accepted(proposal.id.slice(0, SHORT_ID), outcome.id.slice(0, SHORT_ID)));
}

function rejectCommand(host: TasteCommandHost, controls: KnowledgeOwnerControls, token: string | undefined): void {
	const words = interfaceText().knowledgeCommands.taste;
	const proposal = pendingProposal(controls, token);
	if (typeof proposal === "string") {
		host.showError(proposal);
		return;
	}
	controls.store.proposals.decide(proposal.id, "rejected");
	host.showStatus(words.rejected(proposal.id.slice(0, SHORT_ID)));
}

export async function handleTasteCommand(host: TasteCommandHost, text: string): Promise<void> {
	const args = text
		.replace(/^\/taste\b/, "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	const controls = host.session.memoryOperator.getKnowledgeOwnerControls();
	if (!controls) {
		host.showError(interfaceText().knowledgeCommands.taste.unavailable);
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
			host.showText(
				after ? interfaceText().knowledgeCommands.taste.noMore : interfaceText().knowledgeCommands.taste.empty,
			);
			return;
		}
		host.showText(
			[
				markdown(controls, records),
				...(records.length === TASTE_PAGE
					? [interfaceText().knowledgeCommands.taste.more(records.at(-1)!.id)]
					: []),
			].join("\n"),
		);
	} catch (error) {
		host.showError(
			interfaceText().knowledgeCommands.taste.failed(error instanceof Error ? error.message : String(error)),
		);
	}
}
