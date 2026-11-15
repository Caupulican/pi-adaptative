/** The name of the tool a session directs its workers with, and the director tools a bot's session holds. */
import { ASSIGN_TOOL_NAME } from "./assign-tool-name.ts";

/** The tool a session that directs workers starts, steers and ends them with. */
export const DELEGATE_TOOL_NAME = "delegate";

/**
 * The tools a bot's session directs its workers with: `delegate` and its one-call form `assign`. A bot holds no `plan`:
 * the plan surfaces (the director role's plan lines, the plan rule and the tool itself) follow the tool list, so a bot
 * gets none of them.
 */
export const BOT_DIRECTOR_TOOL_NAMES: readonly string[] = [DELEGATE_TOOL_NAME, ASSIGN_TOOL_NAME];
