/**
 * Active tool set for the session coordinator: the names a caller requests are reduced to what the model's
 * capability admits, resolved to registered tools (with the artifact and path-alias wrappers), and the base system
 * prompt is rebuilt for the set that remains. The coordinator supplies its owners through one ports object.
 */

import type { Api, Model } from "@caupulican/pi-ai";
import type { Agent } from "../kernel/agent.ts";
import type { AgentTool } from "../kernel/types.ts";
import type { BackgroundLaneController } from "./background-lane-controller.ts";
import { wrapToolWithPathAliasExpansion } from "./context/path-alias-tool-wrap.ts";
import { PACKED_TOOL_OUTPUT_TOOLS } from "./context/tool-output-packer.ts";
import type { ContextPipeline } from "./context-pipeline.ts";
import type { GoalSessionController } from "./goals/goal-session-controller.ts";
import { type ModelCapabilityProfile, partitionToolNamesForCapability } from "./model-capability.ts";
import type { RuntimeBuilder } from "./runtime-builder.ts";
import type { SessionRuntimeAdmissionController } from "./session-runtime-admission-controller.ts";
import type { SystemPromptBuilder } from "./system-prompt-builder.ts";

export interface AgentSessionToolActivationPorts {
	runtimeAdmission(): SessionRuntimeAdmissionController;
	ownsHistory(): boolean;
	getModelCapabilityProfile(): ModelCapabilityProfile;
	model(): Model<Api> | undefined;
	runtimeBuilder(): RuntimeBuilder;
	agent(): Agent;
	pipeline(): ContextPipeline;
	pathAliasWrappedTools(): WeakSet<AgentTool>;
	cwd(): string;
	systemPromptBuilder(): SystemPromptBuilder;
	backgroundLanes(): BackgroundLaneController;
	goals(): GoalSessionController;
	checkContextWindowUsageWarning(): void;
	setBaseSystemPrompt(prompt: string): void;
	setRequestedActiveToolNames(names: string[]): void;
}

export class AgentSessionToolActivation {
	private readonly ports: AgentSessionToolActivationPorts;

	constructor(ports: AgentSessionToolActivationPorts) {
		this.ports = ports;
	}

	applyActiveTools(toolNames: string[], assertCurrent?: () => void): void {
		this.ports.runtimeAdmission().mutateResources(
			"active tools",
			() => {
				// Model capability: small-window models get a reduced tool surface derived from the model's
				// own metadata. The unfiltered request is remembered so a later switch to a larger model
				// restores it (the filter is re-applied on every model change).
				this.ports.setRequestedActiveToolNames([...toolNames]);
				const requested = [...toolNames];
				if (requested.includes("skill")) {
					requested.push("skillify", "skill_audit");
				}
				if (this.ports.ownsHistory() && requested.includes("memory")) {
					requested.push("zoom", "date");
				}
				const capability = partitionToolNamesForCapability(
					requested,
					this.ports.getModelCapabilityProfile(),
					this.ports.model(),
				);
				this.ports.runtimeBuilder().noteCapabilityOmissions(capability.withheld);

				const tools: AgentTool[] = [];
				const validToolNames: string[] = [];
				const seen = new Set<string>();
				const addIfRegistered = (name: string): void => {
					if (seen.has(name)) return;
					const tool = this.ports.runtimeBuilder().getRegisteredTool(name);
					if (!tool) return;
					seen.add(name);
					tools.push(tool);
					validToolNames.push(name);
				};

				for (const name of capability.kept) {
					addIfRegistered(name);
				}
				// A background tool task packs any tool's oversized terminal output (bash included) and names the artifact in its result.
				if (
					validToolNames.some((name) => PACKED_TOOL_OUTPUT_TOOLS.has(name)) ||
					validToolNames.includes("tool_task") ||
					validToolNames.includes("ask_question")
				) {
					addIfRegistered("artifact_retrieve");
				}
				this.ports.agent().state.tools = tools.map((tool) =>
					wrapToolWithPathAliasExpansion(
						tool,
						() => this.ports.pipeline().peekPathAliasTable(),
						this.ports.pathAliasWrappedTools(),
						() => this.ports.cwd(),
					),
				);

				// Rebuild base system prompt with new tool set
				const baseSystemPrompt = this.ports.systemPromptBuilder().rebuildSystemPrompt(validToolNames);
				this.ports.setBaseSystemPrompt(baseSystemPrompt);
				this.ports.agent().state.systemPrompt = baseSystemPrompt;
				this.ports
					.backgroundLanes()
					.reconcileGoalContinuationToolAvailability(
						() => this.ports.goals().resumeGoalToolAvailable() !== undefined,
					);

				this.ports.checkContextWindowUsageWarning();
			},
			assertCurrent,
		);
	}
}
