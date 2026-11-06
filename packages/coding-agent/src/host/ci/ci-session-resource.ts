import type { AgentSession } from "../../core/agent-session.ts";
import type { ActiveSessionContext, AgentSessionRuntimeResource } from "../../core/agent-session-runtime.ts";
import type { CiStatusSource, CiStatusView } from "../../core/ci-status-view.ts";
import { IndependentObserverSet } from "../../core/observer-dispatch.ts";
import { boundedRedactedDiagnosticText } from "../../core/security/secret-text.ts";
import { HostEventSessionResource } from "../host-event-session-resource.ts";
import { createCiHostRuntime } from "./ci-host-event-source.ts";
import { type CiGitPaths, readCiStatusView, resolveCiGitPathsAsync } from "./ci-status-record.ts";

const STATUS_CACHE_MS = 1000;

/**
 * The interactive host owns process/network discovery and publishes only typed facts to the core.
 * The footer verdict reads the local status record alone: it needs no provider, network or source.
 */
export class CiSessionResource implements AgentSessionRuntimeResource, CiStatusSource {
	private readonly events: HostEventSessionResource;
	private readonly listeners = new IndependentObserverSet<() => void>();
	private readonly onDiagnostic: (message: string) => void;
	private paths: CiGitPaths | undefined;
	private statusCache?: { at: number; view: CiStatusView | undefined };

	constructor(onDiagnostic: (message: string) => void) {
		this.onDiagnostic = onDiagnostic;
		this.events = new HostEventSessionResource({
			openSink: (session, signal) => session.backgroundLanes.openHostEventSession(signal),
			createSources: async (session, active, signal) => {
				const paths = await resolveCiGitPathsAsync(active.sessionManager.getCwd(), signal);
				signal.throwIfAborted();
				this.setPaths(paths);
				signal.addEventListener("abort", () => this.setPaths(undefined), { once: true });
				// `proactivity.ciEvents: false` stops CI discovery (git reads and GitHub calls) for host events.
				if (!paths || !active.services.settingsManager.getProactivitySettings().ciEvents) return [];
				const runtime = await createCiHostRuntime({
					cwd: active.sessionManager.getCwd(),
					paths,
					signal,
					onDiagnostic,
					getSubscribedSubjects: () => session.backgroundLanes.getHostEventSubjects(),
					subscribeSubjects: (listener) => session.backgroundLanes.subscribeOrchestrationStore(listener),
					// GitHub routines need this same source, so they watch only a checkout with the CI workflow.
					getGithubInterests: () => session.backgroundLanes.getGithubInterests(),
					subscribeGithubInterests: (listener) => session.backgroundLanes.subscribeRoutineDefinitions(listener),
				});
				signal.throwIfAborted();
				if (!runtime) return [];
				const unsubscribe = runtime.subscribeStatus(() => this.notify());
				signal.addEventListener("abort", unsubscribe, { once: true });
				return [runtime.source];
			},
		});
	}

	readStatus(): CiStatusView | undefined {
		if (!this.paths) return undefined;
		const now = Date.now();
		if (this.statusCache && now - this.statusCache.at < STATUS_CACHE_MS) return this.statusCache.view;
		this.statusCache = { at: now, view: readCiStatusView(this.paths, now) };
		return this.statusCache.view;
	}

	subscribeStatus(listener: () => void): () => void {
		return this.listeners.subscribe(listener);
	}

	/** Session activation never waits for git, the provider or the network, and never fails on them. */
	start(session: AgentSession, active: ActiveSessionContext): Promise<void> {
		void this.events.start(session, active).catch((error: unknown) => {
			this.onDiagnostic(
				`CI event source inactive: ${boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error)) ?? "unavailable"}`,
			);
		});
		return Promise.resolve();
	}

	stop(): Promise<void> {
		return this.events.stop();
	}

	private setPaths(paths: CiGitPaths | undefined): void {
		this.paths = paths;
		this.notify();
	}

	private notify(): void {
		this.statusCache = undefined;
		this.listeners.notify(
			(listener) => listener(),
			(error) => this.onDiagnostic(`CI status observer failed: ${String(error).slice(0, 512)}`),
		);
	}
}
