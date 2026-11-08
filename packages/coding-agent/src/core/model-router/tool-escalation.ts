import type { Api, Model } from "@caupulican/pi-ai";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { ModelTier } from "../autonomy/contracts.ts";
import { HF_TRANSFORMERS_PROVIDER, OLLAMA_PROVIDER } from "../models/local-registration.ts";
import { isLocalExecutionModel } from "../models/model-endpoint.ts";
import { isPiManagedPrismLlamaCppModel } from "../models/prism-llamacpp-lifecycle.ts";
import { LOOKUP_TOOL_NAME } from "../tools/lookup-tool-name.ts";
import type { ShellCommandDialect } from "../tools/shell-command-parser.ts";
import { isEffectfulReadOnlyProgram, readOnlyShellPrograms } from "./read-only-shell-policy.ts";

/**
 * True for a model the capability-gate spine treats as LOCAL/MANAGED — never cloud.
 * Shared by agent-session.ts's validation-escalation branch and model-router-controller.ts's
 * tier-resolution verdict consultation so there is exactly one place composing this
 * predicate, instead of two divergent copies. Reuses {@link isLocalExecutionModel} (any
 * ollama/transformers/llama-cpp provider, or a localhost-family baseUrl) OR'd with the same
 * provider/managed-prism check `LocalRuntimeController.isManagedLocalModel` uses internally — built
 * from the identical exported provider constants ({@link OLLAMA_PROVIDER}, {@link
 * HF_TRANSFORMERS_PROVIDER}) and {@link isPiManagedPrismLlamaCppModel}, so there is no second,
 * drifting definition of "is this ollama/transformers/pi-managed-prism" (that method itself is
 * private to LocalRuntimeController, which this module does not own/import). A cloud model (a
 * known-capable provider on a non-local baseUrl) always returns false.
 */
export function isLocalOrManagedRouterModel(model: Model<Api>): boolean {
	return (
		isLocalExecutionModel(model) ||
		model.provider === OLLAMA_PROVIDER ||
		model.provider === HF_TRANSFORMERS_PROVIDER ||
		isPiManagedPrismLlamaCppModel(model)
	);
}

const READ_ONLY_TOOL_NAMES = new Set([
	"read",
	LOOKUP_TOOL_NAME,
	"grep",
	"find",
	"ls",
	"list",
	"search",
	"glob",
	"view_file",
	"list_dir",
	"grep_search",
	"search_web",
	"read_url_content",
	"read_browser_page",
]);

const SHELL_TOOL_NAMES = new Set(["bash", "powershell", "exec", "execute", "run", "run_command", "shell"]);
const MUTATING_TOOL_NAME_RE =
	/(bash|powershell|exec|execute|run|shell|write|edit|patch|replace|delete|remove|move|rename|create|mkdir|touch|install|commit|push|publish|deploy|apply)/i;

function getShellCommand(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const record = args as Record<string, unknown>;
	const command = record.command ?? record.cmd ?? record.shellCommand;
	return typeof command === "string" ? command.trim() : undefined;
}

/** The dialect a shell tool's command is written in: the PowerShell tool runs PowerShell, every other shell tool is POSIX-like. */
function shellToolDialect(toolName: string): ShellCommandDialect {
	return toolName === "powershell" ? "powershell" : "posix";
}

/**
 * True only when the tool contract or parsed invocation proves that the call observes state without
 * changing it. Unknown and executable commands remain available to the caller's semantic gate.
 */
export function isProvablyObservationalToolCall(toolName: string, args?: unknown, declaredReadOnly?: boolean): boolean {
	if (declaredReadOnly === true) return true;
	const name = toolName.trim().toLowerCase();
	if (!name) return false;
	if (READ_ONLY_TOOL_NAMES.has(name)) return true;
	if (!SHELL_TOOL_NAMES.has(name)) return false;
	const command = getShellCommand(args);
	if (command === undefined) return false;
	// Interpreters, clients and nested shells can execute code, invoke other programs, contact remote systems, or
	// write tool-managed state; their effects remain available to semantic recovery judgment.
	const programs = readOnlyShellPrograms(command, shellToolDialect(name));
	return programs !== undefined && !programs.some(isEffectfulReadOnlyProgram);
}

export function shouldEscalateModelRouterTool(options: {
	tier: ModelTier;
	toolName: string;
	args?: unknown;
	/** The tool's own `readOnly` declaration, when it made one. */
	readOnly?: boolean;
}): boolean {
	if (options.tier !== "cheap") return false;
	const escalate = isMutatingToolCall(options.toolName, options.args, options.readOnly);
	if (escalate) {
		harnessLog.debug("router", "a cheap-tier tool call escalates to a stronger model", () => ({
			tool: options.toolName,
		}));
	}
	return escalate;
}

/**
 * Whether a tool call may change the world (files, processes, remote state): anything but a tool that
 * declares itself read-only, the known read-only tools and read-only shell commands. The one read/write line the router escalation and the
 * work boundary both draw.
 */
export function isMutatingToolCall(toolName: string, args?: unknown, declaredReadOnly?: boolean): boolean {
	// A tool's own declaration outranks its name; the name rules below judge tools that declared nothing.
	if (declaredReadOnly === true) return false;
	const name = toolName.trim().toLowerCase();
	if (!name) return true;
	if (READ_ONLY_TOOL_NAMES.has(name)) return false;
	if (SHELL_TOOL_NAMES.has(name)) {
		const command = getShellCommand(args);
		return command ? readOnlyShellPrograms(command, shellToolDialect(name)) === undefined : true;
	}
	return MUTATING_TOOL_NAME_RE.test(name) || !name.startsWith("read_");
}
