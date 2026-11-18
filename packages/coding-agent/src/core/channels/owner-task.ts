/** A phone selects one generation of a bot's scheduled task. The routine store owns its state and revision. */

import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { routineJobStatusLines } from "../remote/routine-job-results.ts";
import { isRoutineId, type RoutineDefinitionView, routineScheduleInputOf } from "../routines/routine-contract.ts";
import { cleanRedactBound } from "../security/secret-text.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export interface OwnerTask {
	readonly bot: string;
	readonly routine: string;
	readonly incarnation: string;
}

export type OwnerTaskAction =
	| { readonly kind: "select"; readonly bot: string; readonly routine: string }
	| { readonly kind: "unselect" | "taskStop" | "taskStatus" }
	| { readonly kind: "steer"; readonly words: string }
	| { readonly kind: "taskHelp" };

export function parseTaskAction(text: string): OwnerTaskAction | undefined {
	const [verb, ...args] = text.trim().split(/\s+/);
	switch (verb?.toLowerCase()) {
		case "select":
			if (args.length === 2 && args.every(isRoutineId)) return { kind: "select", bot: args[0]!, routine: args[1]! };
			return { kind: "taskHelp" };
		case "steer": {
			const words = text.trim().slice(verb.length).trim();
			return words.length > 0 ? { kind: "steer", words } : { kind: "taskHelp" };
		}
		case "unselect":
			return args.length === 0 ? { kind: "unselect" } : { kind: "taskHelp" };
		case "stop":
			return args.length === 1 && args[0]?.toLowerCase() === "task" ? { kind: "taskStop" } : undefined;
		case "task":
			return args.length === 1 && args[0]?.toLowerCase() === "status"
				? { kind: "taskStatus" }
				: { kind: "taskHelp" };
		default:
			return undefined;
	}
}

export function isOwnerTask(value: unknown): value is OwnerTask {
	return (
		isPlainRecord(value) &&
		typeof value.bot === "string" &&
		isRoutineId(value.bot) &&
		typeof value.routine === "string" &&
		isRoutineId(value.routine) &&
		typeof value.incarnation === "string" &&
		value.incarnation.length > 0 &&
		value.incarnation.length <= 200
	);
}

export interface OwnerTaskPort {
	getBotTeamStore(): PersistentBotTeamStore;
	routineAwayReader(): (routine: RoutineDefinitionView) => string;
}

export const OWNER_TASK_HELP =
	"Select a bot's scheduled task with select <bot-id> <routine-id>. Then use status, steer <instructions>, stop task, or unselect.";
export const OWNER_TASK_GONE = "This scheduled task is unavailable for that bot. Select its current task again.";

export function readOwnerTask(store: PersistentBotTeamStore, bot: string, id: string, incarnation?: string) {
	const routine = store.getRoutine(id);
	if (
		routine?.target.kind !== "bot" ||
		routine.target.agentId !== bot ||
		(incarnation !== undefined && routine.incarnationId !== incarnation)
	)
		return undefined;
	const record = store.getBot(bot);
	return record && !record.retired && !record.remote ? routine : undefined;
}

export function taskStatus(port: OwnerTaskPort, task: OwnerTask): string {
	const routine = readOwnerTask(port.getBotTeamStore(), task.bot, task.routine, task.incarnation);
	if (!routine) return OWNER_TASK_GONE;
	const when = !routine.enabled
		? "Paused"
		: routine.schedule.kind === "event"
			? "Waiting for an event"
			: Number.isFinite(routine.nextRunAt)
				? `Next scheduled slot ${new Date(routine.nextRunAt).toISOString()}`
				: "No further slot";
	return [
		`Bot ${task.bot} · task ${task.routine}`,
		when,
		port.routineAwayReader()(routine),
		...routineJobStatusLines(port.getBotTeamStore(), routine),
		routine.lastStatus && `Last run ${routine.lastStatus}`,
		routine.lastSummary && cleanRedactBound(routine.lastSummary, 500),
	]
		.filter(Boolean)
		.join("\n");
}

