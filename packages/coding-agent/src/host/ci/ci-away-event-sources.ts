import type { AwayEventSourceFactory } from "../../core/routines/away-event-feed.ts";
import { type CiHostRuntimeOptions, createCiHostRuntime } from "./ci-host-event-source.ts";
import { resolveCiGitPathsAsync } from "./ci-status-record.ts";

/** The gh tokens the starting session handed the daemon, or why the handover could not be read. */
export interface AwayCiCredentials {
	readonly credentials: Readonly<Record<string, string>>;
	readonly fault?: string;
}

/**
 * The away host's CI source for a closed parent's checkout: the same source a session follows, discovered the same way
 * (none outside a repository with the CI workflow), in the away role: the session's claim takes its consumer back, and
 * the source then stops and tells the feed. Its gh commands alone carry the handed-over gh tokens; a handover
 * that could not be read is reported once, and gh then runs with its own configuration only. `upstream` replaces the
 * checkout's discovered paths and the gh provider, as {@link createCiHostRuntime} admits.
 */
export function createCiAwayEventSources(
	handover: Promise<AwayCiCredentials>,
	upstream: Pick<CiHostRuntimeOptions, "paths" | "provider"> = {},
): AwayEventSourceFactory {
	let faultReported = false;
	return async (request) => {
		const { credentials, fault } = await handover;
		request.signal.throwIfAborted();
		if (fault && !faultReported) {
			faultReported = true;
			request.onDiagnostic(`gh credentials were not received from the starting session: ${fault}`);
		}
		const paths = upstream.paths ?? (await resolveCiGitPathsAsync(request.cwd, request.signal));
		request.signal.throwIfAborted();
		if (!paths) return [];
		const runtime = await createCiHostRuntime({
			cwd: request.cwd,
			paths,
			...(upstream.provider ? { provider: upstream.provider } : {}),
			signal: request.signal,
			onDiagnostic: (message) => request.onDiagnostic(message),
			getSubscribedSubjects: () => request.getSubscribedSubjects(),
			subscribeSubjects: (listener) => request.subscribeSubjects(listener),
			commandCredentials: credentials,
			role: "away-host",
			onHeld: () => request.onHeld(),
		});
		return runtime ? [runtime.source] : [];
	};
}
