/**
 * `workerDelegation.outcomes`: owner overrides for what the host does after a worker outcome (the escalation ladder) and
 * how outcomes teach model choice (the outcome ledger). Every field is optional; the defaults run hands-off.
 */

export interface WorkerOutcomeEscalationSettings {
	/** default: true; false keeps every outcome's next step at the owner or the parent, never an automatic rerun */
	enabled?: boolean;
	/** default: 3; the most escalation rungs (reruns of uncovered requirements) one task's outcomes may schedule */
	maxRungs?: number;
}

export interface WorkerOutcomeLearningSettings {
	/** default: true; false stops recording outcomes into the ledger and ranking routed models by them */
	enabled?: boolean;
	/** default: 14; days after which a recorded observation counts half */
	halfLifeDays?: number;
	/** default: 24; hours a demoted model rests for one task class before it is tried again (doubles per demotion) */
	restHours?: number;
	/** default: 7; the longest rest in days */
	maxRestDays?: number;
}

export interface WorkerOutcomeSettings {
	escalation?: WorkerOutcomeEscalationSettings;
	learning?: WorkerOutcomeLearningSettings;
}

export interface ResolvedWorkerOutcomeSettings {
	readonly escalation: Readonly<Required<WorkerOutcomeEscalationSettings>>;
	readonly learning: Readonly<Required<WorkerOutcomeLearningSettings>>;
}

export const DEFAULT_WORKER_OUTCOME_SETTINGS: ResolvedWorkerOutcomeSettings = {
	escalation: { enabled: true, maxRungs: 3 },
	learning: { enabled: true, halfLifeDays: 14, restHours: 24, maxRestDays: 7 },
};

const MAX_ESCALATION_RUNGS = 8;
const MAX_HALF_LIFE_DAYS = 365;
const MAX_REST_HOURS = 24 * 30;
const MAX_REST_DAYS = 90;

type Reporter = ((message: string) => void) | undefined;

interface NumberField {
	readonly key: string;
	readonly min: number;
	readonly max: number;
	readonly integer: boolean;
}

function normalizeSection<T extends object>(
	value: unknown,
	path: string,
	booleans: readonly string[],
	numbers: readonly NumberField[],
	report: Reporter,
): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		report?.(`${path} must be an object; the configured value was ignored`);
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const normalized: Record<string, boolean | number> = {};
	for (const key of booleans) {
		if (!Object.hasOwn(record, key)) continue;
		if (typeof record[key] === "boolean") normalized[key] = record[key];
		else report?.(`${path}.${key} must be a boolean; the configured value was ignored`);
	}
	for (const field of numbers) {
		if (!Object.hasOwn(record, field.key)) continue;
		const candidate = record[field.key];
		const valid =
			typeof candidate === "number" &&
			Number.isFinite(candidate) &&
			(!field.integer || Number.isSafeInteger(candidate)) &&
			candidate >= field.min &&
			candidate <= field.max;
		if (valid) normalized[field.key] = candidate;
		else
			report?.(
				`${path}.${field.key} must be ${field.integer ? "an integer" : "a number"} between ${field.min} and ${field.max}; the configured value was ignored`,
			);
	}
	return normalized as T;
}

/** Validate one precedence layer's `workerDelegation.outcomes`; malformed fields are dropped and reported. */
export function normalizeWorkerOutcomeSettings(value: unknown, report?: Reporter): WorkerOutcomeSettings | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		report?.("workerDelegation.outcomes must be an object; the configured value was ignored");
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const escalation = normalizeSection<WorkerOutcomeEscalationSettings>(
		record.escalation,
		"workerDelegation.outcomes.escalation",
		["enabled"],
		[{ key: "maxRungs", min: 0, max: MAX_ESCALATION_RUNGS, integer: true }],
		report,
	);
	const learning = normalizeSection<WorkerOutcomeLearningSettings>(
		record.learning,
		"workerDelegation.outcomes.learning",
		["enabled"],
		[
			{ key: "halfLifeDays", min: 1, max: MAX_HALF_LIFE_DAYS, integer: false },
			{ key: "restHours", min: 1, max: MAX_REST_HOURS, integer: false },
			{ key: "maxRestDays", min: 1, max: MAX_REST_DAYS, integer: false },
		],
		report,
	);
	return { ...(escalation ? { escalation } : {}), ...(learning ? { learning } : {}) };
}

/** A higher layer overrides a lower one field by field. */
export function mergeWorkerOutcomeSettings(
	lower: WorkerOutcomeSettings | undefined,
	higher: WorkerOutcomeSettings | undefined,
): WorkerOutcomeSettings | undefined {
	if (!lower) return higher;
	if (!higher) return lower;
	const escalation = { ...lower.escalation, ...higher.escalation };
	const learning = { ...lower.learning, ...higher.learning };
	return {
		...(Object.keys(escalation).length > 0 ? { escalation } : {}),
		...(Object.keys(learning).length > 0 ? { learning } : {}),
	};
}

/** The effective outcome settings: the hands-off defaults with the owner's validated overrides on top. */
export function resolveWorkerOutcomeSettings(
	configured: WorkerOutcomeSettings | undefined,
): ResolvedWorkerOutcomeSettings {
	const defaults = DEFAULT_WORKER_OUTCOME_SETTINGS;
	return {
		escalation: { ...defaults.escalation, ...configured?.escalation },
		learning: { ...defaults.learning, ...configured?.learning },
	};
}
