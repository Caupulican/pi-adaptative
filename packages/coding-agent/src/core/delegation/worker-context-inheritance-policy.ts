import {
	MAX_ORCHESTRATION_MODEL_ID_LENGTH,
	MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
} from "../orchestration/contracts.ts";
import { parseSanitizedContextForkMode, type SanitizedContextForkMode } from "./sanitized-context-fork.ts";

export interface WorkerContextModelIdentity {
	provider: string;
	model: string;
}

export interface ResolveWorkerContextInheritanceModeInput {
	parent: WorkerContextModelIdentity;
	worker: WorkerContextModelIdentity;
	/** Eventual `fork_turns` wire value. Omission is policy-significant. */
	mode?: string;
}

function canonicalIdentity(value: string, maximum: number, label: string): string {
	if (!value || value.trim() !== value || value.length > maximum) {
		throw new TypeError(`${label} must be a bounded non-empty canonical string.`);
	}
	return value;
}

/**
 * Pure provider/model egress policy for sanitized birth context. Implicit inheritance is allowed
 * only when both identities match exactly; crossing either boundary defaults to none and requires
 * an explicit none if a mode was supplied.
 */
export function resolveWorkerContextInheritanceMode(
	input: ResolveWorkerContextInheritanceModeInput,
): SanitizedContextForkMode {
	const parentProvider = canonicalIdentity(
		input.parent.provider,
		MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
		"Parent provider",
	);
	const parentModel = canonicalIdentity(input.parent.model, MAX_ORCHESTRATION_MODEL_ID_LENGTH, "Parent model");
	const workerProvider = canonicalIdentity(
		input.worker.provider,
		MAX_ORCHESTRATION_MODEL_PROVIDER_LENGTH,
		"Worker provider",
	);
	const workerModel = canonicalIdentity(input.worker.model, MAX_ORCHESTRATION_MODEL_ID_LENGTH, "Worker model");
	const sameBoundary = parentProvider === workerProvider && parentModel === workerModel;

	if (input.mode === undefined) return sameBoundary ? { kind: "all" } : { kind: "none" };
	const mode = parseSanitizedContextForkMode(input.mode);
	if (!sameBoundary && mode.kind !== "none") {
		throw new TypeError("Worker context inheritance cannot cross a provider/model boundary.");
	}
	return mode;
}
