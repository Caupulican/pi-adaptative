/**
 * The routine runtime one session holds, by the scope its role gives it (`routine-holder.ts`): built once the session's
 * store is loaded, started with the session's inputs, stopped and joined when the session disposes. A root session holds
 * its own routines and the bot and team routines. A bot's own session (standing `bot`, session-standing.ts) holds only the
 * watches it arms. Any other child session holds none. The scope is fixed when the session is built, so the tool surface
 * built with it offers the session's routine tool from the start.
 */
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import type { WorkerTerminalHandoffRecord } from "../delegation/worker-notification-coordinator.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ToolCallFacts } from "../tool-capability-policy.ts";
import type { SessionWatchView } from "../watches/session-watch-service.ts";
import { createWatchTool } from "../watches/watch-tool.ts";
import type { RoutineScope } from "./routine-holder.ts";
import type { RoutineIntakeStatus } from "./routine-intake.ts";
import type { RoutineRuntime } from "./routine-runtime-assembly.ts";
import type { RoutineTickResult } from "./routine-scheduler-controller.ts";
import { parseRoutineToolInput, type RoutineToolFields, type RoutineToolView } from "./routine-tool.ts";
import { createSessionTaskWatchTool } from "./task-watch-tool.ts";

export interface SessionRoutinesPorts {
	/** What the session's runtime holds, fixed when the session was built; undefined where it holds nothing. */
	scope(): RoutineScope | undefined;
	isDisposed(): boolean;
	/** The session's store, loaded on first use; loading it builds the runtime through {@link SessionRoutines.ensure}. */
	store(): PersistentBotTeamStore;
	assemble(store: PersistentBotTeamStore, scope: RoutineScope): RoutineRuntime;
}

export class SessionRoutines {
	private readonly ports: SessionRoutinesPorts;
	private runtime: RoutineRuntime | undefined;
	private started = false;
	/**
	 * The session's own waits: a root session's `watch`, a bot's own session's `task_watch`. Each reads the runtime at the
	 * call, since the runtime is built with the store.
	 */
	private readonly watchTool = createWatchTool(() => this.loaded()?.watchPort);
	private readonly ownWatchTool = createSessionTaskWatchTool(() => this.loaded()?.watchPort);
	private readonly watchListeners = new Set<() => void>();
	/**
	 * The session's own watches as the operator bar counts them (`core/watches/`): none until the runtime is built, then
	 * its ledger's live watches; a listener hears every change of them and the runtime's building.
	 */
	readonly ownWatches = {
		liveCount: (nowMs: number): number => this.runtime?.sessionWatches.liveCount(nowMs) ?? 0,
		/** Every watch in the ledger, for the session's own status; none until the runtime is built. */
		list: (): SessionWatchView[] => this.runtime?.sessionWatches.list() ?? [],
		/**
		 * The owner's stop of a bot made at `stopAt`, over its own session's watches (`SessionWatchService.endArmedByStop`):
		 * the runtime is built for it, since the ledger holds the session's watches whether or not it ran yet.
		 */
		endArmedByStop: (stopAt: number, carried: (deliveryId: string) => boolean): { ended: number; settled: number } =>
			this.loaded()?.sessionWatches.endArmedByStop(stopAt, carried) ?? { ended: 0, settled: 0 },
		subscribe: (listener: () => void): (() => void) => {
			this.watchListeners.add(listener);
			return () => this.watchListeners.delete(listener);
		},
	};

	constructor(ports: SessionRoutinesPorts) {
		this.ports = ports;
	}

	/** What the session's runtime holds; undefined where it holds nothing (a worker or another child session). */
	scope(): RoutineScope | undefined {
		return this.ports.scope();
	}

	/** The built runtime; undefined until the store is loaded, or where the session holds no routines. */
	get current(): RoutineRuntime | undefined {
		return this.runtime;
	}

	/** Whether the session started its routines (they run, and a save may need the daemon). */
	get isStarted(): boolean {
		return this.started;
	}

