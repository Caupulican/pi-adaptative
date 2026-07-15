export const TASK_STEP_STATUSES = ["pending", "in_progress", "completed", "blocked", "cancelled"] as const;
export type TaskStepStatus = (typeof TASK_STEP_STATUSES)[number];

export const TASK_STEP_PRIORITIES = ["low", "normal", "high"] as const;
export type TaskStepPriority = (typeof TASK_STEP_PRIORITIES)[number];

export const MAX_TASK_STEPS = 100;
export const MAX_TASK_STEP_CONTENT_LENGTH = 2_000;
const MAX_TASK_STEP_NOTE_LENGTH = 4_000;
const MAX_TASK_STEP_OWNER_LENGTH = 200;
const MAX_TASK_STEP_EVIDENCE = 32;
const MAX_TASK_STEP_EVIDENCE_LENGTH = 2_000;

export interface TaskStepInput {
	content: string;
	activeForm?: string;
	status?: TaskStepStatus;
	priority?: TaskStepPriority;
	owner?: string;
	note?: string;
	notes?: readonly string[];
	evidence?: readonly string[];
}

export interface TaskStep {
	id: string;
	content: string;
	activeForm?: string;
	status: TaskStepStatus;
	priority?: TaskStepPriority;
	owner?: string;
	notes: readonly string[];
	evidence: readonly string[];
	createdAt: string;
	updatedAt: string;
}

export interface TaskStepsArchive {
	completed: number;
	cancelled: number;
	compactedAt?: string;
}

export interface TaskStepsState {
	version: 1;
	revision: number;
	nextStepNumber: number;
	steps: readonly TaskStep[];
	archive: TaskStepsArchive;
	createdAt: string;
	updatedAt: string;
}

export interface TaskStepUpdate {
	content?: string;
	activeForm?: string;
	status?: TaskStepStatus;
	priority?: TaskStepPriority;
	owner?: string;
	note?: string;
	evidence?: readonly string[];
}

export class TaskStepsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskStepsError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isTaskStepStatus(value: unknown): value is TaskStepStatus {
	return TASK_STEP_STATUSES.some((status) => status === value);
}

function isTaskStepPriority(value: unknown): value is TaskStepPriority {
	return TASK_STEP_PRIORITIES.some((priority) => priority === value);
}

function hasOptionalString(record: Record<string, unknown>, key: string, maxLength: number): boolean {
	const value = record[key];
	return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function isBoundedStringArray(value: unknown, maxItems: number, maxLength: number): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.length <= maxItems &&
		value.every((item) => typeof item === "string" && item.length > 0 && item.length <= maxLength)
	);
}

function isTaskStep(value: unknown): value is TaskStep {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		/^step-[1-9]\d*$/.test(value.id) &&
		typeof value.content === "string" &&
		value.content.length > 0 &&
		value.content.length <= MAX_TASK_STEP_CONTENT_LENGTH &&
		hasOptionalString(value, "activeForm", MAX_TASK_STEP_CONTENT_LENGTH) &&
		isTaskStepStatus(value.status) &&
		(value.priority === undefined || isTaskStepPriority(value.priority)) &&
		hasOptionalString(value, "owner", MAX_TASK_STEP_OWNER_LENGTH) &&
		isBoundedStringArray(value.notes, MAX_TASK_STEP_EVIDENCE, MAX_TASK_STEP_NOTE_LENGTH) &&
		isBoundedStringArray(value.evidence, MAX_TASK_STEP_EVIDENCE, MAX_TASK_STEP_EVIDENCE_LENGTH) &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string"
	);
}

function isTaskStepsArchive(value: unknown): value is TaskStepsArchive {
	if (!isRecord(value)) return false;
	return (
		Number.isInteger(value.completed) &&
		Number(value.completed) >= 0 &&
		Number.isInteger(value.cancelled) &&
		Number(value.cancelled) >= 0 &&
		hasOptionalString(value, "compactedAt", 100)
	);
}

export function isTaskStepsState(value: unknown): value is TaskStepsState {
	if (!isRecord(value)) return false;
	if (
		value.version !== 1 ||
		!Number.isInteger(value.revision) ||
		Number(value.revision) < 0 ||
		!Number.isInteger(value.nextStepNumber) ||
		Number(value.nextStepNumber) < 1 ||
		!Array.isArray(value.steps) ||
		value.steps.length > MAX_TASK_STEPS ||
		!value.steps.every(isTaskStep) ||
		!isTaskStepsArchive(value.archive) ||
		typeof value.createdAt !== "string" ||
		typeof value.updatedAt !== "string"
	) {
		return false;
	}
	const ids = new Set(value.steps.map((step) => step.id));
	return ids.size === value.steps.length && value.steps.filter((step) => step.status === "in_progress").length <= 1;
}