/** A replay never pauses a schedule the desktop has since re-enabled or replaced. */
export function stopTask(
	store: PersistentBotTeamStore,
	task: OwnerTask,
	revision: number,
): { paused: boolean; reply: string } {
	const routine = readOwnerTask(store, task.bot, task.routine, task.incarnation);
	if (!routine) return { paused: false, reply: OWNER_TASK_GONE };
	if (routine.enabled) {
		if (routine.revision !== revision)
			return {
				paused: false,
				reply: "The schedule changed before the stop. Check status and send stop task again.",
			};
		store.upsertRoutine({
			routineId: routine.routineId,
			target: routine.target,
			expectedRevision: revision,
			prompt: routine.prompt,
			schedule: routineScheduleInputOf(routine.schedule),
			enabled: false,
		});
	}
	return { paused: true, reply: `Paused task ${task.routine} on bot ${task.bot}. Pending dispatches are cancelled.` };
}

/** The immutable address and admission of a command, kept until its bot or routine store settles it. */
export interface OwnerTaskCommand {
	readonly id: string;
	readonly selection: OwnerTask;
	readonly sender: string;
	readonly conversation: string;
	readonly address: string;
	readonly admittedAt: number;
	readonly policyHash: string;
	readonly cwd: string;
	readonly revision: number;
	readonly action: "steer" | "stop";
	readonly occurrenceIds: readonly string[];
	readonly refs?: readonly string[];
	readonly words?: string;
	anchor?: string | null;
	state: "pending" | "queued" | "running" | "finished";
	reply?: string;
	settledAt?: number;
	/** The channel obtained a new holder while the bot was waiting for it. */
	resignal?: true;
	stopRequested?: true;
	terminalDraft?: string;
	/** The owner pool reserves the per-turn ceiling until the run settles. */
	spend?: { readonly reserved: number; usd: number };
}

export const MAX_PHONE_TASK_COMMANDS = 32;
export function isTaskCommand(v: unknown): v is OwnerTaskCommand {
	if (!isPlainRecord(v)) return false;
	return (
		typeof v.id === "string" &&
		/^[a-f0-9]{64}$/.test(v.id) &&
		isOwnerTask(v.selection) &&
		typeof v.sender === "string" &&
		typeof v.conversation === "string" &&
		typeof v.address === "string" &&
		typeof v.cwd === "string" &&
		v.cwd.length > 0 &&
		typeof v.policyHash === "string" &&
		/^[a-f0-9]{64}$/.test(v.policyHash) &&
		Number.isSafeInteger(v.admittedAt) &&
		Number.isSafeInteger(v.revision) &&
		(v.action === "stop" || (v.action === "steer" && typeof v.words === "string")) &&
		["pending", "queued", "running", "finished"].includes(String(v.state)) &&
		Array.isArray(v.occurrenceIds) &&
		v.occurrenceIds.length <= 256 &&
		v.occurrenceIds.every((id) => typeof id === "string") &&
		(v.refs === undefined ||
			(Array.isArray(v.refs) && v.refs.length <= 300 && v.refs.every((ref) => typeof ref === "string"))) &&
		(v.anchor === undefined || v.anchor === null || typeof v.anchor === "string") &&
		(v.resignal === undefined || v.resignal === true) &&
		(v.stopRequested === undefined || v.stopRequested === true) &&
		(v.terminalDraft === undefined ||
			(typeof v.terminalDraft === "string" && /^draft-[a-f0-9]{16}$/.test(v.terminalDraft))) &&
		(v.settledAt === undefined || Number.isSafeInteger(v.settledAt)) &&
		(v.reply === undefined || typeof v.reply === "string") &&
		(v.spend === undefined ||
			(isPlainRecord(v.spend) &&
				typeof v.spend.reserved === "number" &&
				Number.isFinite(v.spend.reserved) &&
				v.spend.reserved >= 0 &&
				typeof v.spend.usd === "number" &&
				Number.isFinite(v.spend.usd) &&
				v.spend.usd >= 0))
	);
}

/** The channel event is one bot turn across every host that recovers its inbox. */
export function phoneCommandRef(id: string): string {
	return `task-${id.slice(0, 32)}`;
}
