/**
 * Core modules shared between all run modes.
 */

export type { CompactionResult } from "@caupulican/pi-agent-core/compaction/compaction";
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.ts";
export {
	AgentSessionRuntime,
	type AgentSessionRuntimeResource,
	type AgentSessionSwitchOptions,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
	SessionReplacementCallbackError,
	SessionReplacementRuntimeError,
} from "./agent-session-runtime.ts";
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
// Extensions system
export {
	type AgentEndEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type ContextEvent,
	defineTool,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	type MessageRenderer,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
	type WorkingIndicatorOptions,
} from "./extensions/index.ts";
export { discoverAndLoadExtensions } from "./extensions/loader.ts";
export * from "./hooks/index.ts";
export * from "./orchestration/capability-gateway.ts";
export * from "./orchestration/contracts.ts";
export * from "./orchestration/event-store.ts";
export * from "./orchestration/model-binding.ts";
export * from "./orchestration/policy-compiler.ts";
export * from "./orchestration/profile-registry.ts";
export * from "./orchestration/profile-store.ts";
export * from "./orchestration/task-runtime.ts";
export { createSyntheticSourceInfo } from "./source-info.ts";
export type {
	Change,
	Claim,
	CompletionGate,
	CompletionState,
	Constraint,
	ExecutionState,
	Hypothesis,
	Objective,
	Observation,
	Phase,
	Plan,
	PlanStep,
	RepoState,
	Risk,
	SourceRef,
	SystemOneAcceptanceCriterion,
	SystemOneConfig,
	ToolEvent,
	ToolImpact,
	ValidationDecision,
	ValidationStage,
	VerificationRun,
	WorkerTurnResult,
} from "./system-one/index.ts";
export {
	AuditStore,
	DEFAULT_SYSTEM_ONE_CONFIG,
	ExecutionStore,
	getQuestionPack,
	hashQuestionPack,
	redactSecrets,
	StateProjector,
	SYSTEM_ONE_CATALOG_VERSION,
	SYSTEM_ONE_PINNED_MODEL,
	SYSTEM_ONE_PREVIEW_MODEL,
	SystemOneController,
	SystemOneJevAdapter,
	SystemOneReplayRunner,
	wrapUntrustedText,
} from "./system-one/index.ts";
