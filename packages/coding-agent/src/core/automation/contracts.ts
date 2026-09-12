/**
 * Deterministic task-local automation lifecycle contracts and types.
 *
 * Decision hierarchy:
 * 1. Existing adequate tool first (native tools sufficient path is cheap).
 * 2. Else existing validated script (reuse admitted/registered scripts).
 * 3. Else build script for deterministic operation (author/validate task-local script).
 * 4. Else model judgment (non-deterministic / interpretive steps).
 */

import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolkitScript } from "../toolkit/script-registry.ts";

export const TASK_AUTOMATION_LIFECYCLE_STATES = [
	"needed",
	"specification",
	"building",
	"validating",
	"ready",
	"executing",
	"succeeded",
	"failed",
] as const;

export type TaskAutomationLifecycleState = (typeof TASK_AUTOMATION_LIFECYCLE_STATES)[number];

export const MAX_TASK_AUTOMATIONS = 50;
export const MAX_AUTOMATION_NAME_LENGTH = 64;
export const MAX_AUTOMATION_DESCRIPTION_LENGTH = 500;
export const MAX_AUTOMATION_PATH_LENGTH = 256;
export const MAX_NEGATIVE_CONTROLS = 16;
export const MAX_INPUT_PARAMETERS = 32;
export const MAX_OUTPUT_EXCERPT_BYTES = 16_384;
export const MAX_OUTPUT_SUBSTRING_LENGTH = 512;
export const MAX_PRECONDITIONS = 32;
export const MAX_EFFECTS = 32;
export const MAX_FAILURES = 32;
export const MAX_ARG_LENGTH = 500;
export const MAX_ARGS_COUNT = 64;
export const MAX_TIMEOUT_MS = 300_000;

const TRUNCATION_SUFFIX = "\n... [truncated]";
const SUFFIX_BYTES = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");

/**
 * Shared helper to truncate long output/error strings cleanly on UTF-8 boundaries.
 * Subtracts the suffix length so the total resulting byte length never exceeds maxBytes,
 * and handles tiny budgets without exceeding the cap.
 */
export function boundedUtf8Excerpt(text: string, maxBytes = MAX_OUTPUT_EXCERPT_BYTES): string {
	if (!text || maxBytes <= 0) return "";
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= maxBytes) {
		return text;
	}
	if (maxBytes <= SUFFIX_BYTES) {
		let end = maxBytes;
		while (end > 0 && (buf[end] & 0xc0) === 0x80) {
			end--;
		}
		return buf.subarray(0, end).toString("utf8");
	}
	let sliceEnd = maxBytes - SUFFIX_BYTES;
	while (sliceEnd > 0 && (buf[sliceEnd] & 0xc0) === 0x80) {
		sliceEnd--;
	}
	return `${buf.subarray(0, sliceEnd).toString("utf8")}${TRUNCATION_SUFFIX}`;
}

export const TaskAutomationParameterSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: MAX_AUTOMATION_NAME_LENGTH }),
		type: Type.Union([
			Type.Literal("string"),
			Type.Literal("number"),
			Type.Literal("boolean"),
			Type.Literal("array"),
		]),
		description: Type.String({ minLength: 1, maxLength: 300 }),
		required: Type.Optional(Type.Boolean()),
		default: Type.Optional(Type.Union([Type.String({ maxLength: 500 }), Type.Number(), Type.Boolean()])),
	},
	{ additionalProperties: false },
);

export type TaskAutomationParameterContract = Static<typeof TaskAutomationParameterSchema>;

export const TaskAutomationOutputContractSchema = Type.Object(
	{
		format: Type.Union([Type.Literal("text"), Type.Literal("json"), Type.Literal("lines")]),
		description: Type.String({ minLength: 1, maxLength: MAX_AUTOMATION_DESCRIPTION_LENGTH }),
		/** Required literal substring constraint for output validation. Finite includes check, NO RegExp. */
		contains: Type.String({ minLength: 1, maxLength: MAX_OUTPUT_SUBSTRING_LENGTH }),
	},
	{ additionalProperties: false },
);

