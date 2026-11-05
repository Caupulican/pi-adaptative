import type { AgentSession } from "../../core/agent-session.ts";
import type { ActiveSessionContext, AgentSessionRuntimeResource } from "../../core/agent-session-runtime.ts";
import type { CiStatusSource, CiStatusView } from "../../core/ci-status-view.ts";
import { IndependentObserverSet } from "../../core/observer-dispatch.ts";
import { HostEventSessionResource } from "../host-event-session-resource.ts";
import { type CiHostRuntime, createCiHostRuntime } from "./ci-host-event-source.ts";

/** The interactive host owns process/network discovery and publishes only typed facts to the core. */
export class CiSessionResource implements AgentSessionRuntimeResource, CiStatusSource {
	private readonly events: HostEventSessionResource;
	private readonly listeners = new IndependentObserverSet<() => void>();
	private current: CiHostRuntime | undefined;
	private readonly onDiagnostic: (message: string) => void;

	constructor(onDiagnostic: (message: string) => void) {
		this.onDiagnostic = onDiagnostic;
		this.events = new HostEventSessionResource({
			openSink: (session, signal) => session.backgroundLanes.openHostEventSession(signal),
			createSources: async (session, active, signal) => {
				const current = await createCiHostRuntime({
					cwd: active.sessionManager.getCwd(),
					signal,
					onDiagnostic,
					getSubscribedSubjects: () => session.backgroundLanes.getHostEventSubjects(),
					subscribeSubjects: (listener) => session.backgroundLanes.subscribeOrchestrationStore(listener),
				});
				signal.throwIfAborted();
				this.current = current;
				if (!current) {
					this.notify();
					return [];
				}
				const unsubscribe = current.subscribeStatus(() => this.notify());
				signal.addEventListener(
					"abort",
					() => {
						unsubscribe();
						if (this.current === current) this.current = undefined;
						this.notify();
					},
					{ once: true },
				);
				this.notify();
				return [current.source];
			},
		});
	}

	readStatus(): CiStatusView | undefined {
		return this.current?.readStatus();
	}
	subscribeStatus(listener: () => void): () => void {
		return this.listeners.subscribe(listener);
	}
	start(session: AgentSession, active: ActiveSessionContext): Promise<void> {
		return this.events.start(session, active);
	}
	stop(): Promise<void> {
		return this.events.stop();
	}

	private notify(): void {
		this.listeners.notify(
			(listener) => listener(),
			(error) => this.onDiagnostic(`CI status observer failed: ${String(error).slice(0, 512)}`),
		);
	}
}
