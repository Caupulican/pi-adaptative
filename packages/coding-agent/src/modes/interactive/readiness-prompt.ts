/**
 * The session-start readiness check: when the harness cannot start a worker, say why in plain words and let the owner fix it
 * once, here, by choosing the worker profile (the model every worker uses unless a task needs more thinking).
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import { describeReadinessProblem } from "../../core/harness-readiness.ts";
import type { WorkerDelegationSettings } from "../../core/settings/settings-schema.ts";

export interface ReadinessPromptHost {
	probe(): { readonly ready: true } | { readonly ready: false; readonly reason: string };
	/** Models the owner is signed in to, best first. */
	availableModels(): readonly Model<Api>[];
	/** The model this session runs on. */
	currentModel(): Model<Api> | undefined;
	/** Providers the owner is signed in to with a subscription (an OAuth login), in the registry's order. API keys are not among them. */
	subscriptionProviders(): readonly string[];
	currentWorkerDelegation(): WorkerDelegationSettings;
	saveWorkerDelegation(settings: WorkerDelegationSettings): void;
	select(title: string, options: string[]): Promise<string | undefined>;
	showStatus(text: string): void;
}

const SKIP = "Not now";
const AUTO = "Set it up for me (subscriptions first; API keys stay unused unless you say so)";
const MAX_LISTED = 8;

/** Checks readiness once; prompts only when a fix needs the owner. Never throws: a failed check is no reason to stop a session. */
export async function promptHarnessReadiness(host: ReadinessPromptHost): Promise<void> {
	try {
		const probe = host.probe();
		if (probe.ready) return;
		const problem = describeReadinessProblem(probe.reason);
		if (!problem) return;
		if (problem.fix === "enable_delegation") {
			const choice = await host.select(problem.text, [problem.fixText ?? "Turn delegation on", SKIP]);
			if (choice === undefined || choice === SKIP) return;
			host.saveWorkerDelegation({ ...host.currentWorkerDelegation(), enabled: true });
			host.showStatus("Delegation is on.");
			return;
		}
		const current = host.currentModel();
		const options = new Map<string, Model<Api>>();
		if (current) options.set(`This session's model (${current.provider}/${current.id})`, current);
		for (const model of host.availableModels().slice(0, MAX_LISTED))
			options.set(`${model.provider}/${model.id}`, model);
		const subscriptions = host.subscriptionProviders();
		const choice = await host.select(
			`${problem.text} Choose how workers get their model, or pick a worker profile: one model every worker uses (a hard task raises only its thinking).`,
			[...(subscriptions.length > 0 ? [AUTO] : []), ...options.keys(), SKIP],
		);
		if (choice === AUTO) {
			host.saveWorkerDelegation({
				...host.currentWorkerDelegation(),
				account: "other",
				routeProviders: [...subscriptions],
			});
			host.showStatus(
				`Workers will use your subscriptions (${subscriptions.join(", ")}). API keys are left unused.`,
			);
			return;
		}
		const picked = choice === undefined ? undefined : options.get(choice);
		if (!picked) return;
		const existing = host.currentWorkerDelegation();
		host.saveWorkerDelegation({
			...existing,
			modelPins: {
				...existing.modelPins,
				default: {
					provider: picked.provider,
					modelId: picked.id,
					thinkingLevel: resolveModelThinkingLevel(picked, "medium"),
				},
			},
		});
		host.showStatus(
			`Workers will use ${picked.provider}/${picked.id}. Change it any time under workerDelegation.modelPins in settings.`,
		);
	} catch {
		// A readiness check that fails leaves the session as it was.
	}
}
