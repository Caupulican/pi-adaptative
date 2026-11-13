/**
 * The bot roster as the owner reads it: the store's bots projected with the live state of their workers and lanes, a
 * machine joined over the link speaking for itself, and, for the bots that run as sessions of their own, the state of that
 * session in the owner's direct conversation (a running turn or queued input is working, whatever the worker lanes say)
 * and the watches that session holds.
 * The TUI reads the roster on every render frame, so it is projected once and served until an input reports a change: a
 * bot-store save (a watch armed, fired or ended among them), a lane or orchestration change, a bot session's state change,
 * or a binding change drops it
 * (`invalidate`). Reading it never constructs the worker runtime for a session that has no worker state.
 */
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import type { BotRuntimeBindings } from "../delegation/bot-runtime-bindings.ts";
import {
	type PersistentBotTeamStore,
	type PersistentBotView,
	teamIncarnation,
} from "../delegation/persistent-bot-team-store.ts";
import type { WorkerAgentView } from "../delegation/worker-agent-control.ts";
import type { RemoteRosterWords } from "../remote/remote-jobs.ts";
import type { BotSessionHost, BotSessionState } from "./bot-session-host.ts";

/** What the roster reads from the coordinator. */
export interface BotRosterHost {
	store(): PersistentBotTeamStore;
	bindings(): Pick<BotRuntimeBindings, "revision" | "generationContext" | "alias">;
	isDelegateToolActive(): boolean;
	hasWorkerState(): boolean;
	listWorkerAgents(): WorkerAgentView[];
	/** The lane records the projection reads; reading them never constructs the worker runtime. */
	laneRecords(): LaneRecord[];
	/** What a machine joined over the link says of itself (connected, its jobs, its room). */
	remoteWords(agentId: string): RemoteRosterWords;
	/** The bots' own sessions: a bot's session state (`stateOf`) and the live watches its session holds (`liveWatches`). */
	readonly botSessions: Pick<BotSessionHost, "stateOf" | "liveWatches">;
}

/** A session's running turn or queued input outranks an idle projection; a worker still running outranks an idle session. */
function withSessionState(view: PersistentBotView, state: BotSessionState | undefined): PersistentBotView {
	if (state === undefined || view.state === "retired") return view;
	if (state === "running" && view.state !== "running") return { ...view, state };
	if (state === "queued" && view.state !== "running" && view.state !== "queued") return { ...view, state };
	return view;
}

/**
 * The bot's own session: its state here and the watches it holds. Only a saved bot has a home and a session of its own, and
 * a retired bot's watches went with it.
 */
function withOwnSession(view: PersistentBotView, host: BotRosterHost): PersistentBotView {
	const projected = withSessionState(view, host.botSessions.stateOf(view.agentId));
	const watchCount = view.persistent && view.state !== "retired" ? host.botSessions.liveWatches(view.agentId) : 0;
	return watchCount > 0 ? { ...projected, watchCount } : projected;
}

export class BotRoster {
	private readonly host: BotRosterHost;
	private cached:
		| { defaultModelRef: string; delegateActive: boolean; bindings: object; views: PersistentBotView[] }
		| undefined;

	constructor(host: BotRosterHost) {
		this.host = host;
	}

	/** Drops the projection: an input changed under it. */
	invalidate(): void {
		this.cached = undefined;
	}

	/** The roster of every bot, or, with `teamId`, of the group's members in that group's conversations. */
	list(defaultModelRef: string, teamId?: string): PersistentBotView[] {
		const delegateActive = this.host.isDelegateToolActive();
		const bindings = this.host.bindings();
		const revision = bindings.revision();
		const cached = teamId ? undefined : this.cached;
		const store = this.host.store();
		const team = teamId ? store.getTeam(teamId) : undefined;
		const inContext = (runtime: string) => {
			const context = bindings.generationContext(runtime);
			return (
				context.teamId === teamId &&
				(!teamId || context.teamIncarnationId === (team ? teamIncarnation(team) : undefined))
			);
		};
		if (
			cached &&
			cached.defaultModelRef === defaultModelRef &&
			cached.delegateActive === delegateActive &&
			cached.bindings === revision
		) {
			return [...cached.views];
		}
		let liveAgents: WorkerAgentView[] = [];
		if (this.host.hasWorkerState() && delegateActive) {
			try {
				liveAgents = this.host.listWorkerAgents();
			} catch {
				liveAgents = [];
			}
		}
		const projected = store.projectBotViews(
			liveAgents
				.filter((agent) => inContext(agent.agentId))
				.flatMap((agent) => {
					const alias = bindings.alias(agent.agentId);
					return alias ? [{ ...agent, agentId: alias }] : [];
				}),
			this.host
				.laneRecords()
				.filter((record) => inContext(record.agentId ?? record.laneId))
				.flatMap((record) => {
					const alias = bindings.alias(record.agentId ?? record.laneId);
					return alias ? [{ ...record, agentId: alias }] : [];
				}),
			defaultModelRef,
			teamId === undefined,
		);
		// A machine joined over the link speaks from facts; a local bot's state comes from its lanes and its own session.
		const views = projected.map((view) =>
			view.remote && view.state !== "retired"
				? { ...view, ...this.host.remoteWords(view.agentId) }
				: teamId === undefined
					? withOwnSession(view, this.host)
					: view,
		);
		if (!teamId) this.cached = { defaultModelRef, delegateActive, bindings: revision, views };
		return teamId ? views.filter((view) => team?.memberAgentIds.includes(view.agentId)) : [...views];
	}
}
