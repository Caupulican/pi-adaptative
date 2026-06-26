import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { validateSkillName } from "../skills.ts";
import { runSkillAudit, type SkillAuditReport } from "./skill-audit.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const skillifySchema = Type.Object({
	name: Type.String({ description: "Skill name (lowercase, a-z 0-9 hyphens only, max 64 chars)" }),
	description: Type.String({ description: "Skill description (max 1024 chars)" }),
	body: Type.String({ description: "Skill body/implementation code" }),
});

export type SkillifyInput = Static<typeof skillifySchema>;

export interface SkillifyReport {
	valid: boolean;
	errors: string[];
	audit: SkillAuditReport;
	proposedPath: string;
	draft: {
		name: string;
		description: string;
		body: string;
	};
}

export interface SkillifyToolDetails {
	report?: SkillifyReport;
}

export interface SkillifyToolOptions {}

export function createSkillifyToolDefinition(
	cwd: string,
	_options?: SkillifyToolOptions,
): ToolDefinition<typeof skillifySchema, SkillifyReport> {
	return {
		name: "skillify",
		label: "skillify",
		description:
			"Validate a draft skill and audit for overlaps with existing skills. Pure analysis tool: generates a proposal with validation and audit report, but does NOT write files or activate the skill. Returns structured report with proposed install path.",
		promptSnippet: "Validate and audit a draft skill",
		promptGuidelines: [
			"Use skillify to validate and audit draft skills before creating them.",
			"Fix validation errors (name format, description length) and review audit findings before proceeding.",
			"The tool returns a proposal only; persistent write and activation happen later.",
		],
		parameters: skillifySchema,
		async execute(
			_toolCallId,
			{ name, description, body }: SkillifyInput,
			_signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: SkillifyReport;
		}> {
			const errors: string[] = [];

			// Validate name
			const nameErrors = validateSkillName(name);
			errors.push(...nameErrors);

			// Validate description
			if (!description || description.trim() === "") {
				errors.push("description is required");
			} else if (description.length > 1024) {
				errors.push(`description exceeds 1024 characters (${description.length})`);
			}

			// Run audit on the draft
			const audit = runSkillAudit(cwd, { name, description, body });

			const valid = errors.length === 0;
			const proposedPath = join(homedir(), ".pi", "agent", "skills", name, "SKILL.md");

			const report: SkillifyReport = {
				valid,
				errors,
				audit,
				proposedPath,
				draft: { name, description, body },
			};

			// Format the report as readable text
			const lines: string[] = [];
			lines.push(`Skillify validation: ${valid ? "✓ valid" : "✗ invalid"}`);

			if (errors.length > 0) {
				lines.push("\nValidation errors:");
				for (const err of errors) {
					lines.push(`- ${err}`);
				}
			}

			lines.push(
				`\nAudit: ${audit.skills.length} existing skill(s), ${audit.nearDuplicates.length} overlap warning(s).`,
			);

			if (audit.nearDuplicates.length > 0) {
				lines.push("\nTop overlaps with existing skills:");
				for (const item of audit.nearDuplicates.slice(0, 5)) {
					const otherPath = item.a === "[draft]" ? item.b : item.a;
					const otherName = otherPath.split("/").pop() || otherPath;
					lines.push(`- ${(item.similarity * 100).toFixed(1)}%: ${otherName} — ${item.reason}`);
				}
			}

			if (audit.nameCollisions.length > 0) {
				lines.push("\nName collisions:");
				for (const item of audit.nameCollisions) {
					lines.push(`- ${item.name}: ${item.paths.length} existing path(s)`);
				}
			}

			if (audit.recommendations && audit.recommendations.length > 0) {
				lines.push("\nRecommendations:");
				for (const rec of audit.recommendations) {
					lines.push(`- ${rec}`);
				}
			}

			if (valid && audit.nearDuplicates.length === 0 && audit.nameCollisions.length === 0) {
				lines.push("\n✓ Skill appears ready for creation.");
			}

			lines.push(`\nProposed install path: ${proposedPath}`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: report,
			};
		},
	};
}

export function createSkillifyTool(cwd: string, options?: SkillifyToolOptions): AgentTool<typeof skillifySchema> {
	return wrapToolDefinition(createSkillifyToolDefinition(cwd, options));
}
