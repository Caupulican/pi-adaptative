/**
 * Default built-in tool request shared by every AgentSession construction path.
 *
 * RuntimeBuilder still registers additional opt-in tools, while model capability and UAC profile
 * filters may only narrow this request. Keeping the SDK and direct-runtime paths on one list avoids
 * silently losing goal/delegation/toolkit capabilities in SDK-created interactive sessions.
 */
export const DEFAULT_ACTIVE_TOOL_NAMES: readonly string[] = [
	"read",
	"bash",
	"edit",
	"write",
	"context_audit",
	"goal",
	"delegate",
	"run_toolkit_script",
];
