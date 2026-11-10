/**
 * `/taste`: the owner's learned taste (how they want code and other work products written) as Markdown, on screen or in
 * a file. It reads accepted `taste` records through the owner's knowledge controls; changes stay with `/knowledge`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentSession } from "../../core/agent-session.ts";
import type { KnowledgeOwnerControls } from "../../core/memory/knowledge-admission.ts";
import { type KnowledgeRecord, MAX_KNOWLEDGE_PAGE_SIZE } from "../../core/memory/knowledge-record.ts";
import { bounded } from "./knowledge-commands.ts";

export interface TasteCommandHost {
	readonly session: Pick<AgentSession, "memoryOperator">;
	/** The working directory a relative export path is held inside. */
	readonly cwd: string;
	showStatus(message: string): void;
	showError(message: string): void;
	showText(text: string): void;
}

export const TASTE_COMMAND_USAGE = "/taste [<after-id>] · /taste export [path]";

const TASTE_PAGE = 20;
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