function cloneTaskStep(step: TaskStep): TaskStep {
	return { ...step, notes: [...step.notes], evidence: [...step.evidence] };
}

export function cloneTaskStepsState(state: TaskStepsState): TaskStepsState {
	return {
		...state,
		steps: state.steps.map(cloneTaskStep),
		archive: { ...state.archive },
	};
}

export function createTaskStepsState(now: string): TaskStepsState {
	return {
		version: 1,
		revision: 0,
		nextStepNumber: 1,
		steps: [],
		archive: { completed: 0, cancelled: 0 },
		createdAt: now,
		updatedAt: now,
	};
}

function requireBoundedText(value: string, label: string, maxLength: number): string {
	const normalized = value.trim();
	if (!normalized) throw new TaskStepsError(`${label} is required.`);
	if (normalized.length > maxLength) throw new TaskStepsError(`${label} must be at most ${maxLength} characters.`);
	return normalized;
}

function optionalBoundedText(value: string | undefined, label: string, maxLength: number): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	if (normalized.length > maxLength) throw new TaskStepsError(`${label} must be at most ${maxLength} characters.`);
	return normalized;
}

function normalizeStrings(values: readonly string[] | undefined, label: string, maxLength: number): string[] {
	if (!values) return [];
	const normalized: string[] = [];
	for (const value of values) {
		const item = requireBoundedText(value, label, maxLength);
		if (!normalized.includes(item)) normalized.push(item);
	}
	if (normalized.length > MAX_TASK_STEP_EVIDENCE) {
		throw new TaskStepsError(`${label} supports at most ${MAX_TASK_STEP_EVIDENCE} entries.`);
	}
	return normalized;
}

function appendUniqueStrings(
	current: readonly string[],
	values: readonly string[] | undefined,
	label: string,
	maxLength: number,
): string[] {
	const appended = [...current];
	for (const value of normalizeStrings(values, label, maxLength)) {
		if (!appended.includes(value)) appended.push(value);
	}
	if (appended.length > MAX_TASK_STEP_EVIDENCE) {
		throw new TaskStepsError(`${label} supports at most ${MAX_TASK_STEP_EVIDENCE} entries.`);
	}
	return appended;
}

function normalizeInputNotes(input: TaskStepInput): string[] {
	const notes = normalizeStrings(input.notes, "Task step note", MAX_TASK_STEP_NOTE_LENGTH);
	const note = optionalBoundedText(input.note, "Task step note", MAX_TASK_STEP_NOTE_LENGTH);
	if (note && !notes.includes(note)) notes.push(note);
	return notes;
}

function demoteOtherActiveSteps(steps: TaskStep[], activeIndex: number): void {
	for (let index = 0; index < steps.length; index++) {
		if (index !== activeIndex && steps[index].status === "in_progress") {
			steps[index] = { ...steps[index], status: "pending" };
		}
	}
}

function nextState(state: TaskStepsState, steps: readonly TaskStep[], now: string): TaskStepsState {
	return {
		...state,
		revision: state.revision + 1,
		steps: steps.map(cloneTaskStep),
		archive: { ...state.archive },
		updatedAt: now,
	};
}

function createStep(args: {
	input: TaskStepInput;
	id: string;
	createdAt: string;
	updatedAt: string;
	existing?: TaskStep;
}): TaskStep {
	const existing = args.existing;
	const notes =
		args.input.note === undefined && args.input.notes === undefined
			? [...(existing?.notes ?? [])]
			: normalizeInputNotes(args.input);
	const evidence =
		args.input.evidence === undefined
			? [...(existing?.evidence ?? [])]
			: normalizeStrings(args.input.evidence, "Task step evidence", MAX_TASK_STEP_EVIDENCE_LENGTH);
	return {
		id: args.id,
		content: requireBoundedText(args.input.content, "Task step content", MAX_TASK_STEP_CONTENT_LENGTH),
		activeForm:
			args.input.activeForm === undefined
				? existing?.activeForm
				: optionalBoundedText(args.input.activeForm, "Task step active form", MAX_TASK_STEP_CONTENT_LENGTH),
		status: args.input.status ?? existing?.status ?? "pending",
		priority: args.input.priority ?? existing?.priority,
		owner:
			args.input.owner === undefined
				? existing?.owner
				: optionalBoundedText(args.input.owner, "Task step owner", MAX_TASK_STEP_OWNER_LENGTH),
		notes,
		evidence,
		createdAt: args.createdAt,
		updatedAt: args.updatedAt,
	};
}

