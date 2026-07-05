import { expect } from "vitest";

export type ChaosOutcome =
	| { type: "success"; text?: string }
	| { type: "error"; message: string }
	| { type: "stall" }
	| { type: "mid_stream_abort"; message: string }
	| { type: "malformed_event"; message: string };

export interface ChaosCall {
	modelRef: string;
	outcome: ChaosOutcome;
}

export class ChaosProviderScript {
	private readonly script: ChaosOutcome[];
	readonly calls: ChaosCall[] = [];

	constructor(script: ChaosOutcome[]) {
		this.script = [...script];
	}

	call(modelRef: string): ChaosOutcome {
		const outcome = this.script.shift() ?? { type: "success", text: "ok" };
		this.calls.push({ modelRef, outcome });
		return outcome;
	}
}

export function createChaosProvider(script: ChaosOutcome[]): ChaosProviderScript {
	return new ChaosProviderScript(script);
}

export function expectBoundedOutbound(provider: ChaosProviderScript, expected: number): void {
	expect(provider.calls).toHaveLength(expected);
}

export function expectNoSilentTerminal(result: { ended: boolean; visibleMessages: string[] }): void {
	if (result.ended) expect(result.visibleMessages.length).toBeGreaterThan(0);
}

export function expectNoUnapprovedMeteredSpend(
	provider: ChaosProviderScript,
	selectedMeteredModelRef: string,
	approvedMeteredModelRefs: string[] = [],
): void {
	const approved = new Set([selectedMeteredModelRef, ...approvedMeteredModelRefs]);
	for (const call of provider.calls) {
		if (call.modelRef.startsWith("metered/")) expect(approved.has(call.modelRef)).toBe(true);
	}
}
