import { type Static, Type } from "typebox";
import { AgentToolPolicyDeniedError } from "../../kernel/types.ts";
import {
	boundedUtf8Excerpt,
	TaskAutomationBindingSchema,
	type TaskAutomationOperationContract,
	TaskAutomationOperationContractSchema,
} from "../automation/contracts.ts";
import type { TaskAutomationController } from "../automation/task-automation-controller.ts";
import type { AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "../extensions/types.ts";

export const taskAutomationSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("status"),
			Type.Literal("spec"),
			Type.Literal("validate"),
			Type.Literal("run"),
			Type.Literal("bind"),
		]),
		name: Type.Optional(Type.String({ description: "Kebab-case automation name" })),
		stepId: Type.Optional(Type.String({ description: "Task step id to bind, e.g. 'step-1'" })),
		operationIdentity: Type.Optional(Type.String()),
		description: Type.Optional(Type.String({ description: "Summary of the deterministic operation" })),
		runner: Type.Optional(Type.Union([Type.Literal("bash"), Type.Literal("powershell"), Type.Literal("uv")])),
		path: Type.Optional(Type.String({ description: "Workspace-relative script path" })),
		contract: Type.Optional(TaskAutomationOperationContractSchema),
		args: Type.Optional(TaskAutomationBindingSchema.properties.expectedArgs),
		danger: Type.Optional(Type.Boolean({ description: "Operation needs edge authorization" })),
		background: Type.Optional(
			Type.Boolean({ description: "Run or validate in the background as a managed tool_task" }),
		),
	},
	{ additionalProperties: false },
);

export type TaskAutomationInput = Static<typeof taskAutomationSchema>;