export function setTaskSteps(state: TaskStepsState, inputs: readonly TaskStepInput[], now: string): TaskStepsState {
	if (inputs.length > MAX_TASK_STEPS) {
		throw new TaskStepsError(`Task steps supports at most ${MAX_TASK_STEPS} steps.`);
	}
	const existingByContent = new Map<string, TaskStep[]>();
	for (const step of state.steps) {
		const key = step.content.toLocaleLowerCase();
		const matches = existingByContent.get(key) ?? [];
		matches.push(step);
		existingByContent.set(key, matches);
	}

	let nextStepNumber = state.nextStepNumber;
	const steps = inputs.map((input) => {
		const content = requireBoundedText(input.content, "Task step content", MAX_TASK_STEP_CONTENT_LENGTH);
		const matches = existingByContent.get(content.toLocaleLowerCase());
		const existing = matches?.shift();
		const id = existing?.id ?? `step-${nextStepNumber++}`;
		return createStep({
			input: { ...input, content },
			id,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			existing,
		});
	});
	const activeIndex = steps.findLastIndex((step) => step.status === "in_progress");
	if (activeIndex >= 0) demoteOtherActiveSteps(steps, activeIndex);
	return { ...nextState(state, steps, now), nextStepNumber };
}

export function addTaskStep(state: TaskStepsState, input: TaskStepInput, now: string): TaskStepsState {
	if (state.steps.length >= MAX_TASK_STEPS) {
		throw new TaskStepsError(`Task steps already has the maximum ${MAX_TASK_STEPS} steps.`);
	}
	const step = createStep({ input, id: `step-${state.nextStepNumber}`, createdAt: now, updatedAt: now });
	const steps = [...state.steps.map(cloneTaskStep), step];
	if (step.status === "in_progress") demoteOtherActiveSteps(steps, steps.length - 1);
	return { ...nextState(state, steps, now), nextStepNumber: state.nextStepNumber + 1 };
}

export function resolveTaskStepSelector(steps: readonly TaskStep[], selector: string): TaskStep {
	const normalized = selector.trim().toLocaleLowerCase();
	if (!normalized) throw new TaskStepsError("Task step selector is required.");
	if (normalized === "current" || normalized === "active") {
		const active = steps.find((step) => step.status === "in_progress");
		if (!active) throw new TaskStepsError("No in_progress task step was found.");
		return active;
	}

	const exactId = steps.find((step) => step.id.toLocaleLowerCase() === normalized);
	if (exactId) return exactId;
	const idPrefix = steps.filter((step) => step.id.toLocaleLowerCase().startsWith(normalized));
	if (idPrefix.length === 1) return idPrefix[0];
	if (idPrefix.length > 1) {
		throw new TaskStepsError(`Task step selector is ambiguous: ${idPrefix.map((step) => step.id).join(", ")}.`);
	}

	const exactContent = steps.filter((step) => step.content.toLocaleLowerCase() === normalized);
	if (exactContent.length === 1) return exactContent[0];
	const contentMatches = steps.filter((step) => step.content.toLocaleLowerCase().includes(normalized));
	if (contentMatches.length === 1) return contentMatches[0];
	if (exactContent.length > 1 || contentMatches.length > 1) {
		const matches = exactContent.length > 1 ? exactContent : contentMatches;
		throw new TaskStepsError(`Task step selector is ambiguous: ${matches.map((step) => step.id).join(", ")}.`);
	}
	throw new TaskStepsError(`Task step not found for selector: ${selector}.`);
}

