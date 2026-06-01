import type { ToolExecutionComponent } from "./tool-execution.ts";

export interface ToolPanelTenantScope {
	sessionId?: string;
	sessionFile?: string;
	cwd: string;
}

export function createToolPanelTenantKey(scope: ToolPanelTenantScope): string {
	return [scope.sessionId || "no-session-id", scope.sessionFile || "no-session-file", scope.cwd].join("\0");
}

export function getToolPanelActionKey(
	scope: ToolPanelTenantScope,
	toolName: string,
	args: unknown,
): string | undefined {
	const tenantKey = createToolPanelTenantKey(scope);
	if (!args || typeof args !== "object") return toolName.endsWith("_status") ? `${tenantKey}\0${toolName}` : undefined;
	const record = args as Record<string, unknown>;
	const pathValue = record.path ?? record.file_path;
	if (["read", "edit", "write"].includes(toolName) && typeof pathValue === "string" && pathValue.trim()) {
		return `${tenantKey}\0${toolName}:${pathValue.trim()}`;
	}
	if (toolName.endsWith("_status")) return `${tenantKey}\0${toolName}`;
	if (toolName === "learning_auto_learn_state") return `${tenantKey}\0${toolName}:${String(record.action || "read")}`;
	if (toolName === "task_steps") return `${tenantKey}\0${toolName}:${String(record.action || "list")}`;
	return undefined;
}

export class ToolPanelRegistry {
	private readonly panelsByAction = new Map<string, ToolExecutionComponent>();
	private readonly activeByCallId = new Map<string, ToolExecutionComponent>();
	private readonly actionKeyByCallId = new Map<string, string>();

	getReusable(actionKey: string | undefined): ToolExecutionComponent | undefined {
		if (!actionKey) return undefined;
		const panel = this.panelsByAction.get(actionKey);
		if (!panel || this.isActive(panel)) return undefined;
		return panel;
	}

	register(toolCallId: string, panel: ToolExecutionComponent, actionKey?: string): void {
		this.activeByCallId.set(toolCallId, panel);
		if (actionKey) {
			this.panelsByAction.set(actionKey, panel);
			this.actionKeyByCallId.set(toolCallId, actionKey);
		}
	}

	hasActive(toolCallId: string): boolean {
		return this.activeByCallId.has(toolCallId);
	}

	getActive(toolCallId: string): ToolExecutionComponent | undefined {
		return this.activeByCallId.get(toolCallId);
	}

	activeEntries(): IterableIterator<[string, ToolExecutionComponent]> {
		return this.activeByCallId.entries();
	}

	isActive(panel: ToolExecutionComponent): boolean {
		for (const active of this.activeByCallId.values()) {
			if (active === panel) return true;
		}
		return false;
	}

	finish(toolCallId: string): void {
		this.activeByCallId.delete(toolCallId);
		this.actionKeyByCallId.delete(toolCallId);
	}

	clearActive(): void {
		this.activeByCallId.clear();
		this.actionKeyByCallId.clear();
	}

	clearAll(): void {
		this.activeByCallId.clear();
		this.panelsByAction.clear();
		this.actionKeyByCallId.clear();
	}
}
