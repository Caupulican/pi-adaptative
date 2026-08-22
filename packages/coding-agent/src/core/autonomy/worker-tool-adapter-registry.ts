import type { AgentTool } from "@caupulican/pi-agent-core";
import type { TSchema } from "typebox";
import type { ArtifactStore } from "../context/context-artifacts.ts";
import { type CredentialExposureBoundary, isProtectedCredentialPath } from "../secrets/credential-exposure-guard.ts";
import { createArtifactRetrieveTool } from "../tools/artifact-retrieve.ts";
import {
	createRunToolkitScriptToolDefinition,
	type RunToolkitScriptDependencies,
} from "../tools/run-toolkit-script.ts";
import { createReadOnlySkillToolDefinition, type ReadOnlySkillBroker } from "../tools/skill.ts";
import {
	createSkillAuditToolDefinition,
	DEFAULT_WORKER_SKILL_AUDIT_MAX_COMPARISON_PAIRS,
	DEFAULT_WORKER_SKILL_AUDIT_MAX_DRAFT_FIELD_CHARS,
	DEFAULT_WORKER_SKILL_AUDIT_MAX_SKILLS,
	type SkillAuditToolOptions,
} from "../tools/skill-audit.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";

/**
 * Host-owned inputs available while constructing one fresh worker tool.
 *
 * An adapter is deliberately a factory, not a live AgentTool. This keeps worker retries and
 * concurrent lanes from sharing mutable foreground/session state. The host owns the broker
 * callbacks and is responsible for preserving its cancellation and credential boundaries.
 */
export interface WorkerToolAdapterContext {
	cwd: string;
	signal?: AbortSignal;
	credentialBoundary?: CredentialExposureBoundary;
}

export type WorkerToolAdapterFactory = (context: WorkerToolAdapterContext) => AgentTool<TSchema, unknown>;

export interface WorkerToolAdapter {
	readonly name: string;
	readonly description: string;
	readonly create: WorkerToolAdapterFactory;
}

/** Root/session controls are never brokered into a leaf, even when a host registers factories. */
export const WORKER_TOOL_ADAPTER_FORBIDDEN_NAMES: ReadonlySet<string> = new Set([
	"delegate",
	"tmux_dispatch",
	"tmux_agent_manager",
	"context_scout",
	"memory",
	"goal",
	"get_goal",
	"update_goal",
	"task_steps",
	"pipeline",
	"tool_task",
	"ask_question",
	"secret_store",
	"settings",
	"session",
	"credential",
	"model_fitness",
	"improvement_loop",
	"skillify",
	"extensionify",
	"worktree_sync",
]);

/** Adapter names with host-owned factories; explicit profiles must have these active in foreground. */
export const WORKER_TOOL_ADAPTER_NAMES: ReadonlySet<string> = new Set([
	"artifact_retrieve",
	"run_toolkit_script",
	"skill",
	"skill_audit",
]);

export type WorkerToolAdapterMaterialization =
	| { ok: true; tool: AgentTool<TSchema, unknown> }
	| { ok: false; reason: string };

export interface WorkerToolAdapterSources {
	/** Session-owned packed output store; retrieval is bounded and identifier-only. */
	artifactStore?: ArtifactStore;
	/** Host-owned script registry and bounded executor. */
	runToolkitScript?: RunToolkitScriptDependencies;
	/** Optional brokered read-only skill surface. */
	skill?: ReadOnlySkillBroker;
	/** Optional read-only skill audit broker with host-path redaction. */
	skillAudit?: Pick<SkillAuditToolOptions, "getSkills" | "maxSkills" | "maxComparisonPairs" | "maxDraftFieldChars"> &
		Required<Pick<SkillAuditToolOptions, "redactPath">>;
}

/**
 * Registry for the small set of foreground capabilities that can be brokered safely to a leaf
 * worker. It owns no session state and never clones or returns the foreground tool instance.
 *
 * Extension/MCP tools must be registered explicitly by a host broker. A missing registration is
 * a deterministic unsupported result so an omitted inherited tool cannot silently disappear.
 */
export class WorkerToolAdapterRegistry {
	private readonly adapters = new Map<string, WorkerToolAdapter>();