export function updateTaskStep(
	state: TaskStepsState,
	selector: string,
	update: TaskStepUpdate,
	now: string,
): TaskStepsState {
	const selected = resolveTaskStepSelector(state.steps, selector);
	const selectedIndex = state.steps.findIndex((step) => step.id === selected.id);
	const steps = state.steps.map(cloneTaskStep);
	const current = steps[selectedIndex];
	const note = optionalBoundedText(update.note, "Task step note", MAX_TASK_STEP_NOTE_LENGTH);
	const notes = note
		? appendUniqueStrings(current.notes, [note], "Task step note", MAX_TASK_STEP_NOTE_LENGTH)
		: [...current.notes];
	const evidence = appendUniqueStrings(
		current.evidence,
		update.evidence,
		"Task step evidence",
		MAX_TASK_STEP_EVIDENCE_LENGTH,
	);
	steps[selectedIndex] = {
		...current,
		content:
			update.content === undefined
				? current.content
				: requireBoundedText(update.content, "Task step content", MAX_TASK_STEP_CONTENT_LENGTH),
		activeForm:
			update.activeForm === undefined
				? current.activeForm
				: optionalBoundedText(update.activeForm, "Task step active form", MAX_TASK_STEP_CONTENT_LENGTH),
		status: update.status ?? current.status,
		priority: update.priority ?? current.priority,
		owner:
			update.owner === undefined
				? current.owner
				: optionalBoundedText(update.owner, "Task step owner", MAX_TASK_STEP_OWNER_LENGTH),
		notes,
		evidence,
		updatedAt: now,
	};
	if (steps[selectedIndex].status === "in_progress") demoteOtherActiveSteps(steps, selectedIndex);
	return nextState(state, steps, now);
}

export function clearTaskSteps(state: TaskStepsState, now: string): TaskStepsState {
	return {
		...nextState(state, [], now),
		archive: { completed: 0, cancelled: 0 },
	};
}

export function compactTaskSteps(state: TaskStepsState, now: string): TaskStepsState {
	const completed = state.steps.filter((step) => step.status === "completed").length;
	const cancelled = state.steps.filter((step) => step.status === "cancelled").length;
	const open = state.steps.filter((step) => step.status !== "completed" && step.status !== "cancelled");
	return {
		...nextState(state, open, now),
		archive: {
			completed: state.archive.completed + completed,
			cancelled: state.archive.cancelled + cancelled,
			compactedAt: now,
		},
	};
}

export function formatTaskSteps(
	state: TaskStepsState,
	options: { includeTerminal?: boolean; maxItems?: number } = {},
): string {
	const visible = options.includeTerminal
		? state.steps
		: state.steps.filter((step) => step.status !== "completed" && step.status !== "cancelled");
	const maxItems = Math.max(1, Math.min(MAX_TASK_STEPS, Math.floor(options.maxItems ?? 20)));
	const statusMarker: Record<TaskStepStatus, string> = {
		pending: " ",
		in_progress: ">",
		completed: "x",
		blocked: "!",
		cancelled: "-",
	};
	const lines = [`Task steps (${visible.length} visible, ${state.steps.length} tracked):`];
	for (const step of visible.slice(0, maxItems)) {
		const details = [step.priority, step.owner].filter(Boolean).join(", ");
		lines.push(
			`- [${statusMarker[step.status]}] ${step.id} ${step.activeForm || step.content}${details ? ` (${details})` : ""}`,
		);
		for (const note of step.notes.slice(-2)) lines.push(`  note: ${note}`);
		for (const evidence of step.evidence.slice(-2)) lines.push(`  evidence: ${evidence}`);
	}
	if (visible.length > maxItems) lines.push(`- … ${visible.length - maxItems} more`);
	if (state.archive.completed || state.archive.cancelled) {
		lines.push(
			`Archived terminal steps: ${state.archive.completed} completed, ${state.archive.cancelled} cancelled.`,
		);
	}
	return lines.join("\n");
}

export function formatTaskStepsContext(state: TaskStepsState, maxItems = 12): string | undefined {
	const open = state.steps.filter((step) => step.status !== "completed" && step.status !== "cancelled");
	if (open.length === 0) return undefined;
	const limit = Math.max(1, Math.min(MAX_TASK_STEPS, Math.floor(maxItems)));
	const lines = [
		"Current native task_steps context for this session:",
		"Open task_steps:",
		...open.slice(0, limit).map((step) => `- [${step.status}] ${step.activeForm || step.content}`),
	];
	if (open.length > limit) lines.push(`- … ${open.length - limit} more open step(s)`);
	const active = open.find((step) => step.status === "in_progress");
	lines.push(
		"",
		active
			? `Continue the in_progress step first: ${active.activeForm || active.content}. Update it completed, blocked, or cancelled as soon as evidence is known.`
			: `No step is in_progress. Start the first open step before unrelated work: ${open[0].activeForm || open[0].content}.`,
		"Use task_steps to keep this checklist current and leave no stale in_progress step before the final response.",
	);
	return lines.join("\n");
}

export function serializeTaskStepsState(state: TaskStepsState): string {
	return JSON.stringify(cloneTaskStepsState(state), null, 2);
}

export function parseTaskStepsState(text: string): TaskStepsState | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		return isTaskStepsState(parsed) ? cloneTaskStepsState(parsed) : undefined;
	} catch {
		return undefined;
	}
}
