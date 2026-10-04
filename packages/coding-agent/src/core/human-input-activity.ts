import type { HumanInputRequest } from "./human-input-request.ts";
import { IndependentObserverSet } from "./observer-dispatch.ts";

export interface HumanInputActivity {
	phase: "waiting" | "settled";
	request: HumanInputRequest;
}
type Listener = (activity: HumanInputActivity) => void;
interface ActivityScope {
	listeners: IndependentObserverSet<Listener>;
	pending: Map<string, HumanInputRequest>;
}
const scopes = new WeakMap<object, ActivityScope>();

/** Session-object-scoped observation survives extension reloads without sharing questions across sessions. */
export function subscribeHumanInputActivity(owner: object, listener: Listener): () => void {
	let scope = scopes.get(owner);
	if (!scope) {
		scope = { listeners: new IndependentObserverSet(), pending: new Map() };
		scopes.set(owner, scope);
	}
	const unsubscribe = scope.listeners.subscribe(listener);
	for (const request of scope.pending.values()) listener({ phase: "waiting", request });
	return () => {
		unsubscribe();
		if (scope.listeners.size === 0 && scope.pending.size === 0) scopes.delete(owner);
	};
}

/** Called only by the mandatory human-input presentation owner. Observers cannot own or cancel the request. */
export function publishHumanInputActivity(owner: object, activity: HumanInputActivity): void {
	let scope = scopes.get(owner);
	if (!scope) {
		if (activity.phase === "settled") return;
		scope = { listeners: new IndependentObserverSet(), pending: new Map() };
		scopes.set(owner, scope);
	}
	if (activity.phase === "waiting") scope.pending.set(activity.request.requestId, activity.request);
	else scope.pending.delete(activity.request.requestId);
	scope.listeners.notify(
		(listener) => listener(activity),
		(error) => {
			process.stderr.write(
				`Human input activity observer failed: ${error instanceof Error ? error.message.slice(0, 256) : "unknown failure"}\n`,
			);
		},
	);
	if (scope.listeners.size === 0 && scope.pending.size === 0) scopes.delete(owner);
}
