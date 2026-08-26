import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { MAX_ACTIVE_SKILL_BODY_BYTES } from "../skill-vault.ts";
import { MAX_SKILL_DESCRIPTION_LENGTH, MAX_SKILL_NAME_LENGTH, type Skill, validateSkillName } from "../skills.ts";
import { runSkillAudit, type SkillAuditReport } from "./skill-audit.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const skillifySchema = Type.Object({
	name: Type.String({
		description: `Skill name (lowercase, a-z 0-9 hyphens only, max ${MAX_SKILL_NAME_LENGTH} chars)`,
	}),
	description: Type.String({ description: `Skill description (max ${MAX_SKILL_DESCRIPTION_LENGTH} chars)` }),
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

export interface SkillifyToolOptions {
	/** Host-admitted skill universe; omitting it retains standalone backwards compatibility. */
	getSkills?: () => readonly Skill[];
}

export function createSkillifyToolDefinition(
	cwd: string,
	options?: SkillifyToolOptions,
): ToolDefinition<typeof skillifySchema, SkillifyReport> {
	return {
		name: "skillify",
		label: "Skillify",
		description:
			"Validate a draft skill and audit for overlaps with existing skills. Pure analysis tool: generates a proposal with validation and audit report, but does NOT write files or activate the skill. Returns structured report with proposed install path.",
		promptSnippet: "Validate and audit a draft skill",
		promptGuidelines: [
			"Use skillify to validate and audit draft skills before creating them.",
			"When MEMORY.md holds a repeatable procedure, draft a skill from that procedure instead of leaving it as a fact.",
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
			} else if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
				errors.push(`description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters (${description.length})`);
			}

			const bodyBytes = Buffer.byteLength(body, "utf8");
			if (bodyBytes > MAX_ACTIVE_SKILL_BODY_BYTES) {
				errors.push(`body exceeds ${MAX_ACTIVE_SKILL_BODY_BYTES} bytes (${bodyBytes})`);
			}

			// Do not tokenize an oversized draft; retain the existing-skill report for the proposal.
			const admittedSkills = options?.getSkills?.();
			const audit =
				bodyBytes > MAX_ACTIVE_SKILL_BODY_BYTES
					? runSkillAudit(cwd, undefined, admittedSkills)
					: runSkillAudit(cwd, { name, description, body }, admittedSkills);

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
