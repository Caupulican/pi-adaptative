/**
 * Host injections as canonical records with a tagged model view: the authority context, the task-directory
 * context and the path-alias legend.
 *
 * The owner of each fact builds its record; the request planner records the rendering as a transient record and
 * carries the record in `details.record` (kernel transient-records.ts). A consumer reads the record, never the
 * rendering. A view is a header line of tags, then one line per item; identifiers are bare tags when they are
 * plain tokens, and every free-text value is one JSON string escaped for `& < >`, so no value can end a line or
 * forge a tag. Each rendering is a total function of its record: append-on-change compares rendered text.
 */

import { quoted, tag } from "../../kernel/tagged-view.ts";
import type { EdgeGrantView } from "../autonomy/edge-policy.ts";
import type { TaskDirectoryBinding } from "../tasks/task-directory-state.ts";
import { COMMS_RECORD_VERSION, type CommsRecordVersion } from "./comms-records.ts";

// Authority context

/** Longest grant quote or note the authority view carries; a longer one is named by its durable entry instead. */
export const MAX_AUTHORITY_GRANT_FIELD_CHARS = 1000;

export const AUTHORITY_CONTEXT_CLEARED_TEXT =
	"AUTHORITY CONTEXT: none. No active recorded edge grants; verify specific owner instructions or recorded grants before assuming delegated authority.";

/** A grant field too long for the view: the durable entry that holds it in full. */
export interface AuthorityOverCapacityField {
	readonly overCapacityEntry: string;
}

export interface AuthorityGrantItem {
	readonly class: string;
	readonly source: string;
	/** Present for a narrow grant: only this exact registered script/argv is authorized, never the class. */
	readonly scopeKey?: string;
	readonly quote?: string | AuthorityOverCapacityField;
	readonly note?: string | AuthorityOverCapacityField;
	readonly grantedAt?: string;
}

/** The session's active edge grants; no grant is the cleared record. */
export interface AuthorityContextRecord {
	readonly v: CommsRecordVersion;
	readonly k: "authority";
	readonly grants: readonly AuthorityGrantItem[];
}

function grantField(value: string | undefined, entry: string): string | AuthorityOverCapacityField | undefined {
	if (!value) return undefined;
	const clean = value.trim().replace(/[\r\n]+/g, " ");
	return clean.length <= MAX_AUTHORITY_GRANT_FIELD_CHARS ? clean : { overCapacityEntry: entry };
}

export function buildAuthorityContextRecord(grants: readonly EdgeGrantView[]): AuthorityContextRecord {
	return {
		v: COMMS_RECORD_VERSION,
		k: "authority",
		grants: grants.map((grant) => {
			const entry = grant.messageEntryId ?? grant.grantedAt ?? "record";
			const scopeKey = grant.scopeKey?.trim();
			const quote = grantField(grant.quote, entry);
			const note = grantField(grant.note, entry);
			return {
				class: grant.class,
				source: grant.source,
				...(scopeKey ? { scopeKey } : {}),
				...(quote !== undefined ? { quote } : {}),
				...(note !== undefined ? { note } : {}),
				...(grant.grantedAt ? { grantedAt: grant.grantedAt } : {}),
			};
		}),
	};
}

function renderGrantField(name: "quote" | "note", value: string | AuthorityOverCapacityField | undefined): string[] {
	if (value === undefined) return [];
	return typeof value === "string"
		? [`${name}=${quoted(value)}`]
		: [`${name}_over_capacity_entry=${tag(value.overCapacityEntry)}`];
}

function isOverCapacity(value: string | AuthorityOverCapacityField | undefined): boolean {
	return value !== undefined && typeof value !== "string";
}

/** The model view of the authority record. */
export function renderAuthorityContext(record: AuthorityContextRecord): string {
	if (record.grants.length === 0) return AUTHORITY_CONTEXT_CLEARED_TEXT;
	const header = [
		`AUTHORITY grants=${record.grants.length}: these grants already authorize execution; ask no new permission for covered work; continue task prerequisites and recoverable failures autonomously; respect each grant's conditions and scope.`,
	];
	if (record.grants.some((grant) => grant.scopeKey !== undefined)) {
		header.push("scope=exact authorizes only the registered script/argv named by key, never the whole class.");
	}
	if (record.grants.some((grant) => isOverCapacity(grant.quote) || isOverCapacity(grant.note))) {
		header.push(
			"A *_over_capacity_entry field did not fit: do not assume unconditioned authority; inspect that durable entry for its full conditions and scope.",
		);
	}
	const lines = record.grants.map((grant) =>
		[
			`grant ${tag(grant.class)}`,
			`source=${tag(grant.source)}`,
			...(grant.scopeKey ? ["scope=exact", `key=${quoted(grant.scopeKey)}`] : ["scope=class"]),
			...renderGrantField("quote", grant.quote),
			...renderGrantField("note", grant.note),
			...(grant.grantedAt ? [`at=${tag(grant.grantedAt)}`] : []),
		].join(" "),
	);
	return [header.join(" "), ...lines].join("\n");
}