	/** Builds the runtime over the loaded store, once; it starts at once when the session already started its routines. */
	ensure(store: PersistentBotTeamStore): void {
		const scope = this.scope();
		if (this.runtime || this.ports.isDisposed() || !scope) return;
		this.runtime = this.ports.assemble(store, scope);
		const tell = () => {
			for (const listener of [...this.watchListeners]) listener();
		};
		this.runtime.sessionWatches.subscribe(tell);
		tell();
		if (this.started) this.startRuntime(this.runtime);
	}

	/** Starts the session's routines; returns the scope they run under, or undefined when the session holds none. */
	start(): RoutineScope | undefined {
		const scope = this.scope();
		if (this.ports.isDisposed() || !scope) return undefined;
		this.started = true;
		const runtime = this.loaded();
		if (runtime) this.startRuntime(runtime);
		return scope;
	}

	private startRuntime(runtime: RoutineRuntime): void {
		runtime.scheduler.start();
		runtime.intake?.start();
		runtime.watches.start();
		runtime.sessionWatches.start();
		runtime.sessionWatchMonitor.start();
		runtime.githubWatchPoller.start();
	}

	/** The runtime over the session's store, loading the store (which builds the runtime) first. */
	private loaded(): RoutineRuntime | undefined {
		this.ensure(this.ports.store());
		return this.runtime;
	}

	/** Whether a worker's terminal notification is a routine run's own input ("separate") or the coordinator's. */
	notificationOwner(record: WorkerTerminalHandoffRecord): "separate" | "coordinator" {
		if (this.scope() !== "session") return "coordinator";
		const runtime = this.loaded();
		if (!runtime) throw new Error("Routine notification owner is unavailable.");
		return runtime.scheduler.ownsNotification(record) ? "separate" : "coordinator";
	}

	/** Automatic routine intake of the session; undefined where it has none (a child session, a bot's own session). */
	intakeStatus(): RoutineIntakeStatus | undefined {
		return this.loaded()?.intake?.status();
	}

	/** Joins the intake pass in flight without stopping it again; builds nothing where no runtime was built. */
	intakeSettled(): Promise<void> {
		return this.runtime?.intake?.settled() ?? Promise.resolve();
	}

	/** The session's routine tools: a root session's `routine` and `watch`; a bot's own session's `task_watch`, for its own waits. */
	tools(): ToolDefinition[] {
		const scope = this.scope();
		if (scope === "session") {
			const tool = this.loaded()?.session.tool;
			return tool ? [tool, this.watchTool] : [];
		}
		return scope === "own-watches" ? [this.ownWatchTool] : [];
	}

	/** What the gate reads about a call's target when the call is the routine tool's (`ToolCallFacts`); else undefined. */
	callFacts(toolName: string, args: unknown): ToolCallFacts | undefined {
		const session = this.runtime?.session;
		return session?.tool.name === toolName ? session.callFacts(args) : undefined;
	}

	/** Saves a routine on the embedding host's own authority (see `BackgroundLaneController.createRoutine`). */
	async createForHost(spec: RoutineToolFields, signal?: AbortSignal): Promise<RoutineToolView> {
		const runtime = this.scope() === "session" ? this.loaded() : undefined;
		if (!runtime) throw new Error("Routines are unavailable in this session.");
		return runtime.session.createForHost(parseRoutineToolInput(spec), signal);
	}

	async tick(routineIdFilter: string | undefined, commandId: string): Promise<RoutineTickResult> {
		const runtime = this.loaded();
		if (!runtime) return { dispatched: [], failed: [] };
		if (routineIdFilter) runtime.scheduler.run(routineIdFilter, undefined, commandId);
		return runtime.scheduler.tick();
	}

	/** Stops the runtime and joins it; nothing to join when none was built. */
	stop(): Promise<void> {
		return this.runtime?.stop() ?? Promise.resolve();
	}
}
