import type { AgentTool } from "./types.ts";

/** Undefined: undeclared owner. Null: declared owner cannot provide a comparable bound. */
export function readToolFailureTimeoutMs(args: unknown, tool?: AgentTool<any>): number | null | undefined {
	try {
		const contract = tool?.failureRecovery;
		const getTimeoutMs = contract?.getTimeoutMs;
		if (!getTimeoutMs) return undefined;
		const value: unknown = Reflect.apply(getTimeoutMs, contract, [args]);
		return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
	} catch {
		// A broken projection must not re-enable argument guessing.
		return null;
	}
}
