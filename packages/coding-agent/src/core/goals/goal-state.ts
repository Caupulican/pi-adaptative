export type GoalStatus = "active" | "completed" | "blocked" | "cancelled";
export type RequirementStatus = "open" | "satisfied" | "blocked";
export type GoalEvidenceKind = "file" | "test" | "tool" | "user" | "finding";

export interface GoalState {
	goalId: string;
	userGoal: string;
	status: GoalStatus;
	requirements: readonly Requirement[];
	evidence: readonly GoalEvidenceRef[];
	events: readonly GoalEvent[];
	createdAt: string;
	updatedAt: string;
	lastProgressAt: string;
	stallTurns: number;
	blockedReason?: string;
}

export interface Requirement {
	id: string;
	text: string;
	status: RequirementStatus;
	evidenceIds: readonly string[];
	blockedReason?: string;
	createdAt: string;
	updatedAt: string;
}

export interface GoalEvidenceRef {
	id: string;
	kind: GoalEvidenceKind;
	summary: string;
	uri?: string;
	createdAt: string;
}

export type GoalEvent =
	| { type: "add_requirement"; id: string; text: string; now: string }
	| { type: "satisfy_requirement"; id: string; evidenceIds: readonly string[]; now: string }
	| { type: "block_requirement"; id: string; blockedReason: string; now: string }
	| {
			type: "add_evidence";
			id: string;
			kind: GoalEvidenceKind;
			summary: string;
			uri?: string;
			now: string;
	  }
	| { type: "progress"; now: string }
	| { type: "no_progress"; now: string }
	| { type: "complete_goal"; now: string }
	| { type: "block_goal"; reason: string; now: string }
	| { type: "cancel_goal"; now: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return value === "active" || value === "completed" || value === "blocked" || value === "cancelled";
}

function isRequirementStatus(value: unknown): value is RequirementStatus {
	return value === "open" || value === "satisfied" || value === "blocked";
}

function isGoalEvidenceKind(value: unknown): value is GoalEvidenceKind {
	return value === "file" || value === "test" || value === "tool" || value === "user" || value === "finding";
}

function hasOptionalString(record: Record<string, unknown>, key: string): boolean {
	return record[key] === undefined || typeof record[key] === "string";
}

function isRequirement(value: unknown): value is Requirement {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.text === "string" &&
		isRequirementStatus(value.status) &&
		isStringArray(value.evidenceIds) &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		hasOptionalString(value, "blockedReason")
	);
}

function isGoalEvidenceRef(value: unknown): value is GoalEvidenceRef {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		isGoalEvidenceKind(value.kind) &&
		typeof value.summary === "string" &&
		typeof value.createdAt === "string" &&
		hasOptionalString(value, "uri")
	);
}

function isGoalEvent(value: unknown): value is GoalEvent {
	if (!isRecord(value) || typeof value.type !== "string" || typeof value.now !== "string") return false;
	switch (value.type) {
		case "add_requirement":
			return typeof value.id === "string" && typeof value.text === "string";
		case "satisfy_requirement":
			return typeof value.id === "string" && isStringArray(value.evidenceIds);
		case "block_requirement":
			return typeof value.id === "string" && typeof value.blockedReason === "string";
		case "add_evidence":
			return (
				typeof value.id === "string" &&
				isGoalEvidenceKind(value.kind) &&
				typeof value.summary === "string" &&
				hasOptionalString(value, "uri")
			);
		case "progress":
		case "no_progress":
		case "complete_goal":
		case "cancel_goal":
			return true;
		case "block_goal":
			return typeof value.reason === "string";
		default:
			return false;
	}
}

export function isGoalState(value: unknown): value is GoalState {
	if (!isRecord(value)) return false;
	return (
		typeof value.goalId === "string" &&
		typeof value.userGoal === "string" &&
		isGoalStatus(value.status) &&
		Array.isArray(value.requirements) &&
		value.requirements.every(isRequirement) &&
		Array.isArray(value.evidence) &&
		value.evidence.every(isGoalEvidenceRef) &&
		Array.isArray(value.events) &&
		value.events.every(isGoalEvent) &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		typeof value.lastProgressAt === "string" &&
		typeof value.stallTurns === "number" &&
		hasOptionalString(value, "blockedReason")
	);
}

function cloneRequirement(requirement: Requirement): Requirement {
	return {
		...requirement,
		evidenceIds: [...requirement.evidenceIds],
	};
}

function cloneGoalEvidenceRef(evidence: GoalEvidenceRef): GoalEvidenceRef {
	return { ...evidence };
}

function cloneGoalEvent(event: GoalEvent): GoalEvent {
	if (event.type === "satisfy_requirement") {
		return { ...event, evidenceIds: [...event.evidenceIds] };
	}
	return { ...event };
}

