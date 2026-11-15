/**
 * What the owner was told of the work a bot's stop or release left behind a symbolic link (`botLinkedSessionsJobsLeft`,
 * `botReleaseWorkersLeft`): told once per operation and paths, however often the operation runs again. A release that
 * failed is owed and runs whole again after a backoff, and a stop that failed is taken again, each reaching the same
 * links each time; the sentence is told only when the operation (a release, or the stop made at a time) or the paths
 * changed. One operation of each kind is kept per bot: a newer stop replaces the older one's record. A release's record
 * ends once it finished or the bot is back on the session path, a stop's once a take applied it.
 *
 * Kept by the process for its agent directory across its bot session hosts (`bot-session-registry.ts`): a root session
 * replaced by a new, resumed or forked one stops its host before the next one starts, and a host's own memory would tell
 * the retry again.
 */

/** The run of a stop or a release a link notice belongs to: a release of the bot, or the owner's stop made at `at`. */
export type LinkedSessionOperation = { readonly kind: "release" } | { readonly kind: "stop"; readonly at: number };

/** A release of the bot, as its link notices are kept. */
export const RELEASE_OPERATION: LinkedSessionOperation = { kind: "release" };

/** The owner's stop made at `at`, as its link notices are kept. */
export function stopOperation(at: number): LinkedSessionOperation {
	return { kind: "stop", at };
}

/** Which sentence a link notice is: the jobs its links placed left, or the workers of a linked saved session left. */
export type LinkedSessionNotice = "jobs" | "workers";

/** What one operation of a bot told: its id, and each notice with its sorted paths. */
interface ToldOperation {
	readonly id: string;
	readonly told: Set<string>;
}

export class LinkedSessionNotices {
	private readonly byBot = new Map<string, Map<LinkedSessionOperation["kind"], ToldOperation>>();

	/**
	 * Tells `sentence` through `warn` unless this notice was told already for the same operation and the same `paths`
	 * (in any order); a newer operation of the same kind replaces what the older one told.
	 */
	tell(
		agentId: string,
		operation: LinkedSessionOperation,
		notice: LinkedSessionNotice,
		paths: readonly string[],
		sentence: string,
		warn: (message: string) => void,
	): void {
		const id = operation.kind === "stop" ? String(operation.at) : operation.kind;
		const operations = this.byBot.get(agentId) ?? new Map<LinkedSessionOperation["kind"], ToldOperation>();
		this.byBot.set(agentId, operations);
		let told = operations.get(operation.kind);
		if (told?.id !== id) {
			told = { id, told: new Set() };
			operations.set(operation.kind, told);
		}
		const key = `${notice}\0${[...paths].sort().join("\0")}`;
		if (told.told.has(key)) return;
		told.told.add(key);
		warn(sentence);
	}

	/** The bot's operation of `kind` finished: a later one tells its notices again. */
	done(agentId: string, kind: LinkedSessionOperation["kind"]): void {
		const operations = this.byBot.get(agentId);
		if (!operations?.delete(kind) || operations.size > 0) return;
		this.byBot.delete(agentId);
	}
}
