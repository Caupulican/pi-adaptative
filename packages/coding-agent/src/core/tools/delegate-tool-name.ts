/** The name of the tool a session directs its workers with, and the director tools a bot's session holds. */
import { ASSIGN_TOOL_NAME } from "./assign-tool-name.ts";
import { PLAN_TOOL_NAME } from "./plan-tool-name.ts";

/** The tool a session that directs workers starts, steers and ends them with. */
export const DELEGATE_TOOL_NAME = "delegate";

/**
 * The tools a bot's session directs its workers with: `delegate`, its one-call form `assign` and `plan`, which runs a
 * graph of steps on workers through the same fleet. The plan surfaces (the director role's plan lines, the plan rule and the
 * tool itself) follow the tool list, so a bot that holds these holds all of them.
 */
export const BOT_DIRECTOR_TOOL_NAMES: readonly string[] = [DELEGATE_TOOL_NAME, ASSIGN_TOOL_NAME, PLAN_TOOL_NAME];
