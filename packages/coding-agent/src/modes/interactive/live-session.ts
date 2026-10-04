import type { AgentSession } from "../../core/agent-session.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import type { SessionManager } from "../../kernel/node.ts";

/**
 * The interactive host's current session and its services. Read them per use: /new, /resume and fork
 * replace the session and its manager, so a captured reference would go stale.
 */
export interface LiveSessionServices {
	getSession(): AgentSession;
	getSessionManager(): SessionManager;
	getSettingsManager(): SettingsManager;
	getModelRegistry(): ModelRegistry;
}
