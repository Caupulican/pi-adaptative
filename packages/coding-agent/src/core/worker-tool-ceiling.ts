/**
 * The tool ceiling of a worker session. Kept apart from session identity (`session-role.ts`), which
 * every launch path reads and which must not load tool modules to answer who this process is.
 */

import { SELF_COMPACT_TOOL_NAME } from "./compaction/self-compaction.ts";
import { ROOT_MEMORY_TOOL_NAME } from "./memory/worker-memory-tools.ts";
import { DECISION_LEDGER_READ_TOOL_NAME } from "./tools/decision-ledger-read.ts";

/**
 * Tools a worker session may never activate: agent launchers plus root-owned reflection, memory,
 * and machine credential state. The legacy `goal` tool is excluded because its composite action
 * surface can dispatch workers; the non-dispatching create/get/update lifecycle tools remain
 * eligible. `bash` and `python` remain available as explicit host-trust boundaries; the structural
 * path envelope does not confine arbitrary process code, and banning one execution route while
 * retaining the other would not create a meaningful filesystem boundary.
 */
export const WORKER_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
	"goal",
	"secret_store",
	ROOT_MEMORY_TOOL_NAME,
	"delegate",
	"improvement_loop",
	"model_fitness",
	"pi_collaboration",
	"context_scout",
	"runtime_update",
	"image_generate",
	"task_automation",
	// The decision ledger is the root's and System One's review surface; workers never read it.
	DECISION_LEDGER_READ_TOOL_NAME,
	SELF_COMPACT_TOOL_NAME,
]);
