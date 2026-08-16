/**
 * Default built-in tool request shared by every AgentSession construction path.
 *
 * RuntimeBuilder still registers additional opt-in tools, while model capability and UAC profile
 * filters may only narrow this request. Keeping the SDK and direct-runtime paths on one list avoids
 * silently losing goal/delegation/toolkit capabilities in SDK-created interactive sessions.
 *
 * `bash` is the stable agent shell contract on every platform; its finite grammar routes to
 * PowerShell on Windows. `python` is a separate bounded, uv-managed execution contract.
 */
import { GOAL_LIFECYCLE_TOOL_NAMES, LEGACY_GOAL_TOOL_NAME } from "./goals/goal-tool-names.ts";

export const STABLE_SHELL_TOOL_NAME = "bash" as const;

export function getDefaultActiveToolNames(_platform: NodeJS.Platform = process.platform): readonly string[] {
	return [
		"read",
		"skill",
		"skillify",
		"skill_audit",
		STABLE_SHELL_TOOL_NAME,
		"python",
		"edit",
		"write",
		LEGACY_GOAL_TOOL_NAME,
		...GOAL_LIFECYCLE_TOOL_NAMES,
		"task_steps",
		"pipeline",
		"ask_question",
		"secret_store",
		"memory",
		"delegate",
		"tool_task",
		"run_toolkit_script",
		"improvement_loop",
	];
}

/** Current-process default tool request. */
export const DEFAULT_ACTIVE_TOOL_NAMES: readonly string[] = getDefaultActiveToolNames();

/** Map legacy/platform-specific shell and tool alias names to stable agent contracts. */
export function mapToolNamesForPlatform(
	names: readonly string[],
	_platform: NodeJS.Platform = process.platform,
): string[] {
	const mapped: string[] = [];
	for (const name of names) {
		let resolved = name;
		const lower = name.toLowerCase().trim();
		if (lower === "powershell") {
			resolved = STABLE_SHELL_TOOL_NAME;
		} else if (["python_tool", "python3", "python_interpreter", "py"].includes(lower)) {
			resolved = "python";
		} else if (["bash_tool", "shell", "sh", "terminal", "cmd"].includes(lower)) {
			resolved = STABLE_SHELL_TOOL_NAME;
		}
		if (!mapped.includes(resolved)) mapped.push(resolved);
	}
	return mapped;
}