// Task directory context

export const MAX_TASK_DIRECTORY_CONTEXT_BYTES = 16 * 1024;

const TASK_DIRECTORY_CONTEXT_FOOTER =
	"Saved intent, not filesystem validation. task_steps selects the active task; unpinned tasks follow workspace selection. Use task_directory status to page through full state; admission validates the directory before execution.";

export interface TaskDirectoryActiveItem {
	readonly taskId?: string;
	readonly pinned: boolean;
	readonly workspaceId?: string;
	/** Absent when the path did not fit the bound (`cwdOmitted`): a truncated path is never shown. */
	readonly cwd?: string;
}

export interface TaskDirectoryContextRecord {
	readonly v: CommsRecordVersion;
	readonly k: "task_directory";
	readonly revision: number;
	readonly selectedWorkspaceId: string;
	readonly active: TaskDirectoryActiveItem;
	readonly cwdOmitted: boolean;
	readonly workspaces: readonly { readonly workspaceId: string; readonly root: string }[];
	readonly bindings: readonly TaskDirectoryBinding[];
	readonly omittedWorkspaces: number;
	readonly omittedBindings: number;
}

function renderTaskDirectoryHeader(record: TaskDirectoryContextRecord): string {
	const { active } = record;
	return [
		"TASK DIRECTORY",
		`rev=${record.revision}`,
		`selected=${tag(record.selectedWorkspaceId)}`,
		...(active.taskId !== undefined ? [`active_task=${tag(active.taskId)}`] : []),
		`pinned=${active.pinned}`,
		...(active.workspaceId !== undefined ? [`workspace=${tag(active.workspaceId)}`] : []),
		record.cwdOmitted || active.cwd === undefined ? "cwd_omitted=true" : `cwd=${quoted(active.cwd)}`,
	].join(" ");
}

function renderTaskWorkspaceLine(workspace: TaskDirectoryContextRecord["workspaces"][number]): string {
	return `workspace ${tag(workspace.workspaceId)} root=${quoted(workspace.root)}`;
}

function renderTaskBindingLine(binding: TaskDirectoryBinding): string {
	return [
		`binding ${tag(binding.taskId)}`,
		`pinned=${binding.pinned}`,
		...(binding.workspaceId !== undefined ? [`workspace=${tag(binding.workspaceId)}`] : []),
		`path=${quoted(binding.path)}`,
	].join(" ");
}

function renderTaskOmittedLine(record: TaskDirectoryContextRecord): string | undefined {
	if (record.omittedWorkspaces === 0 && record.omittedBindings === 0) return undefined;
	return `omitted workspaces=${record.omittedWorkspaces} bindings=${record.omittedBindings} (see task_directory status)`;
}

/** The model view of the task-directory record. */
export function renderTaskDirectoryContext(record: TaskDirectoryContextRecord): string {
	const omitted = renderTaskOmittedLine(record);
	return [
		renderTaskDirectoryHeader(record),
		...record.workspaces.map(renderTaskWorkspaceLine),
		...record.bindings.map(renderTaskBindingLine),
		...(omitted ? [omitted] : []),
		TASK_DIRECTORY_CONTEXT_FOOTER,
	].join("\n");
}

/**
 * The record for one directory state, bounded to `MAX_TASK_DIRECTORY_CONTEXT_BYTES` of rendered view. A path is
 * never truncated: an active cwd too large for the bound is omitted explicitly, and rows that do not fit are
 * counted as omitted.
 */
export function buildTaskDirectoryContextRecord(input: {
	readonly revision: number;
	readonly selectedWorkspaceId: string;
	readonly active: TaskDirectoryActiveItem;
	readonly workspaces: readonly { readonly workspaceId: string; readonly root: string }[];
	readonly bindings: readonly TaskDirectoryBinding[];
}): TaskDirectoryContextRecord {
	const bytes = (value: string) => Buffer.byteLength(value);
	// The envelope is measured with every row omitted: the omitted line is then at its largest, so dropping
	// counters as rows are admitted only shrinks it.
	let record: TaskDirectoryContextRecord = {
		v: COMMS_RECORD_VERSION,
		k: "task_directory",
		revision: input.revision,
		selectedWorkspaceId: input.selectedWorkspaceId,
		active: input.active,
		cwdOmitted: false,
		workspaces: [],
		bindings: [],
		omittedWorkspaces: input.workspaces.length,
		omittedBindings: input.bindings.length,
	};
	if (bytes(renderTaskDirectoryContext(record)) > MAX_TASK_DIRECTORY_CONTEXT_BYTES) {
		const { cwd: _omitted, ...active } = record.active;
		record = { ...record, active, cwdOmitted: true };
	}
	let remainingBytes = MAX_TASK_DIRECTORY_CONTEXT_BYTES - bytes(renderTaskDirectoryContext(record));
	const admit = <T>(rows: readonly T[], render: (row: T) => string): T[] => {
		const admitted: T[] = [];
		for (const row of rows) {
			const rowBytes = bytes(render(row)) + 1;
			if (rowBytes > remainingBytes) continue;
			admitted.push(row);
			remainingBytes -= rowBytes;
		}
		return admitted;
	};
	const workspaces = admit(input.workspaces, renderTaskWorkspaceLine);
	const bindings = admit(input.bindings, renderTaskBindingLine);
	return {
		...record,
		workspaces,
		bindings,
		omittedWorkspaces: input.workspaces.length - workspaces.length,
		omittedBindings: input.bindings.length - bindings.length,
	};
}

