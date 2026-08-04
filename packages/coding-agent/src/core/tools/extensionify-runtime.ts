import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { type Static, Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import { acquireWorkRun, type WorkRunLease } from "../../utils/work-directory.ts";
import type { Extension, ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const extensionifySchema = Type.Object({
	name: Type.String({ description: "Extension name (lowercase, a-z 0-9 hyphens only)" }),
	code: Type.String({ description: "Extension factory code (TypeScript/JavaScript)" }),
	packageJson: Type.Optional(Type.String({ description: "Optional package.json content as JSON string" })),
});

export type ExtensionifyInput = Static<typeof extensionifySchema>;

export interface ExtensionifyReport {
	ok: boolean;
	smokeTestPassed: boolean;
	diagnostics: string[];
	registered: { tools: string[]; commands: string[] };
	proposedPath: string;
	draft: { name: string; code: string; packageJson?: string };
}

export interface ExtensionifyToolDetails {
	report?: ExtensionifyReport;
}

export interface ExtensionifyLoadRequest {
	extensionPath: string;
	cwd: string;
	agentDir: string;
}

export type ExtensionifyExtensionLoader = (
	request: ExtensionifyLoadRequest,
) => Promise<{ extension: Pick<Extension, "tools" | "commands"> | null; error: string | null }>;

export interface ExtensionifyRuntimeOptions {
	agentDir?: string;
	loadExtension: ExtensionifyExtensionLoader;
}

export function createExtensionifyToolDefinitionWithRuntime(
	_cwd: string,
	options: ExtensionifyRuntimeOptions,
): ToolDefinition<typeof extensionifySchema, ExtensionifyReport> {
	return {
		name: "extensionify",
		label: "extensionify",
		description:
			"Smoke-test a draft extension in an isolated throwaway runtime. Pure analysis tool: creates temporary scaffold, loads it, inspects registrations, then completely deletes temp dir. Does NOT write to the real extensions dir or modify the live runtime. Returns proposal with registration details.",
		promptSnippet: "Smoke-test a draft extension",
		promptGuidelines: [
			"Use extensionify to validate draft extensions before creating them.",
			"Fix any factory errors or registration issues; review tools and commands registered.",
			"The tool runs in complete isolation; the live session is never touched.",
			"Persistent write and activation happen later via a separate step.",
		],
		parameters: extensionifySchema,
		async execute(_toolCallId, { name, code, packageJson }) {
			const diagnostics: string[] = [];
			let smokeTestPassed = false;
			const registeredTools: string[] = [];
			const registeredCommands: string[] = [];
			const agentDir = options.agentDir ?? getAgentDir();
			const proposedPath = join(agentDir, "extensions", name);

			let tempDir: string | null = null;
			let workRun: WorkRunLease | undefined;
			try {
				workRun = acquireWorkRun({ agentDir, category: "extensions", tenant: "smoke-test" });
				tempDir = workRun.path;
				const indexPath = join(tempDir, "index.ts");
				writeFileSync(indexPath, code, "utf-8");

				if (packageJson) {
					const packageJsonPath = join(tempDir, "package.json");
					try {
						JSON.parse(packageJson);
						writeFileSync(packageJsonPath, packageJson, "utf-8");
					} catch (error) {
						diagnostics.push(`Invalid package.json: ${error instanceof Error ? error.message : String(error)}`);
					}
				}

				const { extension, error } = await options.loadExtension({
					extensionPath: indexPath,
					cwd: tempDir,
					agentDir,
				});
				if (error) {
					diagnostics.push(`Factory error: ${error}`);
				} else if (extension) {
					smokeTestPassed = true;
					registeredTools.push(...extension.tools.keys());
					registeredCommands.push(...extension.commands.keys());
					if (registeredTools.length === 0 && registeredCommands.length === 0) {
						diagnostics.push("Extension loaded but registered no tools or commands");
					}
				}
			} catch (error) {
				diagnostics.push(`Test error: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				workRun?.release();
				if (tempDir) {
					try {
						rmSync(tempDir, { recursive: true, force: true });
					} catch (error) {
						diagnostics.push(`Cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
			}

			const ok = smokeTestPassed && diagnostics.length === 0;
			const report: ExtensionifyReport = {
				ok,
				smokeTestPassed,
				diagnostics,
				registered: { tools: registeredTools, commands: registeredCommands },
				proposedPath,
				draft: { name, code, packageJson },
			};
			const lines = [`Extensionify smoke-test: ${smokeTestPassed ? "✓ passed" : "✗ failed"}`];
			if (diagnostics.length > 0) {
				lines.push("\nDiagnostics:", ...diagnostics.map((diagnostic) => `- ${diagnostic}`));
			} else if (smokeTestPassed) {
				lines.push("\n✓ No errors during factory execution.");
			}
			if (registeredTools.length > 0) {
				lines.push(
					`\nRegistered tools (${registeredTools.length}):`,
					...registeredTools.map((tool) => `- ${tool}`),
				);
			}
			if (registeredCommands.length > 0) {
				lines.push(
					`\nRegistered commands (${registeredCommands.length}):`,
					...registeredCommands.map((command) => `- ${command}`),
				);
			}
			if (registeredTools.length === 0 && registeredCommands.length === 0 && smokeTestPassed) {
				lines.push("\n⚠ Extension loaded but registered nothing.");
			}
			if (ok) lines.push("\n✓ Extension ready for creation.");
			lines.push(`\nProposed install path: ${proposedPath}`);
			return { content: [{ type: "text", text: lines.join("\n") }], details: report };
		},
	};
}

export function createExtensionifyToolWithRuntime(
	cwd: string,
	options: ExtensionifyRuntimeOptions,
): AgentTool<typeof extensionifySchema> {
	return wrapToolDefinition(createExtensionifyToolDefinitionWithRuntime(cwd, options));
}
