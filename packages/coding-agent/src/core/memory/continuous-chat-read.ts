import { createHash } from "node:crypto";
import { assertMemoryReadActive, type MemoryReadContext } from "./memory-read-context.ts";

/** Range-specific projection authority, independent of tail arrivals and unrelated node publication. */
export interface ContinuousChatReadVersion {
	readonly key: string;
	isCurrent(): boolean;
}

/** Source bytes and projection authority are re-read together before a consumer publishes their conclusion. */
export async function observeContinuousChatRead<T>(
	ref: string,
	read: (context?: MemoryReadContext) => Promise<T>,
	version: (context?: MemoryReadContext) => Promise<ContinuousChatReadVersion>,
	context?: MemoryReadContext,
): Promise<T> {
	assertMemoryReadActive(context);
	if (!context?.observe) return read(context);
	const capture = async (
		active: MemoryReadContext,
	): Promise<{ value: T; authority: ContinuousChatReadVersion; digest: string }> => {
		assertMemoryReadActive(active);
		const authority = await version(active);
		const value = await read(active);
		const after = await version(active);
		assertMemoryReadActive(active);
		if (authority.key !== after.key || !authority.isCurrent())
			throw new Error("Continuous-chat source changed during read.");
		const bytes = Buffer.isBuffer(value) ? value : (JSON.stringify(value) ?? "undefined");
		return { value, authority, digest: createHash("sha256").update(bytes).digest("hex") };
	};
	const captured = await capture(context);
	context.observe(
		Object.freeze({
			sources: Object.freeze([
				Object.freeze({ kind: "icm" as const, ref, revision: `${captured.authority.key}:${captured.digest}` }),
			]),
			complete: true,
			isCurrent: () => captured.authority.isCurrent(),
			revalidate: async (active: MemoryReadContext) => {
				const current = await capture(active);
				return captured.authority.key === current.authority.key && captured.digest === current.digest;
			},
		}),
	);
	return captured.value;
}
