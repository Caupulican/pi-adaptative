import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { type Static, Type } from "typebox";
import { createEventBus } from "../event-bus.ts";
import { createExtensionRuntime, loadExtension } from "../extensions/loader.ts";
import type { ToolDefinition } from "../extensions/types.ts";
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
	registered: {
		tools: string[];
		commands: string[];
	};
	proposedPath: string;
	draft: {
		name: string;
		code: string;
		packageJson?: string;
	};
}

export interface ExtensionifyToolDetails {
	report?: ExtensionifyReport;
}

export interface ExtensionifyToolOptions {}

export function createExtensionifyToolDefinition(
	_cwd: string,
	_options?: ExtensionifyToolOptions,
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
		async execute(
			_toolCallId,
			{ name, code, packageJson }: ExtensionifyInput,
			_signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: ExtensionifyReport;
		}> {
			const diagnostics: string[] = [];
			let smokeTestPassed = false;
			const registeredTools: string[] = [];
			const registeredCommands: string[] = [];
			const proposedPath = join(homedir(), ".pi", "agent", "extensions", name);

			// Create a temporary directory for the test extension
			let tempDir: string | null = null;
			try {
				const tempRoot = require("node:os").tmpdir();
				tempDir = mkdtempSync(join(tempRoot, `extensionify-${Date.now()}-`));

				// Write index.ts with the factory code
				const indexPath = join(tempDir, "index.ts");
				writeFileSync(indexPath, code, "utf-8");

				// Write package.json if provided
				if (packageJson) {
					const packageJsonPath = join(tempDir, "package.json");
					try {
						// Validate it's valid JSON
						JSON.parse(packageJson);
						writeFileSync(packageJsonPath, packageJson, "utf-8");
					} catch (err) {
						diagnostics.push(`Invalid package.json: ${err instanceof Error ? err.message : String(err)}`);
					}
				}

				// Create isolated runtime and event bus
				const eventBus = createEventBus();
				const runtime = createExtensionRuntime();

				// Load the extension in isolation
				const { extension, error: loadError } = await loadExtension(indexPath, tempDir, eventBus, runtime, {
					fresh: true,
				});

				if (loadError) {
					diagnostics.push(`Factory error: ${loadError}`);
					smokeTestPassed = false;
				} else if (extension) {
					smokeTestPassed = true;

					// Inspect registered tools
					for (const [toolName] of extension.tools) {
						registeredTools.push(toolName);
					}

					// Inspect registered commands
					for (const [cmdName] of extension.commands) {
						registeredCommands.push(cmdName);
					}

					if (registeredTools.length === 0 && registeredCommands.length === 0) {
						diagnostics.push("Extension loaded but registered no tools or commands");
					}
				}
			} catch (err) {
				diagnostics.push(`Test error: ${err instanceof Error ? err.message : String(err)}`);
				smokeTestPassed = false;
			} finally {
				// Always clean up the temporary directory
				if (tempDir) {
					try {
						rmSync(tempDir, { recursive: true, force: true });
					} catch (cleanupErr) {
						diagnostics.push(
							`Cleanup warning: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
						);
					}
				}
			}

			const ok = smokeTestPassed && diagnostics.length === 0;

			const report: ExtensionifyReport = {
				ok,
				smokeTestPassed,
				diagnostics,
				registered: {
					tools: registeredTools,
					commands: registeredCommands,
				},
				proposedPath,
				draft: { name, code, packageJson },
			};

			// Format the report as readable text
			const lines: string[] = [];
			lines.push(`Extensionify smoke-test: ${smokeTestPassed ? "✓ passed" : "✗ failed"}`);

			if (diagnostics.length > 0) {
				lines.push("\nDiagnostics:");
				for (const diag of diagnostics) {
					lines.push(`- ${diag}`);
				}
			} else if (smokeTestPassed) {
				lines.push("\n✓ No errors during factory execution.");
			}

			if (registeredTools.length > 0) {
				lines.push(`\nRegistered tools (${registeredTools.length}):`);
				for (const toolName of registeredTools) {
					lines.push(`- ${toolName}`);
				}
			}

			if (registeredCommands.length > 0) {
				lines.push(`\nRegistered commands (${registeredCommands.length}):`);
				for (const cmdName of registeredCommands) {
					lines.push(`- ${cmdName}`);
				}
			}

			if (registeredTools.length === 0 && registeredCommands.length === 0 && smokeTestPassed) {
				lines.push("\n⚠ Extension loaded but registered nothing.");
			}

			if (ok) {
				lines.push("\n✓ Extension ready for creation.");
			}

			lines.push(`\nProposed install path: ${proposedPath}`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: report,
			};
		},
	};
}

export function createExtensionifyTool(
	cwd: string,
	options?: ExtensionifyToolOptions,
): AgentTool<typeof extensionifySchema> {
	return wrapToolDefinition(createExtensionifyToolDefinition(cwd, options));
}
