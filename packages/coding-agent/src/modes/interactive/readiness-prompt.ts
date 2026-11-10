/**
 * The session-start readiness check: when the harness cannot start a worker, say why in plain words and let the owner fix it
 * once, here, by choosing the worker profile (the model every worker uses unless a task needs more thinking).
 */

import type { Api, Model } from "@caupulican/pi-ai";
import { resolveModelThinkingLevel } from "@caupulican/pi-ai/models";
import { describeReadinessProblem } from "../../core/harness-readiness.ts";
import { interfaceText } from "../../core/language/interface-text.ts";
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

const MAX_LISTED = 8;

/** Checks readiness once; prompts only when a fix needs the owner. Never throws: a failed check is no reason to stop a session. */
export async function promptHarnessReadiness(host: ReadinessPromptHost): Promise<void> {
	try {
		const probe = host.probe();
		if (probe.ready) return;
		const problem = describeReadinessProblem(probe.reason);
		if (!problem) return;
		const text = interfaceText().dialogs.readiness;
		if (problem.fix === "enable_delegation") {
			const choice = await host.select(problem.text, [problem.fixText ?? text.delegationFix, text.skip]);
			if (choice === undefined || choice === text.skip) return;
			host.saveWorkerDelegation({ ...host.currentWorkerDelegation(), enabled: true });
			host.showStatus(text.delegationOn);
			return;
		}
		const current = host.currentModel();
		const options = new Map<string, Model<Api>>();
		if (current) options.set(text.sessionModel(`${current.provider}/${current.id}`), current);
		for (const model of host.availableModels().slice(0, MAX_LISTED))
			options.set(`${model.provider}/${model.id}`, model);
		const subscriptions = host.subscriptionProviders();
		const choice = await host.select(text.choosePrompt(problem.text), [
			...(subscriptions.length > 0 ? [text.auto] : []),
			...options.keys(),
			text.skip,
		]);
		if (choice === text.auto) {
			host.saveWorkerDelegation({
				...host.currentWorkerDelegation(),
				account: "other",
				routeProviders: [...subscriptions],
			});
			host.showStatus(text.workersSubscriptions(subscriptions.join(", ")));
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
		host.showStatus(text.workersModel(`${picked.provider}/${picked.id}`));
	} catch {
		// A readiness check that fails leaves the session as it was.
	}
}
