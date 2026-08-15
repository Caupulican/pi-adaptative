import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	MAX_CONTRACT_PROCESS_CHARS,
	MAX_HUMAN_CHECK_CHARS,
	MAX_PIPELINE_NAME_LENGTH,
	type PipelineForm,
	type PipelineInputRef,
	type StageContract,
} from "./types.ts";

const FORMS: readonly PipelineForm[] = [
	"pipeline",
	"umbrella",
	"record-library",
	"knowledge-bundle",
	"context-map",
	"system-map",
];

export interface ParsedWorkspaceContract {
	name?: string;
	description?: string;
	form: PipelineForm;
	body: string;
}

function section(body: string, heading: string): string {
	const pattern = new RegExp(`^##\\s+${heading}\\s*$`, "im");
	const start = body.search(pattern);
	if (start === -1) return "";
	const after = body.slice(start).split("\n").slice(1);
	const lines: string[] = [];
	for (const line of after) {
		if (/^##\s+/.test(line)) break;
		lines.push(line);
	}
	return lines.join("\n").trim();
}

function listLines(text: string): string[] {
	const items: string[] = [];
	for (const raw of text.split("\n")) {
		const match = raw.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
		if (match) items.push(match[1].trim());
	}
	return items;
}

function classifyInput(line: string): PipelineInputRef | undefined {
	const working = line.match(/^(?:Working(?:\s+\(this run\))?|4|Layer\s*4)\s*:\s*(.+)$/i);
	if (working) return { kind: "working", path: working[1].trim() };
	const reference = line.match(/^(?:Reference(?:\s+\(every run\))?|3|Layer\s*3)\s*:\s*(.+)$/i);
	if (reference) return { kind: "reference", path: reference[1].trim() };
	const numbered = line.match(/^([34])\s*:\s*(.+)$/);
	if (numbered) return { kind: numbered[1] === "3" ? "reference" : "working", path: numbered[2].trim() };
	return undefined;
}

export function parseWorkspaceFrontmatter(content: string): ParsedWorkspaceContract {
	const parsed = parseFrontmatter<Record<string, unknown>>(content);
	const fm = isPlainRecord(parsed.frontmatter) ? parsed.frontmatter : {};
	const name = typeof fm.name === "string" ? fm.name.trim() : undefined;
	const description = typeof fm.description === "string" ? fm.description.trim() : undefined;
	const formRaw = typeof fm.form === "string" ? fm.form.trim() : "pipeline";
	const form = FORMS.includes(formRaw as PipelineForm) ? (formRaw as PipelineForm) : "pipeline";
	if (name && name.length > MAX_PIPELINE_NAME_LENGTH) {
		throw new Error(`Pipeline name exceeds ${MAX_PIPELINE_NAME_LENGTH} characters.`);
	}
	return { name, description, form, body: parsed.body };
}

export function parseStageContract(content: string): StageContract {
	const { body } = parseFrontmatter(content);
	const titleLine = body.split("\n").find((line) => line.startsWith("# ")) ?? "";
	const title = titleLine.replace(/^#\s+/, "").trim();
	const oneJobMatch = body.match(/^One job:\s*(.+)$/im);
	const inputsSection = section(body, "Inputs");
	const processSection = section(body, "Process");
	const outputsSection = section(body, "Outputs");
	const humanSection = section(body, "Human check");
	const doNot: string[] = [];
	const inputs: PipelineInputRef[] = [];
	for (const raw of inputsSection.split("\n")) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		const doNotLine = trimmed.match(/^do not load:?\s*(.+)$/i);
		if (doNotLine) {
			doNot.push(doNotLine[1].trim());
			continue;
		}
		const listed = trimmed.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
		const line = listed ? listed[1].trim() : trimmed;
		if (/^do not load/i.test(line)) {
			doNot.push(line.replace(/^do not load:?\s*/i, "").trim());
			continue;
		}
		const input = classifyInput(line);
		if (input) inputs.push(input);
	}
	const process = listLines(processSection);
	if (process.join("\n").length > MAX_CONTRACT_PROCESS_CHARS) {
		throw new Error(`Stage process exceeds ${MAX_CONTRACT_PROCESS_CHARS} characters.`);
	}
	const outputs = listLines(outputsSection).map((line) => line.replace(/\s*→\s*output\/?\s*$/i, "").trim());
	const humanCheck = humanSection.slice(0, MAX_HUMAN_CHECK_CHARS);
	return {
		title,
		oneJob: (oneJobMatch?.[1] ?? "").trim(),
		inputs,
		doNotLoad: doNot,
		process,
		outputs,
		humanCheck,
	};
}