export type TaskAutomationOutputContract = Static<typeof TaskAutomationOutputContractSchema>;

export const TaskAutomationNegativeControlSchema = Type.Object(
	{
		description: Type.String({ minLength: 1, maxLength: 300 }),
		args: Type.Array(Type.String({ maxLength: MAX_ARG_LENGTH }), { minItems: 1, maxItems: MAX_ARGS_COUNT }),
		/** Non-zero exit code expected (1-255). 0 is strictly forbidden. */
		expectedExitCode: Type.Optional(Type.Integer({ minimum: 1, maximum: 255 })),
		/** Optional literal substring expected in stderr or stdout on failure. Finite includes, NO RegExp. */
		expectedError: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_OUTPUT_SUBSTRING_LENGTH })),
	},
	{ additionalProperties: false },
);

export type TaskAutomationNegativeControl = Static<typeof TaskAutomationNegativeControlSchema>;

export const TaskAutomationVerifierContractSchema = Type.Object(
	{
		args: Type.Optional(Type.Array(Type.String({ maxLength: MAX_ARG_LENGTH }), { maxItems: MAX_ARGS_COUNT })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TIMEOUT_MS })),
		/** Required literal substring expected in stdout when verification passes. Mandatory finite check; NO RegExp. */
		expectedOutput: Type.String({ minLength: 1, maxLength: MAX_OUTPUT_SUBSTRING_LENGTH }),
		expectedExitCode: Type.Optional(Type.Literal(0)),
		negativeControls: Type.Array(TaskAutomationNegativeControlSchema, {
			minItems: 1,
			maxItems: MAX_NEGATIVE_CONTROLS,
		}),
	},
	{ additionalProperties: false },
);

export type TaskAutomationVerifierContract = Static<typeof TaskAutomationVerifierContractSchema>;

export const TaskAutomationOperationContractSchema = Type.Object(
	{
		inputs: Type.Array(TaskAutomationParameterSchema, { maxItems: MAX_INPUT_PARAMETERS }),
		outputs: TaskAutomationOutputContractSchema,
		preconditions: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
			minItems: 1,
			maxItems: MAX_PRECONDITIONS,
		}),
		effects: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
			minItems: 1,
			maxItems: MAX_EFFECTS,
		}),
		failure: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
			minItems: 1,
			maxItems: MAX_FAILURES,
		}),
		verifier: TaskAutomationVerifierContractSchema,
	},
	{ additionalProperties: false },
);

export type TaskAutomationOperationContract = Static<typeof TaskAutomationOperationContractSchema>;

export const TaskAutomationNegativeControlResultSchema = Type.Object(
	{
		description: Type.String({ minLength: 1, maxLength: 300 }),
		args: Type.Array(Type.String({ maxLength: MAX_ARG_LENGTH }), { maxItems: MAX_ARGS_COUNT }),
		exitCode: Type.Integer({ minimum: 1, maximum: 255 }),
		passed: Type.Boolean(),
		error: Type.Optional(Type.String({ maxLength: MAX_OUTPUT_EXCERPT_BYTES })),
	},
	{ additionalProperties: false },
);

export type TaskAutomationNegativeControlResult = Static<typeof TaskAutomationNegativeControlResultSchema>;

export const TaskAutomationEvidenceSchema = Type.Object(
	{
		/** Exact SHA-256 hash (64 hex characters) of script at validation time. */
		scriptHash: Type.String({ minLength: 64, maxLength: 64 }),
		verifiedAt: Type.String({ minLength: 1, maxLength: 64 }),
		verifierExitCode: Type.Literal(0),
		verifierStdout: Type.String({ maxLength: MAX_OUTPUT_EXCERPT_BYTES }),
		verifierStderr: Type.String({ maxLength: MAX_OUTPUT_EXCERPT_BYTES }),
		negativeControls: Type.Array(TaskAutomationNegativeControlResultSchema, {
			minItems: 1,
			maxItems: MAX_NEGATIVE_CONTROLS,
		}),
		workspaceCwd: Type.String({ minLength: 1, maxLength: 1024 }),
	},
	{ additionalProperties: false },
);

