import { type ArtifactRetrieveToolOptions, createArtifactRetrieveToolDefinition } from "./artifact-retrieve.ts";
import { type BashToolOptions, createBashToolDefinition } from "./bash.ts";
import { createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import {
	createExtensionifyToolDefinitionWithRuntime,
	type ExtensionifyRuntimeOptions,
} from "./extensionify-runtime.ts";
import { createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createPythonToolDefinition, type PythonToolOptions } from "./python.ts";
import { createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createSkillAuditToolDefinition, type SkillAuditToolOptions } from "./skill-audit.ts";
import { createSkillifyToolDefinition, type SkillifyToolOptions } from "./skillify.ts";
import { createWebFetchToolDefinition, type WebFetchOptions } from "./webfetch.ts";
import { createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

// ToolDefinition callbacks are contravariant in their schema-derived parameter type. A registry
// intentionally stores heterogeneous schemas, so this boundary must erase those two type axes.
export type ToolDef = ToolDefinition<any, any>;
export type ToolName =
	| "read"
	| "bash"
	| "python"
	| "edit"
	| "write"
	| "grep"
	| "find"
	| "ls"
	| "skill_audit"
	| "skillify"
	| "extensionify"
	| "artifact_retrieve"
	| "webfetch";

export const allToolNames: ReadonlySet<ToolName> = new Set([
	"read",
	"bash",
	"python",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"skill_audit",
	"skillify",
	"extensionify",
	"artifact_retrieve",
	"webfetch",
]);

export interface ToolDefinitionOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	python?: PythonToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	skill_audit?: SkillAuditToolOptions;
	skillify?: SkillifyToolOptions;
	extensionify: ExtensionifyRuntimeOptions;
	artifact_retrieve?: ArtifactRetrieveToolOptions;
	webfetch?: WebFetchOptions;
}

export function createToolDefinitionWithRuntime(
	toolName: ToolName,
	cwd: string,
	options: ToolDefinitionOptions,
): ToolDef {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, options.read);
		case "bash":
			return createBashToolDefinition(cwd, options.bash);
		case "python":
			return createPythonToolDefinition(cwd, options.python);
		case "edit":
			return createEditToolDefinition(cwd, options.edit);
		case "write":
			return createWriteToolDefinition(cwd, options.write);
		case "grep":
			return createGrepToolDefinition(cwd, options.grep);
		case "find":
			return createFindToolDefinition(cwd, options.find);
		case "ls":
			return createLsToolDefinition(cwd, options.ls);
		case "skill_audit":
			return createSkillAuditToolDefinition(cwd, options.skill_audit);
		case "skillify":
			return createSkillifyToolDefinition(cwd, options.skillify);
		case "extensionify":
			return createExtensionifyToolDefinitionWithRuntime(cwd, options.extensionify);
		case "artifact_retrieve":
			return createArtifactRetrieveToolDefinition(cwd, options.artifact_retrieve);
		case "webfetch":
			return createWebFetchToolDefinition(cwd, options.webfetch);
	}
}

import type { ToolDefinition } from "../extensions/types.ts";
