import type { AgentSession } from "../core/agent-session.ts";
import type { ActiveSessionContext, AgentSessionRuntimeResource } from "../core/agent-session-runtime.ts";
import type { HostEventSink, HostEventSource } from "../core/events/host-event-contract.ts";

export interface HostEventSessionBinding {
	readonly sink: HostEventSink;
	/** Fence this binding and join its admitted mutations and delivery work. */
	close(): Promise<void>;
}

export interface HostEventSessionResourceOptions {
	openSink(session: AgentSession, signal: AbortSignal): HostEventSessionBinding;
	/** A failing factory owns cleanup of any resources it has not returned. */
	createSources(
		session: AgentSession,
		active: ActiveSessionContext,
		signal: AbortSignal,
	): Promise<readonly HostEventSource[]>;
}

/** Host sources stop before the runtime closes the parent session or replaces its storage. */
export class HostEventSessionResource implements AgentSessionRuntimeResource {
	private readonly options: HostEventSessionResourceOptions;
	private operation: Promise<void> = Promise.resolve();
	private generation = 0;
	private abort: AbortController | undefined;
	private binding: HostEventSessionBinding | undefined;
	private sources: readonly HostEventSource[] = [];

	constructor(options: HostEventSessionResourceOptions) {
		this.options = options;
	}

	start(session: AgentSession, active: ActiveSessionContext): Promise<void> {
		const generation = ++this.generation;
		this.abort?.abort(new Error("Host event session is being replaced."));
		return this.enqueue(async () => {
			await this.stopHandles();
			if (generation !== this.generation) return;
			const abort = new AbortController();
			this.abort = abort;
			try {
				this.sources = await this.options.createSources(session, active, abort.signal);
				if (generation !== this.generation) {
					await this.stopHandles();
					return;
				}
				if (this.sources.length === 0) return;
				const binding = this.options.openSink(session, abort.signal);
				this.binding = binding;
				const sink = this.guardSink(binding.sink, abort.signal);
				for (const source of this.sources) {
					abort.signal.throwIfAborted();
					await source.start(sink);
				}
				if (generation !== this.generation) await this.stopHandles();
			} catch (error) {
				try {
					await this.stopHandles();
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Host event startup and cleanup failed.");
				}
				if (generation === this.generation) throw error;
			}
		});
	}

	stop(): Promise<void> {
		this.generation++;
		// Close callback authority synchronously even if a bounded source lookup is still settling.
		this.abort?.abort(new Error("Host event session stopped."));
		return this.enqueue(() => this.stopHandles());
	}

	private guardSink(sink: HostEventSink, signal: AbortSignal): HostEventSink {
		const invoke = async <T>(caller: AbortSignal, action: (active: AbortSignal) => Promise<T>): Promise<T> => {
			const active = AbortSignal.any([signal, caller]);
			active.throwIfAborted();
			const result = await action(active);
			// A committed receipt may safely replay; a retired host never acknowledges it late.
			active.throwIfAborted();
			return result;
		};
		return {
			consumerId: sink.consumerId,
			checkpoint: (sourceId, caller) => invoke(caller, (active) => sink.checkpoint(sourceId, active)),
			register: (source, caller) => invoke(caller, (active) => sink.register(source, active)),
			beginCatchUp: (catchUp, caller) => invoke(caller, (active) => sink.beginCatchUp(catchUp, active)),
			resumeGap: (gap, caller) => invoke(caller, (active) => sink.resumeGap(gap, active)),
			accept: (event, caller) => invoke(caller, (active) => sink.accept(event, active)),
			seal: (seal, caller) => invoke(caller, (active) => sink.seal(seal, active)),
			retireThrough: (horizon, caller) => invoke(caller, (active) => sink.retireThrough(horizon, active)),
			deactivate: (sourceId) => sink.deactivate(sourceId),
			reportConnection: (source, connection) => {
				if (!signal.aborted) sink.reportConnection(source, connection);
			},
			subscribeWritable: (listener) =>
				sink.subscribeWritable(() => {
					if (!signal.aborted) listener();
				}),
		};
	}

	private enqueue(action: () => Promise<void>): Promise<void> {
		const pending = this.operation.then(action);
		this.operation = pending.catch(() => {});
		return pending;
	}

	private async stopHandles(): Promise<void> {
		this.abort?.abort(new Error("Host event source authority retired."));
		this.abort = undefined;
		const sources = this.sources;
		const binding = this.binding;
		const stopped = await Promise.allSettled(sources.map((source) => Promise.resolve().then(() => source.stop())));
		// A source may retain a failed physical cleanup or consumer-claim release for retry.
		// Keep its owner reachable; a later start must finish that stop before admitting new sources.
		this.sources = sources.filter((_source, index) => stopped[index]!.status === "rejected");
		const errors: unknown[] = stopped.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		try {
			await binding?.close();
			this.binding = undefined;
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) throw new AggregateError(errors, "Host event source shutdown failed.");
	}
}
