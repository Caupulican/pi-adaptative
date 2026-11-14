/**
 * What a session's System One runs on beyond its settings, and the controller a session builds from it. A session keeps
 * the choices it was built with (on or off as it resolved them, the provider it was told to use, the transport its
 * requests take, where its evidence is kept); a session it hosts (a bot's) follows them as they are at each use, so it runs
 * System One exactly as its host does, with its own evidence home.
 */

import { execFileSync } from "node:child_process";
import { SystemOneReviewer, type SystemOneReviewerDeps } from "../review/typesafe-reviewer.ts";
import { type SystemOneAccessResolver, type SystemOneProviderChoice, systemOneAccessFromSession } from "./access.ts";
import { SystemOneJevAdapter } from "./adapter.ts";
import { createSystemOneConfig } from "./config.ts";
import { SystemOneController, type SystemOneControllerDeps } from "./controller.ts";
import { ExecutionStore } from "./execution-state.ts";

/** A session's System One choices, as it resolved them when it was built. */
export interface SystemOneSessionSource {
	/** On or off as the session resolved it (an explicit choice, its settings, a missing key); its settings still turn it off. */
	readonly enabled: boolean;
	/** The provider the session was told to use, in place of the one its settings name. */
	readonly provider?: SystemOneProviderChoice;
	/** The transport System One's requests take; unset is the global fetch. */
	readonly fetch?: typeof fetch;
	/** Where the session's System One evidence is kept, in place of its orchestration directory (a bot's is in its home). */
	readonly evidenceDir?: string;
}

/** What a hosted session (a bot's) follows of its host's System One: everything but the evidence home, which is its own. */
export type SystemOneHostSource = Omit<SystemOneSessionSource, "evidenceDir">;

/**
 * The source of a session built with these options, once its on/off is resolved. A hosted session's source reads its
 * host's at each use (`systemOneHost`), so its on/off, provider and transport are the host's now, never a copy.
 */
export function systemOneSourceOf(
	options: {
		systemOneHost?: SystemOneHostSource;
		systemOneProvider?: SystemOneProviderChoice;
		systemOneFetch?: typeof fetch;
		systemOneEvidenceDir?: string;
	},
	enabled: boolean,
): SystemOneSessionSource {
	const evidence = options.systemOneEvidenceDir ? { evidenceDir: options.systemOneEvidenceDir } : {};
	const host = options.systemOneHost;
	if (host)
		return {
			get enabled() {
				return host.enabled;
			},
			get provider() {
				return host.provider;
			},
			get fetch() {
				return host.fetch;
			},
			...evidence,
		};
	return {
		enabled,
		...(options.systemOneProvider ? { provider: options.systemOneProvider } : {}),
		...(options.systemOneFetch ? { fetch: options.systemOneFetch } : {}),
		...evidence,
	};
}

/**
 * What a reviewer over the session's own access and transport is built from: the provider the session was told to use
 * (read at each review) else its settings' choice, its keys, and its transport. The session's `systemone` tool and every
 * worker it delegates to review through these, so a worker follows the root's provider pin; one provider's key only
 * ever goes to that provider, and a provider switch in settings applies to the next review unless the session names one.
 */
export function sessionSystemOneReviewerDeps(input: {
	readonly settings: Parameters<typeof systemOneAccessFromSession>[0];
	readonly credentials: Parameters<typeof systemOneAccessFromSession>[1];
	readonly source: SystemOneSessionSource | undefined;
	readonly credentialBoundary: SystemOneReviewerDeps["credentialBoundary"];
	readonly usage?: SystemOneReviewerDeps["usage"];
}): SystemOneReviewerDeps {
	return {
		access: systemOneAccessFromSession(input.settings, input.credentials, () => input.source?.provider),
		fetch: input.source?.fetch,
		credentialBoundary: input.credentialBoundary,
		usage: input.usage,
	};
}

/** The session's `systemone` tool reviewer, over {@link sessionSystemOneReviewerDeps}. */
export function sessionSystemOneReviewer(input: Parameters<typeof sessionSystemOneReviewerDeps>[0]): SystemOneReviewer {
	return new SystemOneReviewer(sessionSystemOneReviewerDeps(input));
}

/** The repository revision the session starts at; "unknown" outside a git work tree. */
function baselineRevisionOf(cwd: string): string {
	try {
		return (
			execFileSync("git", ["rev-parse", "HEAD"], {
				cwd,
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || "unknown"
		);
	} catch {
		// Not a git work tree.
		return "unknown";
	}
}

/**
 * The session's System One controller, once its access resolved a key: one reviewer over that access and transport, the
 * engine adapter, and the execution store of this session's run at the repository's current revision.
 */
export async function createSessionSystemOneController(input: {
	readonly access: SystemOneAccessResolver & { keys(): Promise<string[]> };
	readonly fetch?: typeof fetch;
	readonly credentialBoundary: SystemOneReviewerDeps["credentialBoundary"];
	readonly usage: SystemOneReviewerDeps["usage"];
	readonly cwd: string;
	readonly runId: string;
	readonly hookCoordinator?: SystemOneControllerDeps["hookCoordinator"];
}): Promise<SystemOneController> {
	const { access, cwd } = input;
	const reviewer = new SystemOneReviewer({
		access,
		fetch: input.fetch,
		credentialBoundary: input.credentialBoundary,
		usage: input.usage,
	});
	const adapter = new SystemOneJevAdapter(reviewer, createSystemOneConfig({ enabled: true }), {
		access,
		getUserKeys: () => access.keys(),
	});
	const baselineRevision = baselineRevisionOf(cwd);
	const store = new ExecutionStore({
		run_id: input.runId,
		objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
		repo: { root: cwd, baseline_revision: baselineRevision, current_revision: baselineRevision },
	});
	return new SystemOneController({
		store,
		adapter,
		userKeys: await access.keys(),
		hookCoordinator: input.hookCoordinator,
	});
}
