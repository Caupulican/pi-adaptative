import { type Static, Type } from "typebox";
import type { ArtifactStore } from "../context/context-artifacts.ts";
import { formatArtifactNotice, packToolOutput } from "../context/tool-output-packer.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { acceptReflexPlan, type ReflexPlan } from "../toolkit/reflex-interpreter.ts";
import { matchToolkitScript, type ToolkitScript } from "../toolkit/script-registry.ts";
import type { ScriptExecution } from "../toolkit/script-runner.ts";

const runToolkitScriptSchema = Type.Object(
	{
		script: Type.String({
			description:
				"The toolkit script to run: its registered name, a taught alias, or a natural request (e.g. 'restore-db' or 'restore the database'). Ambiguous requests return a shortlist instead of executing.",
		}),
		args: Type.Optional(Type.Array(Type.String(), { description: "Arguments passed to the script as-is." })),
		confirm: Type.Optional(
			Type.Boolean({
				description: "Required true to run a script flagged danger: scripts marked dangerous never run without it.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type RunToolkitScriptInput = Static<typeof runToolkitScriptSchema>;

export interface RunToolkitScriptDetails {
	outcome: "executed" | "failed" | "ambiguous" | "not_found" | "confirmation_required" | "empty_registry";
	scriptName?: string;
	exitCode?: number | null;
	durationMs?: number;
	shortlist?: string[];
	artifactId?: string;
}

export interface RunToolkitScriptDependencies {
	getScripts: () => ToolkitScript[];
	execute: (script: ToolkitScript, args: readonly string[]) => Promise<ScriptExecution>;
	artifactStore?: ArtifactStore;
	/**
	 * Optional reflex interpreter (local brain): consulted ONLY when the deterministic Level-0
	 * matcher is ambiguous, to resolve fuzzy phrasing ("prepare db" vs "update db") into a
	 * registry pick. Its plan is advisory — the danger/confirm rules and structural execution
	 * contract apply identically to brain-selected scripts.
	 */
	interpret?: (request: string, scripts: readonly ToolkitScript[]) => Promise<ReflexPlan | undefined>;
}

export function createRunToolkitScriptToolDefinition(deps: RunToolkitScriptDependencies): ToolDefinition {
	return {
		name: "run_toolkit_script",
		label: "run_toolkit_script",
		description:
			"Run one of the user's registered toolkit scripts (daily-ops allowlist). Finding is a registry lookup — ambiguous requests return a shortlist to disambiguate, never a guess. The harness executes (uv/powershell/bash) and ALWAYS returns exit code, stdout, and stderr; failures are reported as errors — a failed script can never look like success.",
		promptSnippet: "Run a registered toolkit script by name/alias; output and errors come back structurally.",
		promptGuidelines: [
			"Prefer the exact registered name; on a shortlist response, ask the user which one (or pick only when their request clearly names it).",
			"Scripts flagged dangerous require confirm: true — obtain explicit user confirmation first.",
			"Report the script's real output/exit code; never claim success when exitCode is non-zero.",
		],
		parameters: runToolkitScriptSchema,
		async execute(
			toolCallId,
			input: RunToolkitScriptInput,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: RunToolkitScriptDetails;
			isError?: boolean;
		}> {
			const scripts = deps.getScripts();
			if (scripts.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "run_toolkit_script: no scripts registered (settings.toolkit.scripts).",
						},
					],
					details: { outcome: "empty_registry" },
				};
			}

			const match = matchToolkitScript(input.script, scripts);
			if (match.kind === "none") {
				const closest = match.closest.map((script) => `${script.name} — ${script.description}`).join("\n");
				return {
					content: [
						{
							type: "text" as const,
							text: `script_not_found: nothing registered matches "${input.script}".${closest ? `\nClosest:\n${closest}` : ""}`,
						},
					],
					details: { outcome: "not_found" },
					isError: true,
				};
			}
			let interpreted: { script: ToolkitScript; args: string[]; confidence: number } | undefined;
			if (match.kind === "ambiguous" && deps.interpret) {
				try {
					const plan = await deps.interpret(input.script, scripts);
					const accepted = acceptReflexPlan(plan, scripts);
					if (accepted && plan) {
						interpreted = { ...accepted, confidence: plan.confidence };
					}
				} catch {
					// interpreter is best-effort; ambiguity handling below stays authoritative
				}
			}
			if (match.kind === "ambiguous" && !interpreted) {
				const shortlist = match.shortlist.map((script) => `${script.name} — ${script.description}`);
				return {
					content: [
						{
							type: "text" as const,
							text: `Ambiguous request — did you mean:\n${shortlist.join("\n")}\nCall again with the exact name.`,
						},
					],
					details: { outcome: "ambiguous", shortlist: match.shortlist.map((script) => script.name) },
				};
			}

			const script = interpreted?.script ?? (match as { script: ToolkitScript }).script;
			if (script.danger && input.confirm !== true) {
				return {
					content: [
						{
							type: "text" as const,
							text: `"${script.name}" is flagged DANGEROUS (${script.description}). It was NOT run. Confirm with the user, then call again with confirm: true.`,
						},
					],
					details: { outcome: "confirmation_required", scriptName: script.name },
				};
			}

			// Explicit args from the caller win; a brain-extracted arg list fills in for fuzzy requests.
			const execution = await deps.execute(script, input.args ?? interpreted?.args ?? []);
			const failed = execution.exitCode !== 0 || execution.timedOut;
			const header = failed
				? `FAILED: ${script.name} exited ${execution.timedOut ? "by timeout" : execution.exitCode} after ${execution.durationMs}ms`
				: `${script.name} succeeded in ${execution.durationMs}ms`;
			const rawBody = [
				header,
				execution.stdout.trim() ? `stdout:\n${execution.stdout.trim()}` : "stdout: (empty)",
				execution.stderr.trim() ? `stderr:\n${execution.stderr.trim()}` : "",
			]
				.filter(Boolean)
				.join("\n");
			const packed = packToolOutput(
				{
					toolName: "run_toolkit_script",
					command: script.name,
					path: script.path,
					rawContent: rawBody,
					reproducible: false,
					truncation: { maxLines: 400, maxBytes: 8 * 1024 },
				},
				deps.artifactStore,
				toolCallId,
			);
			const body = packed.artifactId
				? `${packed.content}\n\n[${formatArtifactNotice(packed.artifactId)}]`
				: packed.content;

			return {
				content: [{ type: "text" as const, text: body }],
				details: {
					...(interpreted
						? { interpreter: { script: interpreted.script.name, confidence: interpreted.confidence } }
						: {}),
					outcome: failed ? "failed" : "executed",
					scriptName: script.name,
					exitCode: execution.exitCode,
					durationMs: execution.durationMs,
					...(packed.artifactId ? { artifactId: packed.artifactId } : {}),
				},
				...(failed ? { isError: true } : {}),
			};
		},
	};
}