export function createTaskAutomationToolDefinition(controller: TaskAutomationController): ToolDefinition {
	return {
		name: "task_automation",
		label: "task_automation",
		description:
			"Lifecycle controller for deterministic task-local automations. Hierarchy: an existing adequate tool first (native tools are cheap); else an existing validated script; else author a deterministic script; else model judgment. A generic shell/Python executor is not an existing implementation of a new deterministic procedure: persist it as a task-local script, validate, then run. status inspects automations and evidence; spec authors the contract (preconditions, effects, verifier); validate runs the verifier and negative controls to admit the script; run executes an admitted script after hash verification; bind ties a task step to an automation.",
		promptSnippet: "Task-local deterministic automations",
		parameters: taskAutomationSchema,
		async execute(
			_toolCallId: string,
			input: TaskAutomationInput,
			signal?: AbortSignal,
			_onUpdate?: AgentToolUpdateCallback<unknown>,
			_ctx?: ExtensionContext,
		) {
			const action = input.action;

			if (action === "status") {
				if (input.name) {
					const automation = controller.getAutomation(input.name);
					if (!automation) {
						return {
							content: [{ type: "text" as const, text: `Automation "${input.name}" not found.` }],
							details: { outcome: "not_found" },
							isError: true,
						};
					}
					return {
						content: [{ type: "text" as const, text: boundedUtf8Excerpt(JSON.stringify(automation, null, 2)) }],
						details: { outcome: "status", automation },
					};
				}
				const automations = controller.getAutomations();
				const summary = automations.map((a) => ({
					name: a.name,
					state: a.state,
					path: a.path,
					runner: a.runner,
					hasEvidence: a.evidence !== undefined,
					lastOutcome: a.lastExecution?.outcome,
					binding: a.binding,
				}));
				return {
					content: [
						{
							type: "text" as const,
							text: boundedUtf8Excerpt(
								automations.length === 0
									? "No task-local automations registered."
									: `Task automations (${automations.length}):\n${JSON.stringify(summary, null, 2)}`,
							),
						},
					],
					details: { outcome: "status", automations: summary },
				};
			}

			if (action === "spec") {
				if (!input.name || !input.description || !input.runner || !input.path || !input.contract) {
					return {
						content: [
							{
								type: "text" as const,
								text: "spec action requires: name, description, runner, path, and contract (inputs, outputs, preconditions, effects, failure, verifier).",
							},
						],
						details: { outcome: "invalid_input" },
						isError: true,
					};
				}

				try {
					const binding = input.stepId
						? {
								stepId: input.stepId,
								expectedArgs: input.args ?? [],
								operationIdentity: input.operationIdentity,
							}
						: undefined;

					const created = controller.author({
						name: input.name,
						description: input.description,
						runner: input.runner,
						path: input.path,
						contract: input.contract as TaskAutomationOperationContract,
						binding,
						danger: input.danger,
					});

					return {
						content: [
							{
								type: "text" as const,
								text: boundedUtf8Excerpt(
									`Automation "${created.name}" specification recorded in state "${created.state}". Next: build script at "${created.path}" and run validate.`,
								),
							},
						],
						details: { outcome: "specified", automation: created },
					};
				} catch (err) {
					return {
						content: [
							{
								type: "text" as const,
								text: boundedUtf8Excerpt(
									`Failed to author specification: ${err instanceof Error ? err.message : String(err)}`,
								),
							},
						],
						details: { outcome: "spec_failed" },
						isError: true,
					};
				}
			}

			if (action === "validate") {
				if (!input.name) {
					return {
						content: [{ type: "text" as const, text: "validate action requires name." }],
						details: { outcome: "invalid_input" },
						isError: true,
					};
				}

				const validation = await controller.validate(input.name, signal);
				if (validation.policy) {
					throw new AgentToolPolicyDeniedError(validation.reason, undefined, validation.policy.correction);
				}
				if (!validation.success) {
					return {
						content: [
							{
								type: "text" as const,
								text: boundedUtf8Excerpt(`Validation FAILED for "${input.name}": ${validation.reason}`),
							},
						],
						details: { outcome: "validation_failed", validation },
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: boundedUtf8Excerpt(
								`Validation SUCCEEDED for "${input.name}". Script hash: ${validation.evidence?.scriptHash.slice(0, 16)}... Admitted to ready state for execution.`,
							),
						},
					],
					details: { outcome: "validated", validation },
				};
			}

			if (action === "run") {
				if (!input.name) {
					return {
						content: [{ type: "text" as const, text: "run action requires name." }],
						details: { outcome: "invalid_input" },
						isError: true,
					};
				}

				const runResult = await controller.run(input.name, input.args ?? [], signal);
				if (runResult.policy) {
					throw new AgentToolPolicyDeniedError(runResult.error, undefined, runResult.policy.correction);
				}
				if (runResult.outcome !== "succeeded") {
					return {
						content: [
							{
								type: "text" as const,
								text: boundedUtf8Excerpt(
									`Automation run FAILED for "${input.name}": ${runResult.error}\nstderr: ${runResult.execution?.stderr ?? ""}`,
								),
							},
						],
						details: { outcome: "failed", runResult },
						isError: true,
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: boundedUtf8Excerpt(
								`Automation "${input.name}" succeeded (exit code 0).\nstdout:\n${runResult.execution?.stdout ?? ""}`,
							),
						},
					],
					details: { outcome: "succeeded", runResult },
				};
			}

			if (action === "bind") {
				if (!input.name || !input.stepId) {
					return {
						content: [{ type: "text" as const, text: "bind action requires name and stepId." }],
						details: { outcome: "invalid_input" },
						isError: true,
					};
				}
				try {
					controller.bindStep(input.name, {
						stepId: input.stepId,
						expectedArgs: input.args ?? [],
						operationIdentity: input.operationIdentity,
					});
					const argsMsg =
						input.args && input.args.length > 0
							? ` with expectedArgs [${input.args.join(", ")}]`
							: " with expectedArgs []";
					return {
						content: [
							{
								type: "text" as const,
								text: boundedUtf8Excerpt(
									`Bound task step "${input.stepId}" to automation "${input.name}"${argsMsg}. The step cannot be marked completed until automation execution succeeds.`,
								),
							},
						],
						details: { outcome: "bound", name: input.name, stepId: input.stepId, expectedArgs: input.args ?? [] },
					};
				} catch (err) {
					return {
						content: [
							{
								type: "text" as const,
								text: boundedUtf8Excerpt(
									`Failed to bind step: ${err instanceof Error ? err.message : String(err)}`,
								),
							},
						],
						details: { outcome: "bind_failed" },
						isError: true,
					};
				}
			}

			return {
				content: [{ type: "text" as const, text: `Unknown action: ${(input as { action: string }).action}` }],
				details: { outcome: "unknown_action" },
				isError: true,
			};
		},
	};
}
