/**
 * `/knowledge`: the owner's direct view of accepted ICM knowledge, and corrections and forgetting of exact records,
 * with no model in between. Changes pass through the shared knowledge admission after the owner confirms on their own
 * screen; the typed command is their evidence, so no judge runs and nothing is spent.
 */
import type { AgentSession } from "../../core/agent-session.ts";
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
function bounded(text: string, max: number): string {
	const line = redactKnownSecrets(text).replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function validity(record: KnowledgeRecord, at: string): string {
	if (record.validFrom > at) return `future, from ${record.validFrom}`;
	if (record.validUntil !== undefined && record.validUntil <= at) return `expired ${record.validUntil}`;
	return "current";
}

function reach(record: KnowledgeRecord): string {
	return record.scope.project ? "this project" : "global";
}

function provenance(citation: KnowledgeCitation): string {
	return citation.sourceId.startsWith(OWNER_COMMAND_SOURCE_PREFIX) ? "owner command" : "owner message";
}

function summaryLine(record: KnowledgeRecord, at: string): string {
	return [
		`${record.id.slice(0, SHORT_ID)}  ${record.kind} · ${reach(record)} · r${record.revision} · ${record.basis} · ${validity(record, at)} · evidenced ${record.lastEvidencedAt.slice(0, 10)}`,
		`    ${bounded(record.subject, 80)} / ${bounded(record.key, 80)}: ${bounded(record.text, 160)}`,
	].join("\n");
}

function parseCount(token: string | undefined, minimum: number): number | undefined {
	if (token === undefined || !/^\d{1,9}$/.test(token)) return undefined;
	const value = Number(token);
	return value >= minimum ? value : undefined;
}

/** A full id or a unique prefix of at least eight characters, live in the owner's scope. */
function resolveRecord(controls: KnowledgeOwnerControls, token: string | undefined): KnowledgeRecord | string {
	const prefix = token?.toLowerCase();
	if (!prefix || !/^[a-f0-9]{8,64}$/.test(prefix))
		return "Name a knowledge record by its id or its first 8 or more characters (see /knowledge list).";
	const matches = controls.store.resolve(controls.scope, prefix);
	if (matches.length === 0) return `No current knowledge record ${prefix} in this scope.`;
	if (matches.length > 1) return `${prefix} matches more than one record; type more of its id.`;
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
	const filter = [kind, range === undefined ? undefined : range === "global" ? "global" : "this project"]
		.filter((part) => part !== undefined)
		.join(", ");
	if (records.length === 0)
		return after
			? "No more accepted knowledge records."
			: `No accepted knowledge records${filter ? ` (${filter})` : ""}.`;
	const at = new Date().toISOString();
	return [
		`Accepted knowledge, revision ${revision}${filter ? ` (${filter})` : ""}:`,
		...records.map((record) => summaryLine(record, at)),
		...(records.length === LIST_PAGE
			? [`More: /knowledge list ${[kind, range, records.at(-1)!.id].filter((part) => part !== undefined).join(" ")}`]
			: []),
		"/knowledge show <id> for provenance · history <id> · correct <id> <new value> · forget <id>",
	].join("\n");
}

function showText(record: KnowledgeRecord, offset: number): string {
	const page = record.citations.slice(offset, offset + CITATION_PAGE);
	const short = record.id.slice(0, SHORT_ID);
	return [
		`Knowledge ${record.id}`,
		`  ${record.kind} · ${reach(record)} · revision ${record.revision} · ${record.basis} · ${validity(record, new Date().toISOString())}`,
		`  ${bounded(record.subject, 200)} / ${bounded(record.key, 200)}`,
		`  Value: ${bounded(record.text, MAX_KNOWLEDGE_TEXT_CHARS)}`,
		`  Evidenced: first ${record.firstEvidencedAt}, last ${record.lastEvidencedAt}`,
		`  Valid: from ${record.validFrom}${record.validUntil === undefined ? "" : ` until ${record.validUntil}`}`,
		`  Evidence of this revision (${offset + 1}-${offset + page.length} of ${record.citations.length}; earlier revisions keep theirs in /knowledge history ${short}):`,
		...page.map(
			(citation) =>
				`  - ${provenance(citation)}, ${citation.at}, session ${bounded(citation.sessionId, 80)}, source ${bounded(citation.sourceId, 100)}\n      "${bounded(citation.quote, 240)}"`,
		),
		...(record.citations.length > offset + page.length
			? [`More evidence: /knowledge show ${short} ${offset + page.length}`]
			: []),
	].join("\n");
}

function historyText(controls: KnowledgeOwnerControls, record: KnowledgeRecord, before?: number): string {
	const versions = controls.store.history(record.id, before).slice(0, HISTORY_PAGE);
	const short = record.id.slice(0, SHORT_ID);
	if (versions.length === 0) return `No earlier revisions of ${short}.`;
	return [
		`Revisions of ${short} (${bounded(record.subject, 80)} / ${bounded(record.key, 80)}), newest first:`,
		...versions.map(
			(version) =>
				`  r${version.revision} · ${version.basis} · evidenced ${version.lastEvidencedAt} · ${[...new Set(version.citations.map(provenance))].join(", ")}\n    ${bounded(version.text, 240)}`,
		),
		...(versions.length === HISTORY_PAGE ? [`More: /knowledge history ${short} ${versions.at(-1)!.revision}`] : []),
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
	const record = resolveRecord(controls, token);
	if (typeof record === "string") {
		host.showError(record);
		return;
	}
	// The typed command is retained as the change's evidence quote, under the same bound as any citation.
	if (text.length > MAX_KNOWLEDGE_TEXT_CHARS) {
		host.showError(`Nothing changed: the command is longer than ${MAX_KNOWLEDGE_TEXT_CHARS} characters.`);
		return;
	}
	const confirm = host.session.ownerConfirm;
	if (!confirm) {
		host.showError("Nothing changed: owner confirmation is unavailable.");
		return;
	}
	const fact = `${bounded(record.subject, 80)} / ${bounded(record.key, 80)}`;
	const confirmed =
		action === "forget"
			? await confirm(
					"Forget knowledge",
					`Forget this ${record.kind} fact at revision ${record.revision}? Its value and revision history are removed; its identity stays, so only newer owner evidence can teach it again.\n${fact}: ${bounded(record.text, 240)}`,
				)
			: await confirm(
					"Correct knowledge",
					`Replace the value of this ${record.kind} fact at revision ${record.revision}?\n${fact}\nNow: ${bounded(record.text, 240)}\nNew: ${bounded(value ?? "", 240)}`,
				);
	if (!confirmed) {
		host.showStatus("Nothing changed: the owner did not confirm.");
		return;
	}
	const outcome = controls.command(
		action === "forget"
			? { action, id: record.id, expectedRevision: record.revision, command: text }
			: { action, id: record.id, expectedRevision: record.revision, text: value ?? "", command: text },
	);
	if (outcome.status === "held") {
		host.showError(`Nothing changed: ${outcome.reason}.`);
		return;
	}
	const short = record.id.slice(0, SHORT_ID);
	host.showStatus(
		action === "forget"
			? `Forgot ${short} (revision ${outcome.revision}). Only newer owner evidence can teach it again.`
			: `Corrected ${short}: revision ${outcome.revision} holds the new value; the previous one stays in its history.`,
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
		host.showError("Owner knowledge is available while ICM memory is active in a root session.");
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
		host.showError(`Knowledge: ${error instanceof Error ? error.message : String(error)}`);
	}
}
