/**
 * What an operation does, remembered. The four effect questions read only `operation.*` (the command,
 * its resolved executable and script content, the execution and task directories), never the owner's
 * request, so one reading answers the same operation in any turn and any session. The key carries the
 * System One model id and a digest of the effect questions themselves: a new model or a reworded
 * question never reads an older answer. The owner's request is not cached; `request_authorizes` is
 * asked fresh whenever a cached reading shows an effect.
 */

import { createHash } from "node:crypto";
import {
	OPERATION_EFFECT_IDS,
	OPERATION_EFFECT_PROGRAM,
	type OperationEffectId,
	type OperationEffectReading,
	type OperationJudgmentIdentity,
} from "./operation-classifier.ts";

const EFFECT_QUESTIONS_DIGEST = createHash("sha256")
	.update(
		JSON.stringify(
			OPERATION_EFFECT_PROGRAM.decisions.filter((decision) =>
				(OPERATION_EFFECT_IDS as readonly string[]).includes(decision.id),
			),
		),
	)
	.digest("hex");

export const OPERATION_EFFECT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1024;

export function operationEffectKey(input: {
	readonly model: string;
	readonly toolName: string;
	readonly operation: string;
	readonly identity: OperationJudgmentIdentity;
}): string {
	return createHash("sha256")
		.update(JSON.stringify([EFFECT_QUESTIONS_DIGEST, input.model, input.toolName, input.operation, input.identity]))
		.digest("hex");
}

/** A short, non-reversible name for an operation identity, for the ledger (the command is never stored). */
export function operationIdentityHash(identity: OperationJudgmentIdentity, operation: string): string {
	return createHash("sha256")
		.update(JSON.stringify([operation, identity]))
		.digest("hex")
		.slice(0, 16);
}

/** The durable side: the decision ledger's `operation_effects` table. */
export interface OperationEffectDurableStore {
	read(cacheKey: string, notBefore: number): Record<string, number | null> | undefined;
	write(cacheKey: string, model: string, readings: Record<string, number | null>, now: number): void;
}

export interface OperationEffectCacheOptions {
	readonly maxEntries?: number;
	readonly ttlMs?: number;
	readonly durable?: () => OperationEffectDurableStore | undefined;
	readonly now?: () => number;
	/** A durable read or write failed; the reading is still served from memory. */
	readonly onDurableFailure?: (error: unknown) => void;
}

function completeReading(raw: Record<string, number | null> | undefined): OperationEffectReading | undefined {
	if (!raw) return undefined;
	const reading: Partial<Record<OperationEffectId, number>> = {};
	for (const id of OPERATION_EFFECT_IDS) {
		const value = raw[id];
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return undefined;
		reading[id] = value;
	}
	return reading as OperationEffectReading;
}

export class OperationEffectCache {
	private readonly memory = new Map<string, OperationEffectReading>();
	private readonly options: OperationEffectCacheOptions;

	constructor(options: OperationEffectCacheOptions = {}) {
		this.options = options;
	}

	get(key: string): OperationEffectReading | undefined {
		const held = this.memory.get(key);
		if (held) {
			this.memory.delete(key);
			this.memory.set(key, held);
			return held;
		}
		const store = this.options.durable?.();
		if (!store) return undefined;
		const now = (this.options.now ?? Date.now)();
		let raw: Record<string, number | null> | undefined;
		try {
			raw = store.read(key, now - (this.options.ttlMs ?? OPERATION_EFFECT_TTL_MS));
		} catch (error) {
			this.options.onDurableFailure?.(error);
			return undefined;
		}
		const reading = completeReading(raw);
		if (reading) this.remember(key, reading);
		return reading;
	}

	/** Keeps a reading only when every effect was answered: a missing answer is never cached as absent. */
	set(key: string, model: string, effects: OperationEffectReading): void {
		const reading = completeReading(effects as Record<string, number | null>);
		if (!reading) return;
		this.remember(key, reading);
		const store = this.options.durable?.();
		if (!store) return;
		try {
			store.write(key, model, reading as Record<string, number | null>, (this.options.now ?? Date.now)());
		} catch (error) {
			this.options.onDurableFailure?.(error);
		}
	}

	private remember(key: string, reading: OperationEffectReading): void {
		this.memory.set(key, reading);
		const max = this.options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		while (this.memory.size > max) {
			const oldest = this.memory.keys().next().value;
			if (oldest === undefined) break;
			this.memory.delete(oldest);
		}
	}
}