export type TaskAutomationEvidence = Static<typeof TaskAutomationEvidenceSchema>;

export const TaskAutomationExecutionResultSchema = Type.Object(
	{
		runId: Type.String({ minLength: 1, maxLength: 128 }),
		exitCode: Type.Union([Type.Integer(), Type.Null()]),
		stdout: Type.String({ maxLength: MAX_OUTPUT_EXCERPT_BYTES }),
		stderr: Type.String({ maxLength: MAX_OUTPUT_EXCERPT_BYTES }),
		durationMs: Type.Integer({ minimum: 0 }),
		startedAt: Type.String({ minLength: 1, maxLength: 64 }),
		completedAt: Type.String({ maxLength: 64 }),
		outcome: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
		args: Type.Optional(Type.Array(Type.String({ maxLength: MAX_ARG_LENGTH }), { maxItems: MAX_ARGS_COUNT })),
		error: Type.Optional(Type.String({ maxLength: MAX_OUTPUT_EXCERPT_BYTES })),
	},
	{ additionalProperties: false },
);

export type TaskAutomationExecutionResult = Static<typeof TaskAutomationExecutionResultSchema>;

export const TaskAutomationBindingSchema = Type.Object(
	{
		stepId: Type.String({ minLength: 1, maxLength: 128 }),
		expectedArgs: Type.Array(Type.String({ maxLength: MAX_ARG_LENGTH }), { maxItems: MAX_ARGS_COUNT }),
		operationIdentity: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	},
	{ additionalProperties: false },
);

export type TaskAutomationStepBinding = Static<typeof TaskAutomationBindingSchema>;

export const TaskAutomationDefinitionSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: MAX_AUTOMATION_NAME_LENGTH }),
		description: Type.String({ minLength: 1, maxLength: MAX_AUTOMATION_DESCRIPTION_LENGTH }),
		runner: Type.Union([Type.Literal("bash"), Type.Literal("powershell"), Type.Literal("uv")]),
		path: Type.String({ minLength: 1, maxLength: MAX_AUTOMATION_PATH_LENGTH }),
		state: Type.Enum(TASK_AUTOMATION_LIFECYCLE_STATES),
		contract: TaskAutomationOperationContractSchema,
		evidence: Type.Optional(TaskAutomationEvidenceSchema),
		lastExecution: Type.Optional(TaskAutomationExecutionResultSchema),
		binding: Type.Optional(TaskAutomationBindingSchema),
		danger: Type.Optional(Type.Boolean()),
		workspaceCwd: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
		generation: Type.Optional(Type.Integer({ minimum: 0 })),
		activeToken: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		createdAt: Type.String({ minLength: 1, maxLength: 64 }),
		updatedAt: Type.String({ minLength: 1, maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export type TaskAutomationDefinition = Readonly<Static<typeof TaskAutomationDefinitionSchema>>;

export const TaskAutomationStateSchema = Type.Object(
	{
		version: Type.Literal(1),
		revision: Type.Integer({ minimum: 0 }),
		automations: Type.Array(TaskAutomationDefinitionSchema, { maxItems: MAX_TASK_AUTOMATIONS }),
		createdAt: Type.String({ minLength: 1, maxLength: 64 }),
		updatedAt: Type.String({ minLength: 1, maxLength: 64 }),
	},
	{ additionalProperties: false },
);

export type TaskAutomationState = Readonly<Static<typeof TaskAutomationStateSchema>>;

export interface TaskStepLike {
	readonly id: string;
	readonly status?: string;
	readonly content?: string;
}

export interface TaskAutomationContextPort {
	readonly getCwd: () => string;
	readonly getSessionId?: () => string | undefined;
	readonly getBranchId?: () => string | undefined;
}

export interface TaskAutomationStoragePort {
	readonly appendSnapshot: (state: TaskAutomationState) => string;
	readonly getLatestSnapshot: () => TaskAutomationState | undefined;
}

export interface TaskAutomationHashPort {
	readonly computeFileHash: (path: string, cwd: string) => string | undefined;
	readonly computeContentHash: (content: string | Buffer) => string;
}

export class TaskAutomationBindingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskAutomationBindingError";
	}
}

