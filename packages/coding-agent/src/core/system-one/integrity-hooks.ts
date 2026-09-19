/**
 * Integrity Lifecycle Hook Coordinator.
 * Coordinates deterministic execution of extension lifecycle hooks.
 *
 * Strict Rules:
 * - R-020: Expose deterministic lifecycle hooks.
 * - R-021: Hook execution is bounded/cancellable.
 * - R-022: Required high-impact validator failure fails closed.
 * - R-023: Unavailable never becomes PASS.
 * - R-040: Extension failure cannot corrupt canonical session state.
 * - R-060: Hook order documented and deterministic.
 * - R-061: Hooks cannot reorder Pi safety checks.
 * - R-062: Policy may demand stricter, never weaker, gates.
 */

import type {
	IntegrityDecision,
	IntegrityExtension,
	IntegrityGateResult,
	IntegrityHookContext,
	IntegrityHookName,
} from "../hooks/index.ts";

export interface HookExecutionOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

const DEFAULT_HOOK_TIMEOUT_MS = 15000;

export class IntegrityHookCoordinator {
	private readonly extensions: IntegrityExtension[] = [];

	constructor(initialExtensions: readonly IntegrityExtension[] = []) {
		for (const ext of initialExtensions) {
			this.registerExtension(ext);
		}
	}

	registerExtension(extension: IntegrityExtension): void {
		if (!extension || typeof extension !== "object" || !extension.id) {
			throw new Error("Integrity extension must have a non-empty string id");
		}
		const existingIndex = this.extensions.findIndex((e) => e.id === extension.id);
		if (existingIndex >= 0) {
			this.extensions[existingIndex] = extension;
		} else {
			this.extensions.push(extension);
		}
	}

	unregisterExtension(id: string): boolean {
		const idx = this.extensions.findIndex((e) => e.id === id);
		if (idx >= 0) {
			this.extensions.splice(idx, 1);
			return true;
		}
		return false;
	}

	getExtensions(): readonly IntegrityExtension[] {
		return Object.freeze([...this.extensions]);
	}

	hasExtensions(): boolean {
		return this.extensions.length > 0;
	}

	/**
	 * Run lifecycle hook across all registered extensions in registration order.
	 */
	async runHook(
		hook: IntegrityHookName,
		context: IntegrityHookContext,
		options?: HookExecutionOptions,
	): Promise<IntegrityGateResult> {
		if (this.extensions.length === 0) {
			return {
				decision: "allow",
				reasonCodes: ["NO_EXTENSIONS_REGISTERED"],
				validationRefs: [],
			};
		}

		options?.signal?.throwIfAborted();
		const timeoutMs = options?.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
		const isHighImpact =
			context.impact === "repo_mutation" ||
			context.impact === "external_side_effect" ||
			context.impact === "destructive" ||
			hook === "completion_candidate" ||
			hook === "before_mutation";

		const reasonCodes: string[] = [];
		const validationRefs: string[] = [];
		let compositeDecision: IntegrityDecision = "allow";

		for (const ext of this.extensions) {
			if (!ext.onHook) continue;
			options?.signal?.throwIfAborted();

			let extResult: IntegrityGateResult | undefined;
			try {
				let timerId: ReturnType<typeof setTimeout> | undefined;
				const timeoutPromise = new Promise<never>((_, reject) => {
					timerId = setTimeout(
						() => reject(new Error(`Extension '${ext.id}' hook '${hook}' timed out after ${timeoutMs}ms`)),
						timeoutMs,
					);
				});

				try {
					extResult = await Promise.race([ext.onHook(hook, context), timeoutPromise]);
				} finally {
					if (timerId !== undefined) clearTimeout(timerId);
				}
			} catch (err) {
				// Extension failure cannot corrupt canonical session state (R-040)
				const errMsg = err instanceof Error ? err.message : String(err);
				reasonCodes.push(`EXTENSION_ERROR:${ext.id}:${errMsg}`);
				if (isHighImpact) {
					// High impact fails closed (R-022)
					compositeDecision = "deny";
					break;
				}
				// Read-only advisory outage returns unavailable (R-023, PI-018)
				if (compositeDecision === "allow") {
					compositeDecision = "unavailable";
				}
				continue;
			}

			if (!extResult) continue;

			if (extResult.reasonCodes) {
				reasonCodes.push(...extResult.reasonCodes);
			}
			if (extResult.validationRefs) {
				validationRefs.push(...extResult.validationRefs);
			}

			// Policy may demand stricter, never weaker, gates (R-062)
			// Hierarchy: deny > replan > unavailable > allow
			if (extResult.decision === "deny") {
				compositeDecision = "deny";
				break;
			}
			if (extResult.decision === "replan") {
				compositeDecision = "replan";
			} else if (extResult.decision === "unavailable") {
				if (isHighImpact) {
					// Required high impact fails closed on unavailable (R-022)
					compositeDecision = "deny";
					reasonCodes.push(`FAIL_CLOSED_ON_UNAVAILABLE:${ext.id}`);
					break;
				} else if (compositeDecision === "allow") {
					compositeDecision = "unavailable";
				}
			}
		}

		return {
			decision: compositeDecision,
			reasonCodes: Object.freeze(reasonCodes),
			validationRefs: Object.freeze(validationRefs),
		};
	}
}
