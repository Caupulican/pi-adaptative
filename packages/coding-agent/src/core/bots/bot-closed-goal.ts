/**
 * The goal a bot's session held when it last closed (`BotOwedWork.closed`): its load took the goal up and its continuation
 * ended without it, so that goal does not open the session again, in this process or one that starts later (a daemon
 * started again, a root). Another goal, a later revision of it (`SavedGoal.key`) or another instance of the session file
 * (its header's creation time, `botSessionInstance`) does. Kept in the bot's home (`botClosedGoalFile`), written
 * whole and atomically; a mark the home refused is held in this process, which reads it until a later close writes one,
 * and the caller tells the refusal.
 */

import { readFileSync, rmSync } from "node:fs";
import { isPlainRecord } from "../../kernel/utils/value-guards.ts";
import { botClosedGoalFile } from "../agent-paths.ts";
import { isMissingFileError, writeFileAtomicSync } from "../util/atomic-file.ts";

/** A closed goal: the session file instance that held it and the goal's identity. */
export interface ClosedGoalMark {
	readonly instance: string;
	readonly goal: string;
}

/** The closed goals of a directory's bots, as their homes hold them. */
export class BotClosedGoals {
	/** The marks (or their removal, `null`) this process could not write, by bot. */
	private readonly unwritten = new Map<string, ClosedGoalMark | null>();

	private readonly agentDir: () => string;

	constructor(agentDir: () => string) {
		this.agentDir = agentDir;
	}

	/** Records the bot's closed goal, none removing it; throws when its home refuses the write, the mark held here. */
	mark(agentId: string, mark: ClosedGoalMark | undefined): void {
		const file = this.file(agentId);
		try {
			if (mark) writeFileAtomicSync(file, `${JSON.stringify({ version: 1, ...mark })}\n`, { mode: 0o600 });
			else rmSync(file, { force: true });
			this.unwritten.delete(agentId);
		} catch (error) {
			this.unwritten.set(agentId, mark ?? null);
			throw error;
		}
	}

	/**
	 * Whether the bot's session closed holding goal `goal` of its file instance `instance`. Throws when its mark does not
	 * read or parse.
	 */
	holds(agentId: string, instance: string, goal: string): boolean {
		const mark = this.unwritten.has(agentId) ? this.unwritten.get(agentId) : this.read(agentId);
		return mark?.instance === instance && mark.goal === goal;
	}

	/** The bot was released: a mark this process holds unwritten is dropped; its home's mark stays with its home. */
	forget(agentId: string): void {
		this.unwritten.delete(agentId);
	}

	private read(agentId: string): ClosedGoalMark | undefined {
		const file = this.file(agentId);
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			if (isMissingFileError(error)) return undefined;
			throw error;
		}
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			throw new Error(`${file}: the closed goal mark does not parse.`, { cause: error });
		}
		if (
			!isPlainRecord(value) ||
			value.version !== 1 ||
			typeof value.instance !== "string" ||
			typeof value.goal !== "string"
		)
			throw new Error(`${file}: not a closed goal mark (version 1, instance, goal).`);
		return { instance: value.instance, goal: value.goal };
	}

	private file(agentId: string): string {
		return botClosedGoalFile(this.agentDir(), agentId);
	}
}