function cloneGoalState(state: GoalState): GoalState {
	return {
		...state,
		requirements: state.requirements.map(cloneRequirement),
		evidence: state.evidence.map(cloneGoalEvidenceRef),
		events: state.events.map(cloneGoalEvent),
	};
}

export function cloneGoalStateForStorage(state: GoalState): GoalState {
	return cloneGoalState(state);
}

export function createGoalState(args: { goalId: string; userGoal: string; now: string }): GoalState {
	return {
		goalId: args.goalId,
		userGoal: args.userGoal,
		status: "active",
		requirements: [],
		evidence: [],
		events: [],
		createdAt: args.now,
		updatedAt: args.now,
		lastProgressAt: args.now,
		stallTurns: 0,
	};
}

export function applyGoalEvent(state: GoalState, event: GoalEvent): GoalState {
	const newState: GoalState = {
		...state,
		requirements: state.requirements.map(cloneRequirement),
		evidence: state.evidence.map(cloneGoalEvidenceRef),
		events: [...state.events.map(cloneGoalEvent), cloneGoalEvent(event)],
		updatedAt: event.now,
	};

	switch (event.type) {
		case "add_requirement": {
			const existingIndex = newState.requirements.findIndex((requirement) => requirement.id === event.id);
			const newRequirement: Requirement = {
				id: event.id,
				text: event.text,
				status: "open",
				evidenceIds: [],
				createdAt: existingIndex >= 0 ? newState.requirements[existingIndex].createdAt : event.now,
				updatedAt: event.now,
			};
			if (existingIndex >= 0) {
				const updatedRequirements = [...newState.requirements];
				updatedRequirements[existingIndex] = newRequirement;
				newState.requirements = updatedRequirements;
			} else {
				newState.requirements = [...newState.requirements, newRequirement];
			}
			break;
		}

		case "satisfy_requirement": {
			const existingIndex = newState.requirements.findIndex((requirement) => requirement.id === event.id);
			if (existingIndex >= 0) {
				const requirement = newState.requirements[existingIndex];
				const updatedRequirements = [...newState.requirements];
				updatedRequirements[existingIndex] = {
					...requirement,
					status: "satisfied",
					evidenceIds: [...event.evidenceIds],
					updatedAt: event.now,
					blockedReason: undefined,
				};
				newState.requirements = updatedRequirements;
			}
			newState.lastProgressAt = event.now;
			newState.stallTurns = 0;
			break;
		}

		case "block_requirement": {
			const existingIndex = newState.requirements.findIndex((requirement) => requirement.id === event.id);
			if (existingIndex >= 0) {
				const requirement = newState.requirements[existingIndex];
				const updatedRequirements = [...newState.requirements];
				updatedRequirements[existingIndex] = {
					...requirement,
					status: "blocked",
					blockedReason: event.blockedReason,
					updatedAt: event.now,
				};
				newState.requirements = updatedRequirements;
			}
			break;
		}

		case "add_evidence": {
			const existingIndex = newState.evidence.findIndex((evidence) => evidence.id === event.id);
			const newEvidence: GoalEvidenceRef = {
				id: event.id,
				kind: event.kind,
				summary: event.summary,
				uri: event.uri,
				createdAt: existingIndex >= 0 ? newState.evidence[existingIndex].createdAt : event.now,
			};
			if (existingIndex >= 0) {
				const updatedEvidence = [...newState.evidence];
				updatedEvidence[existingIndex] = newEvidence;
				newState.evidence = updatedEvidence;
			} else {
				newState.evidence = [...newState.evidence, newEvidence];
			}
			break;
		}

		case "progress": {
			newState.lastProgressAt = event.now;
			newState.stallTurns = 0;
			break;
		}

		case "no_progress": {
			newState.stallTurns = state.stallTurns + 1;
			break;
		}

		case "complete_goal": {
			const hasUnsatisfied = newState.requirements.some((requirement) => requirement.status !== "satisfied");
			if (!hasUnsatisfied) {
				newState.status = "completed";
			}
			break;
		}

		case "block_goal": {
			newState.status = "blocked";
			newState.blockedReason = event.reason;
			break;
		}

		case "cancel_goal": {
			newState.status = "cancelled";
			break;
		}
	}

	return newState;
}

export function shouldContinueGoalLoop(args: { state: GoalState; maxStallTurns: number; now: string }): boolean {
	if (args.state.status !== "active") {
		return false;
	}
	if (args.state.stallTurns >= args.maxStallTurns) {
		return false;
	}
	return true;
}

export function serializeGoalState(state: GoalState): string {
	return JSON.stringify(cloneGoalState(state), null, 2);
}

export function parseGoalState(text: string): GoalState | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isGoalState(parsed)) return undefined;
		return cloneGoalState(parsed);
	} catch {
		return undefined;
	}
}