	register(adapter: WorkerToolAdapter): this {
		const name = adapter.name.trim();
		if (!name) throw new TypeError("Worker tool adapter name must not be empty.");
		if (WORKER_TOOL_ADAPTER_FORBIDDEN_NAMES.has(name.toLowerCase())) {
			throw new Error(`worker_tool_adapter_forbidden:${name}`);
		}
		if (this.adapters.has(name)) throw new Error(`Duplicate worker tool adapter: ${name}`);
		this.adapters.set(name, Object.freeze({ ...adapter, name }));
		return this;
	}

	has(name: string): boolean {
		return this.adapters.has(name);
	}

	names(): readonly string[] {
		return [...this.adapters.keys()];
	}

	description(name: string): string | undefined {
		return this.adapters.get(name)?.description;
	}

	materialize(name: string, context: WorkerToolAdapterContext): WorkerToolAdapterMaterialization {
		const adapter = this.adapters.get(name);
		if (!adapter) return { ok: false, reason: unsupportedWorkerToolReason(name) };
		try {
			const tool = adapter.create({ ...context });
			if (tool.name !== name) {
				return {
					ok: false,
					reason: `worker_tool_adapter_contract_violation:${name}:created=${tool.name}`,
				};
			}
			return { ok: true, tool };
		} catch (error) {
			return {
				ok: false,
				reason: `worker_tool_adapter_failed:${name}:${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
}

/** Build the default safe adapters from host-owned brokers. Omitted sources stay unsupported. */
export function createWorkerToolAdapterRegistry(sources: WorkerToolAdapterSources = {}): WorkerToolAdapterRegistry {
	const registry = new WorkerToolAdapterRegistry();
	if (sources.artifactStore) {
		registry.register({
			name: "artifact_retrieve",
			description: "Retrieve a bounded slice from a host-owned packed tool-output artifact.",
			create: (context) => createArtifactRetrieveTool(context.cwd, { artifactStore: sources.artifactStore }),
		});
	}
	if (sources.runToolkitScript) {
		registry.register({
			name: "run_toolkit_script",
			description: "Run a registered toolkit script through the host-owned bounded executor.",
			create: (context) => {
				const dependencies = sources.runToolkitScript!;
				return wrapToolDefinition(
					createRunToolkitScriptToolDefinition({
						...dependencies,
						getScripts: () =>
							dependencies
								.getScripts()
								.filter(
									(script) =>
										!context.credentialBoundary ||
										!isProtectedCredentialPath(script.path, context.cwd, context.credentialBoundary),
								),
					}),
				);
			},
		});
	}
	if (sources.skill) {
		registry.register({
			name: "skill",
			description: "Use the host-owned read-only skill broker.",
			create: () => wrapToolDefinition(createReadOnlySkillToolDefinition(sources.skill!)),
		});
	}
	if (sources.skillAudit) {
		const skillAudit = sources.skillAudit;
		registry.register({
			name: "skill_audit",
			description: "Audit skills through the host-owned read-only broker.",
			create: (context) =>
				wrapToolDefinition(
					createSkillAuditToolDefinition(context.cwd, {
						...skillAudit,
						maxSkills: Math.min(
							skillAudit.maxSkills ?? DEFAULT_WORKER_SKILL_AUDIT_MAX_SKILLS,
							DEFAULT_WORKER_SKILL_AUDIT_MAX_SKILLS,
						),
						maxComparisonPairs: Math.min(
							skillAudit.maxComparisonPairs ?? DEFAULT_WORKER_SKILL_AUDIT_MAX_COMPARISON_PAIRS,
							DEFAULT_WORKER_SKILL_AUDIT_MAX_COMPARISON_PAIRS,
						),
						maxDraftFieldChars: Math.min(
							skillAudit.maxDraftFieldChars ?? DEFAULT_WORKER_SKILL_AUDIT_MAX_DRAFT_FIELD_CHARS,
							DEFAULT_WORKER_SKILL_AUDIT_MAX_DRAFT_FIELD_CHARS,
						),
					}),
				),
		});
	}
	return registry;
}

export function unsupportedWorkerToolReason(name: string): string {
	return `worker_tool_adapter_unavailable:${name}`;
}
