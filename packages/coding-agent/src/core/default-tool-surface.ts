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
export function getDefaultActiveToolNames(_platform: NodeJS.Platform = process.platform): readonly string[] {
	return [
		"read",
		"bash",
		"python",
		"edit",
		"write",
		"context_audit",
		"goal",
		"task_steps",
		"delegate",
		"run_toolkit_script",
	];
}

/** Current-process default tool request. */
export const DEFAULT_ACTIVE_TOOL_NAMES: readonly string[] = getDefaultActiveToolNames();

/** Map legacy/platform-specific shell names to the stable Bash-like agent contract. */
export function mapToolNamesForPlatform(
	names: readonly string[],
	_platform: NodeJS.Platform = process.platform,
): string[] {
	const mapped: string[] = [];
	for (const name of names) {
		const resolved = name === "powershell" ? "bash" : name;
		if (!mapped.includes(resolved)) mapped.push(resolved);
	}
	return mapped;
}