/** Check whether an automation in `ready` state is admitted as a ToolkitScript. */
export function taskAutomationToToolkitScript(automation: TaskAutomationDefinition): ToolkitScript {
	return {
		name: automation.name,
		description: automation.description,
		runner: automation.runner,
		path: automation.path,
		danger: automation.danger,
	};
}

export function cloneTaskAutomationContract(
	contract: TaskAutomationOperationContract,
): TaskAutomationOperationContract {
	return structuredClone(contract);
}

/**
 * Evaluates execution stdout against output contract.
 * Requires mandatory 'contains' substring constraint.
 * Uses finite substring inclusion check over full stdout (NO RegExp) and JSON parsing when requested.
 */
export function evaluateOutputContract(
	output: TaskAutomationOutputContract,
	stdout: string,
): { valid: boolean; error?: string } {
	if (!output || typeof output.contains !== "string" || output.contains.length === 0) {
		return { valid: false, error: "Output contract missing required 'contains' substring constraint." };
	}
	const trimmed = stdout.trim();
	if (output.format === "json") {
		if (trimmed.length === 0) {
			return { valid: false, error: "Output contract requires JSON, but stdout was empty." };
		}
		try {
			JSON.parse(trimmed);
		} catch (err) {
			return {
				valid: false,
				error: `Output contract requires JSON, but stdout failed JSON parsing: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	} else if (output.format === "lines") {
		if (trimmed.length === 0) {
			return { valid: false, error: "Output contract requires lines format, but stdout was empty." };
		}
	}

	// Finite substring inclusion over full stdout: NO pre-truncation, NO RegExp!
	if (!stdout.includes(output.contains)) {
		return { valid: false, error: `Output does not contain required substring "${output.contains}".` };
	}
	return { valid: true };
}

/**
 * Validate a TaskAutomationOperationContract strictly using TypeBox Value.Check/Errors against ONE schema.
 * Rejects exit-zero negative controls, missing expectedOutput or contains, bounds on parameters/controls,
 * and unknown/extra properties.
 */
export function validateTaskAutomationContract(contract: unknown): { valid: boolean; errors: string[] } {
	if (!contract || typeof contract !== "object") {
		return { valid: false, errors: ["Contract must be a valid object."] };
	}

	const errors: string[] = [];

	// Semantic cross-field check for negative controls expectedExitCode 0
	const c = contract as Partial<TaskAutomationOperationContract>;
	if (c.verifier && Array.isArray(c.verifier.negativeControls)) {
		for (let i = 0; i < c.verifier.negativeControls.length; i++) {
			const nc = c.verifier.negativeControls[i];
			if (nc && typeof nc === "object" && (nc as { expectedExitCode?: number }).expectedExitCode === 0) {
				errors.push(`negativeControl[${i}].expectedExitCode cannot be 0; negative controls must expect failure.`);
			}
		}
	}

	if (c.outputs && typeof c.outputs === "object") {
		const out = c.outputs as { contains?: string };
		if (typeof out.contains !== "string" || out.contains.trim().length === 0) {
			errors.push("outputs.contains is required and must be a non-empty string.");
		}
	}

	if (c.verifier && typeof c.verifier === "object") {
		const v = c.verifier as { expectedOutput?: string };
		if (typeof v.expectedOutput !== "string" || v.expectedOutput.trim().length === 0) {
			errors.push("verifier.expectedOutput is mandatory; exit-zero-only validation is prohibited.");
		}
	}

	// Single TypeBox schema check
	if (!Value.Check(TaskAutomationOperationContractSchema, contract)) {
		for (const err of Value.Errors(TaskAutomationOperationContractSchema, contract)) {
			const errPath = err.instancePath;
			const path = errPath.length > 0 ? `${errPath.startsWith("/") ? errPath.slice(1) : errPath}: ` : "";
			errors.push(`${path}${err.message}`);
		}
	}

	return { valid: errors.length === 0, errors };
}
