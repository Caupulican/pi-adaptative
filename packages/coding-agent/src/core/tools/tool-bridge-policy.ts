/**
 * What a `python` script may call through its `pi_tools` bridge, and the bounds of one bridged run.
 *
 * The set is the read-only file and repository family plus the typed file mutations. Every call is admitted as a
 * standalone call of that tool would be (see tool-bridge.ts), so the set says what is reachable, never what is
 * allowed: a tool the session withholds, or a call its gates refuse, is refused inside the script too.
 *
 * `bash` is not in the set: the script already computes in Python, and a shell command from a script would run
 * outside the model-level shell contract (its persistent session, command guards and the announced shell group).
 * Control-plane tools (`delegate`, `goal`, `ask_question`, ...) and the batch carriers (`lookup`, `python`) are not
 * in it either: a script is one bounded unit of work, not an orchestrator.
 */

export const TOOL_BRIDGE_READ_TOOL_NAMES = ["read", "grep", "find", "ls", "repo_read"] as const;
export const TOOL_BRIDGE_MUTATION_TOOL_NAMES = ["edit", "write"] as const;
export const TOOL_BRIDGE_TOOL_NAMES = [...TOOL_BRIDGE_READ_TOOL_NAMES, ...TOOL_BRIDGE_MUTATION_TOOL_NAMES] as const;
export type ToolBridgeToolName = (typeof TOOL_BRIDGE_TOOL_NAMES)[number];

const TOOL_BRIDGE_NAME_SET: ReadonlySet<string> = new Set(TOOL_BRIDGE_TOOL_NAMES);
const TOOL_BRIDGE_MUTATION_NAME_SET: ReadonlySet<string> = new Set(TOOL_BRIDGE_MUTATION_TOOL_NAMES);

export function isToolBridgeToolName(name: string): name is ToolBridgeToolName {
	return TOOL_BRIDGE_NAME_SET.has(name);
}

/** A bridged call that changes files: it is admitted only where the tool is active for the model itself. */
export function isToolBridgeMutation(name: string): boolean {
	return TOOL_BRIDGE_MUTATION_NAME_SET.has(name);
}

/** The module a bridged script imports. */
export const TOOL_BRIDGE_CLIENT_MODULE = "pi_tools";
/**
 * Environment of a bridged run: the channel address, and the path of the file holding the run's secret. The secret
 * itself is never in the environment, where every child process of the script would inherit it.
 */
export const TOOL_BRIDGE_ADDRESS_ENV = "PI_TOOL_BRIDGE";
export const TOOL_BRIDGE_TOKEN_FILE_ENV = "PI_TOOL_BRIDGE_TOKEN_FILE";

export const DEFAULT_TOOL_BRIDGE_MAX_CALLS = 50;
export const MAX_TOOL_BRIDGE_CALLS = 200;
/** Admission is one call at a time; at most this many admitted bodies run at once. */
export const MAX_TOOL_BRIDGE_CONCURRENT_CALLS = 4;
/** Connections a run accepts at once (a threaded script may open more than one). */
export const MAX_TOOL_BRIDGE_CONNECTIONS = 4;
/** One request frame from the script (a `write` carries its content). */
export const MAX_TOOL_BRIDGE_REQUEST_BYTES = 4 * 1024 * 1024;
/** One tool's text handed back to the script; the model sees only what the script prints. */
export const MAX_TOOL_BRIDGE_RESULT_BYTES = 1024 * 1024;
/** A bridged call that has not settled by then is cancelled. */
export const TOOL_BRIDGE_CALL_TIMEOUT_MS = 120_000;
/** A connection that has not proven the run's secret by then is closed. */
export const TOOL_BRIDGE_HELLO_TIMEOUT_MS = 10_000;
/** Calls listed one per line in the result; the rest are counted. */
export const MAX_TOOL_BRIDGE_TRACE_LINES = 24;
/** A refusal or failure reason shown in the trace is cut to this many characters. */
export const MAX_TOOL_BRIDGE_TRACE_REASON_CHARS = 160;