// Path-alias legend

export interface PathAliasLegendEntry {
	readonly id: string;
	readonly path: string;
}

/**
 * One legend record: the alias lines it lists. A delta record (`legendFor`) lists the aliases new to its request and carries
 * the pause state. A frame record (`PathAliasSyncResult.frameLegend`) lists every alias its frame references and carries no
 * pause state, so `paused` is absent on it (see {@link renderPathAliasLegendFrame}).
 */
export interface PathAliasLegendRecord {
	readonly v: CommsRecordVersion;
	readonly k: "path_alias_legend";
	/** Alias minting is paused because the legend costs more than the aliases save. Absent on a frame record. */
	readonly paused?: boolean;
	/**
	 * Alias minting resumed while a pause note is on the wire: this record clears that note, and lists the aliases pending on
	 * its request (none, when there are none). Absent otherwise.
	 */
	readonly resumed?: boolean;
	readonly entries: readonly PathAliasLegendEntry[];
}

export const PATH_ALIAS_LEGEND_PAUSED_LINE = "(alias minting paused: the legend costs more than the aliases save)";
export const PATH_ALIAS_LEGEND_RESUMED_LINE = "(alias minting resumed: new paths get aliases again)";

/** The line one alias contributes to a legend text. Paths stay bare: they are what the model types back. */
function renderPathAliasLegendLine(entry: PathAliasLegendEntry): string {
	return `${entry.id}=${entry.path}`;
}

/**
 * The model view of a legend delta: a header naming how many lines it adds, then one `<id>=<path>` line per
 * alias. Paths stay bare: they are what the model types back, and the alias rewrite already reads them as text.
 */
export function renderPathAliasLegend(record: PathAliasLegendRecord): string {
	// A clearing record that lists no alias is the resumed note alone: a header adding no lines would only repeat the pause's.
	if (record.resumed === true && record.entries.length === 0) return PATH_ALIAS_LEGEND_RESUMED_LINE;
	return [
		`PATH ALIASES +${record.entries.length} (adds to every earlier PATH ALIASES list; earlier lines stay valid)`,
		...(record.paused === true ? [PATH_ALIAS_LEGEND_PAUSED_LINE] : []),
		...(record.resumed === true ? [PATH_ALIAS_LEGEND_RESUMED_LINE] : []),
		...record.entries.map(renderPathAliasLegendLine),
	].join("\n");
}

const PATH_ALIAS_LEGEND_FRAME_HEADER = "PATH ALIASES (cumulative: every line stays valid, new lines are added below)";

/**
 * The model view of a carried frame legend: one fixed header line, then one `<id>=<path>` line per listed alias, in the order
 * the aliases were listed. The text is append-only, so a frame that lists more aliases starts with the text of one that listed
 * fewer, byte for byte: the header names no count, each line is the delta's line for that entry, and a new alias is one more
 * line at the end. The frame carries no pause state. A pause line at its tail would have to be removed when minting resumes, and
 * one line listed after it would have to sit where it stood, so the pause travels only in the delta record.
 */
export function renderPathAliasLegendFrame(entries: readonly PathAliasLegendEntry[]): string {
	return [PATH_ALIAS_LEGEND_FRAME_HEADER, ...entries.map(renderPathAliasLegendLine)].join("\n");
}

/** The legend record a transient record's `details.record` carries, if it is one this version reads. */
export function readPathAliasLegendRecord(record: unknown): PathAliasLegendRecord | undefined {
	if (typeof record !== "object" || record === null) return undefined;
	const candidate = record as Partial<Record<keyof PathAliasLegendRecord, unknown>>;
	if (candidate.v !== COMMS_RECORD_VERSION || candidate.k !== "path_alias_legend") return undefined;
	if (candidate.paused !== undefined && typeof candidate.paused !== "boolean") return undefined;
	if (candidate.resumed !== undefined && typeof candidate.resumed !== "boolean") return undefined;
	if (!Array.isArray(candidate.entries)) return undefined;
	const entries: PathAliasLegendEntry[] = [];
	for (const entry of candidate.entries as unknown[]) {
		if (typeof entry !== "object" || entry === null) return undefined;
		const { id, path } = entry as { id?: unknown; path?: unknown };
		if (typeof id !== "string" || typeof path !== "string") return undefined;
		entries.push({ id, path });
	}
	return {
		v: COMMS_RECORD_VERSION,
		k: "path_alias_legend",
		...(typeof candidate.paused === "boolean" ? { paused: candidate.paused } : {}),
		...(typeof candidate.resumed === "boolean" ? { resumed: candidate.resumed } : {}),
		entries,
	};
}
