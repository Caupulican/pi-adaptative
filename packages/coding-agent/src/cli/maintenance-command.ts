/**
 * What the maintenance commands share. Their one-line help lives here, apart from the commands, so the argument parser
 * that every launch loads can print it without loading what the commands run on (session history, the decision
 * ledger's database). And a command refuses a request it cannot serve in one line, never as a crash.
 */

import { APP_NAME } from "../config.ts";

export const ACCOUNTING_RECONCILE_HELP =
	"accounting-reconcile [--cwd <path> | --session <file> | --all]  Recover historical accounting without starting a model";

/** The first argument that runs the decision ledger's command. */
export const DECISIONS_COMMAND = "decisions";

export const DECISIONS_HELP =
	"decisions <report [--json] | export --out <file> [--program <id>] [--force]> [--cwd <path> | --all] [--days <n>]  Total the decision ledger, or write its evaluations out as replay cases";

/** A request a command cannot serve as asked: a wrong argument, a file in the way, a store it cannot read. */
export class CommandRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CommandRefusal";
	}
}

/**
 * Runs a maintenance command and answers its exit code. A refusal is said on standard error with the command's usage
 * line and ends with code 1; it is the caller's mistake or the store's state, so it writes no crash record. Any other
 * failure is a defect and is thrown on.
 */
export async function answeringRefusals(help: string, run: () => Promise<void>): Promise<number> {
	try {
		await run();
		return 0;
	} catch (error) {
		if (!(error instanceof CommandRefusal)) throw error;
		console.error(error.message);
		console.error(`Usage: ${APP_NAME} ${help}`);
		return 1;
	}
}
