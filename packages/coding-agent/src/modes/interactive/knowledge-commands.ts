/**
 * `/knowledge`: the owner's direct view of accepted ICM knowledge, and corrections and forgetting of exact records,
 * with no model in between. Changes pass through the shared knowledge admission after the owner confirms on their own
 * screen; the typed command is their evidence, so no judge runs and nothing is spent.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
import type { KnowledgeOwnerControls } from "../../core/memory/knowledge-admission.ts";
import {
	KNOWLEDGE_KINDS,
	type KnowledgeCitation,
	type KnowledgeKind,
	type KnowledgeRecord,
	MAX_KNOWLEDGE_TEXT_CHARS,
	OWNER_COMMAND_SOURCE_PREFIX,
} from "../../core/memory/knowledge-record.ts";
import { redactKnownSecrets } from "../../core/security/secret-text.ts";

export interface KnowledgeCommandHost {
	readonly session: Pick<AgentSession, "memoryOperator" | "ownerConfirm">;
	showStatus(message: string): void;
	showError(message: string): void;
	showText(text: string): void;
}

export const KNOWLEDGE_COMMAND_USAGE =
	"/knowledge list [<kind>|global|project] [<after-id>] · /knowledge show <id> [<citation-offset>] · /knowledge history <id> [<before-revision>] · /knowledge correct <id> <new value> · /knowledge forget <id>";

const LIST_PAGE = 10;
const HISTORY_PAGE = 5;
const CITATION_PAGE = 4;
const SHORT_ID = 12;

/** One display line: redacted before it is cut, so a cut never leaves part of a secret behind. */
export function bounded(text: string, max: number): string {
	const line = redactKnownSecrets(text).replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function validity(record: KnowledgeRecord, at: string): string {
	const words = interfaceText().knowledgeCommands.knowledge;
	if (record.validFrom > at) return words.validityFuture(record.validFrom);
	if (record.validUntil !== undefined && record.validUntil <= at) return words.validityExpired(record.validUntil);
	return words.validityCurrent;
}

function reach(record: KnowledgeRecord): string {
	const words = interfaceText().knowledgeCommands.knowledge;
	return record.scope.project ? words.reachProject : words.reachGlobal;
}

function provenance(citation: KnowledgeCitation): string {
	const words = interfaceText().knowledgeCommands.knowledge;
	return citation.sourceId.startsWith(OWNER_COMMAND_SOURCE_PREFIX) ? words.ownerCommand : words.ownerMessage;
}

function summaryLine(record: KnowledgeRecord, at: string): string {
	const words = interfaceText().knowledgeCommands.knowledge;
	return [
		`${record.id.slice(0, SHORT_ID)}  ${record.kind} · ${reach(record)} · ${words.shortRevision(record.revision)} · ${record.basis} · ${validity(record, at)} · ${words.evidenced(record.lastEvidencedAt.slice(0, 10))}`,
		words.summaryBody(bounded(record.subject, 80), bounded(record.key, 80), bounded(record.text, 160)),
	].join("\n");
}

function parseCount(token: string | undefined, minimum: number): number | undefined {
	if (token === undefined || !/^\d{1,9}$/.test(token)) return undefined;
	const value = Number(token);
	return value >= minimum ? value : undefined;
}

/** A full id or a unique prefix of at least eight characters, live in the owner's scope. */
function resolveRecord(controls: KnowledgeOwnerControls, token: string | undefined): KnowledgeRecord | string {
	const words = interfaceText().knowledgeCommands.knowledge;
	const prefix = token?.toLowerCase();
	if (!prefix || !/^[a-f0-9]{8,64}$/.test(prefix)) return words.needId;
	const matches = controls.store.resolve(controls.scope, prefix);
	if (matches.length === 0) return words.unknownRecord(prefix);
	if (matches.length > 1) return words.ambiguousRecord(prefix);
	return matches[0]!;
}

function listText(controls: KnowledgeOwnerControls, args: readonly string[]): string | undefined {
	let kind: KnowledgeKind | undefined;
	let range: "global" | "project" | undefined;
	let after: string | undefined;
	for (const token of args) {
		const named = KNOWLEDGE_KINDS.find((candidate) => candidate === token);
		if (named && kind === undefined) kind = named;
		else if ((token === "global" || token === "project") && range === undefined) range = token;
		else if (/^[a-f0-9]{64}$/.test(token) && after === undefined) after = token;
		else return undefined;
	}
	const revision = controls.store.revision();
	const records = controls.store.list(controls.scope, { kind, reach: range, after, limit: LIST_PAGE });
	const words = interfaceText().knowledgeCommands.knowledge;
	const filter = [kind, range === undefined ? undefined : range === "global" ? words.reachGlobal : words.reachProject]
		.filter((part) => part !== undefined)
		.join(", ");
	if (records.length === 0) return after ? words.noMore : words.none(filter ? ` (${filter})` : "");
	const at = new Date().toISOString();
	const query = [kind, range, records.at(-1)!.id].filter((part) => part !== undefined).join(" ");
	return [
		words.listHead(revision, filter ? ` (${filter})` : ""),
		...records.map((record) => summaryLine(record, at)),
		...(records.length === LIST_PAGE ? [words.listMore(query)] : []),
		words.listHint,
	].join("\n");
}

function showText(record: KnowledgeRecord, offset: number): string {
	const words = interfaceText().knowledgeCommands.knowledge;
	const page = record.citations.slice(offset, offset + CITATION_PAGE);
	const short = record.id.slice(0, SHORT_ID);
	const until = record.validUntil === undefined ? "" : words.validUntilPart(record.validUntil);
	return [
		words.title(record.id),
		`  ${record.kind} · ${reach(record)} · ${words.revision(record.revision)} · ${record.basis} · ${validity(record, new Date().toISOString())}`,
		words.factLine(bounded(record.subject, 200), bounded(record.key, 200)),
		words.value(bounded(record.text, MAX_KNOWLEDGE_TEXT_CHARS)),
		words.evidencedRange(record.firstEvidencedAt, record.lastEvidencedAt),
		words.validRange(record.validFrom, until),
		words.evidenceHead(offset + 1, offset + page.length, record.citations.length, short),
		...page.map((citation) =>
			words.citation(
				provenance(citation),
				citation.at,
				bounded(citation.sessionId, 80),
				bounded(citation.sourceId, 100),
				bounded(citation.quote, 240),
			),
		),
		...(record.citations.length > offset + page.length ? [words.moreEvidence(short, offset + page.length)] : []),
	].join("\n");
}

function historyText(controls: KnowledgeOwnerControls, record: KnowledgeRecord, before?: number): string {
	const words = interfaceText().knowledgeCommands.knowledge;
	const versions = controls.store.history(record.id, before).slice(0, HISTORY_PAGE);
	const short = record.id.slice(0, SHORT_ID);
	if (versions.length === 0) return words.historyNone(short);
	return [
		words.historyHead(short, bounded(record.subject, 80), bounded(record.key, 80)),
		...versions.map((version) =>
			words.historyVersion(
				version.revision,
				version.basis,
				version.lastEvidencedAt,
				[...new Set(version.citations.map(provenance))].join(", "),
				bounded(version.text, 240),
			),
		),
		...(versions.length === HISTORY_PAGE ? [words.historyMore(short, versions.at(-1)!.revision)] : []),
	].join("\n");
}

async function change(
	host: KnowledgeCommandHost,
	controls: KnowledgeOwnerControls,
	text: string,
	action: "forget" | "correct",
	token: string | undefined,
	value: string | undefined,
): Promise<void> {
	const words = interfaceText().knowledgeCommands.knowledge;
	const record = resolveRecord(controls, token);
	if (typeof record === "string") {
		host.showError(record);
		return;
	}
	// The typed command is retained as the change's evidence quote, under the same bound as any citation.
	if (text.length > MAX_KNOWLEDGE_TEXT_CHARS) {
		host.showError(words.commandTooLong(MAX_KNOWLEDGE_TEXT_CHARS));
		return;
	}
	const confirm = host.session.ownerConfirm;
	if (!confirm) {
		host.showError(words.noConfirmation);
		return;
	}
	const fact = `${bounded(record.subject, 80)} / ${bounded(record.key, 80)}`;
	const confirmed =
		action === "forget"
			? await confirm(
					words.forgetTitle,
					words.forgetQuestion(record.kind, record.revision, fact, bounded(record.text, 240)),
				)
			: await confirm(
					words.correctTitle,
					words.correctQuestion(
						record.kind,
						record.revision,
						fact,
						bounded(record.text, 240),
						bounded(value ?? "", 240),
					),
				);
	if (!confirmed) {
		host.showStatus(words.notConfirmed);
		return;
	}
	const outcome = controls.command(
		action === "forget"
			? { action, id: record.id, expectedRevision: record.revision, command: text }
			: { action, id: record.id, expectedRevision: record.revision, text: value ?? "", command: text },
	);
	if (outcome.status === "held") {
		host.showError(words.held(outcome.reason));
		return;
	}
	const short = record.id.slice(0, SHORT_ID);
	host.showStatus(
		action === "forget" ? words.forgot(short, outcome.revision) : words.corrected(short, outcome.revision),
	);
}

export async function handleKnowledgeCommand(host: KnowledgeCommandHost, text: string): Promise<void> {
	const [action = "list", ...rest] = text
		.replace(/^\/knowledge\b/, "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	const controls = host.session.memoryOperator.getKnowledgeOwnerControls();
	if (!controls) {
		host.showError(interfaceText().knowledgeCommands.knowledge.unavailable);
		return;
	}
	try {
		if (action === "list") {
			const listed = listText(controls, rest);
			if (listed === undefined) host.showError(KNOWLEDGE_COMMAND_USAGE);
			else host.showText(listed);
			return;
		}
		if (action === "show" || action === "history") {
			const record = resolveRecord(controls, rest[0]);
			if (typeof record === "string") {
				host.showError(record);
				return;
			}
			const position = rest[1] === undefined ? undefined : parseCount(rest[1], action === "show" ? 0 : 1);
			if (
				rest.length > 2 ||
				(rest[1] !== undefined && position === undefined) ||
				(action === "show" && position !== undefined && position >= record.citations.length)
			) {
				host.showError(KNOWLEDGE_COMMAND_USAGE);
				return;
			}
			host.showText(action === "show" ? showText(record, position ?? 0) : historyText(controls, record, position));
			return;
		}
		if (action === "forget") {
			if (rest.length !== 1) host.showError(KNOWLEDGE_COMMAND_USAGE);
			else await change(host, controls, text, action, rest[0], undefined);
			return;
		}
		if (action === "correct") {
			// The new value is the owner's own text after the id, taken verbatim; only its surrounding whitespace is dropped.
			const value = /^\/knowledge\s+correct\s+\S+\s+([\s\S]+)$/.exec(text)?.[1]?.trim();
			if (!value) host.showError(KNOWLEDGE_COMMAND_USAGE);
			else await change(host, controls, text, action, rest[0], value);
			return;
		}
		host.showError(KNOWLEDGE_COMMAND_USAGE);
	} catch (error) {
		host.showError(
			interfaceText().knowledgeCommands.knowledge.failed(error instanceof Error ? error.message : String(error)),
		);
	}
}
