/**
 * Construction of the session's background tool-task controller, extracted from the session
 * coordinator (decomposition ratchet: the coordinator only wires, its line ceiling only moves
 * down). Every dependency the controller needs from the session is a getter here, so this file
 * owns the shape of that wiring and its own test.
 */

import type { SessionManager } from "@caupulican/pi-agent-core/session";
import type { Usage } from "@caupulican/pi-ai";
import type { AgentSessionEvent } from "./agent-session-contracts.ts";
import {
	BACKGROUND_TOOL_TASK_CUSTOM_TYPE,
	BackgroundToolTaskController,
	type BackgroundToolTaskControllerDeps,
	type BackgroundToolTaskRecord,
	loadBackgroundToolTaskRecordsNewestFirst,
} from "./background-tool-task-controller.ts";

export interface SessionBackgroundToolTaskDeps {
	getSessionManager(): SessionManager;
	getGoalId(): string | undefined;
	getCurrentSubmissionEpoch(): number | undefined;
	isForegroundWait(toolName: string, args: unknown): boolean;
	getArtifactStore(): ReturnType<BackgroundToolTaskControllerDeps["getArtifactStore"]>;
	notifyTerminal(records: readonly BackgroundToolTaskRecord[], wakeParent: boolean): void | Promise<void>;
	emit(event: AgentSessionEvent): void;
	addSpawnedUsage(usage: Usage, options: { label?: string; sourceSessionId?: string; reportId?: string }): void;
}

export function createSessionBackgroundToolTasks(deps: SessionBackgroundToolTaskDeps): BackgroundToolTaskController {
	return new BackgroundToolTaskController({
		getSessionId: () => deps.getSessionManager().getSessionId(),
		getGoalId: () => deps.getGoalId(),
		getCurrentSubmissionEpoch: () => deps.getCurrentSubmissionEpoch(),
		getSessionLineageIds: () => deps.getSessionManager().getSessionLineageIds(),
		isForegroundWait: (tool, args) => deps.isForegroundWait(tool, args),
		getArtifactStore: () => deps.getArtifactStore(),
		loadPersistedRecordsNewestFirst: () => loadBackgroundToolTaskRecordsNewestFirst(deps.getSessionManager()),
		persist: (record) => deps.getSessionManager().appendCustomEntry(BACKGROUND_TOOL_TASK_CUSTOM_TYPE, record),
		notifyTerminal: (records, options) => deps.notifyTerminal(records, options.wakeParent),
		onLiveTasksChanged: (tasks) => deps.emit({ type: "background_tools", tasks }),
		recordUsage: (taskId, usage) => {
			const sessionId = deps.getSessionManager().getSessionId();
			deps.addSpawnedUsage(usage, {
				label: "background-tool",
				sourceSessionId: sessionId,
				reportId: `background-tool:${sessionId}:${taskId}`,
			});
		},
		onError: (message, error) =>
			deps.emit({
				type: "warning",
				message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
			}),
	});
}
