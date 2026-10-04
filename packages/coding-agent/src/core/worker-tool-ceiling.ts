/**
 * The tool ceiling of a worker session. Kept apart from session identity (`session-role.ts`), which
 * every launch path reads and which must not load tool modules to answer who this process is.
 */

import { TOOL_SCHEMA_SEARCH_NAME } from "@caupulican/pi-ai";
import { SELF_COMPACT_TOOL_NAME } from "./compaction/self-compaction.ts";
import { ROOT_MEMORY_TOOL_NAME, WORKER_MEMORY_READ_TOOL_NAME } from "./memory/worker-memory-tools.ts";
import { SYSTEM_ONE_TOOL_NAME } from "./system-one/tool-names.ts";
import { hasCataloguedToolCapabilityPolicy } from "./tool-capability-policy.ts";
import { DECISION_LEDGER_READ_TOOL_NAME } from "./tools/decision-ledger-read.ts";

/**
 * Tools forbidden on EVERY worker surface (in-process leaf lanes and worker processes): agent
 * launchers plus root-owned reflection, memory, and machine credential state. `bash` and `python`
 * remain available as explicit host-trust boundaries; the structural path envelope does not confine
 * arbitrary process code, and banning one execution route while retaining the other would not create
 * a meaningful filesystem boundary. This is a deny floor that wins over every grant; what a worker
 * PROCESS may hold is the positive {@link WORKER_PROCESS_ALLOWED_TOOLS} list below, so a tool added to
 * the catalogue later is never inherited by a worker until it is named there.
 */
export const WORKER_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
	"goal",
	"secret_store",
	ROOT_MEMORY_TOOL_NAME,
	"delegate",
	"improvement_loop",
	"model_fitness",
	"pi_collaboration",
	"list_peers",
	"agent_send",
	"context_scout",
	"peer",
	"runtime_update",
	"image_generate",
	"task_automation",
	// The decision ledger is the root's and System One's review surface; workers never read it.
	DECISION_LEDGER_READ_TOOL_NAME,
	SELF_COMPACT_TOOL_NAME,
]);

/**
 * Tools the in-process adapter registry never brokers into a leaf lane (it has no safe factory for
 * them there), together with {@link WORKER_FORBIDDEN_TOOLS} the full adapter denial. A worker PROCESS
 * is governed separately and more tightly by {@link WORKER_PROCESS_ALLOWED_TOOLS}: of this set only
 * `worktree_sync` (strictly lane-scoped) is on that list; the task, goal-lifecycle, pipeline,
 * ask-question, tool-task, skill-authoring and extension-authoring tools are on neither surface.
 */
export const WORKER_LEAF_LANE_ONLY_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
	WORKER_MEMORY_READ_TOOL_NAME,
	"get_goal",
	"update_goal",
	"task_steps",
	"pipeline",
	"tool_task",
	"ask_question",
	"settings",
	"session",
	"credential",
	"skillify",
	"extensionify",
	"worktree_sync",
]);

/**
 * The complete tool surface of a worker PROCESS (a managed tmux/herdr/resumed `pi` child or any
 * lane-bound session): an explicit allow-list, never a deny-list over the catalogue. File tools run
 * inside the structural path envelope; `bash`/`python`/`run_process` are the host-trust process
 * boundary under the execution grant; `worktree_sync` is narrowed to the session's own lane at the
 * tool layer. Everything else (goal and task lifecycle, `pipeline`, `tool_task`, `ask_question`,
 * `skillify`, `extensionify`, `run_toolkit_script`, extension tools) is never instantiated. The
 * bounded `memory_read` broker is an in-process leaf-lane tool with no factory in a worker process,
 * so it is not named here.
 */
export const WORKER_PROCESS_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"ls",
	"repo_read",
	"bash",
	"python",
	"run_process",
	TOOL_SCHEMA_SEARCH_NAME,
	"artifact_retrieve",
	"skill",
	"skill_audit",
	SYSTEM_ONE_TOOL_NAME,
	"fetch",
	"web_search",
	"webfetch",
	"worktree_sync",
]);

/**
 * A worker process holds a tool only when it is allow-listed (or is an explicitly granted extension
 * tool, see {@link isExtensionToolGrantable}) and not on the forbidden floor.
 */
export function isWorkerProcessToolAllowed(toolName: string, grantedExtensionTools?: ReadonlySet<string>): boolean {
	if (WORKER_FORBIDDEN_TOOLS.has(toolName)) return false;
	if (WORKER_PROCESS_ALLOWED_TOOLS.has(toolName)) return true;
	return grantedExtensionTools?.has(toolName) === true && isExtensionToolGrantable(toolName);
}

/**
 * Whether a launch profile may grant a worker process an extension-provided tool under this name. A grant
 * only ever ADDS an extension tool; it can never name a tool the harness itself owns: anything on the
 * forbidden floor, the in-process-only denial set, the worker allow-list (those are named directly), or
 * any capability-catalogued tool. An extension that registers one of those names does not inherit its
 * authority or its ceiling status.
 */
export function isExtensionToolGrantable(toolName: string): boolean {
	return (
		toolName.length > 0 &&
		!WORKER_FORBIDDEN_TOOLS.has(toolName) &&
		!WORKER_LEAF_LANE_ONLY_FORBIDDEN_TOOLS.has(toolName) &&
		!WORKER_PROCESS_ALLOWED_TOOLS.has(toolName) &&
		!hasCataloguedToolCapabilityPolicy(toolName)
	);
}
