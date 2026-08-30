import type { Extension } from "./types.ts";

const EXTENSION_DISPOSAL_TIMEOUT_MS = 5_000;
const inactiveExtensions = new WeakSet<Extension>();

export function isExtensionGenerationInactive(extension: Extension): boolean {
	return inactiveExtensions.has(extension);
}

/**
 * Unsubscribe a replaced extension generation's event handlers and invoke every disposer within
 * one bounded deadline. This lifecycle owner is intentionally independent from extension module
 * loading so ordinary session construction does not pull the loader's bundled SDK graph into
 * memory merely to release an already-loaded generation.
 */
export async function disposeExtensionEventSubscriptions(
	extensions: Extension[],
	options: { deactivate?: boolean; timeoutMs?: number } = {},
): Promise<void> {
	const deadline = Date.now() + (options.timeoutMs ?? EXTENSION_DISPOSAL_TIMEOUT_MS);
	for (const extension of extensions) {
		if (options.deactivate ?? true) inactiveExtensions.add(extension);
		// Dispose is unsubscribe + disposer invocation ONLY. It must never clear the extension's
		// own registries (tools/commands/etc.): this function is shared by every dispose caller
		// (resource-loader reload paths, runtime-builder, the lazy-load deactivate:false retry
		// path), not just factory-throw rollback. Rollback of a doomed registration is the
		// factory-load transaction's job (see ExtensionLoadRuntimeSnapshot in factory-runtime.ts,
		// and createLazyExtension's own explicit clear + restoreLazyToolPlaceholders in loader.ts).
		for (const unsubscribe of extension.eventUnsubscribes) {
			try {
				unsubscribe();
			} catch {
				// Disposal must never break a reload.
			}
		}
		extension.eventUnsubscribes.length = 0;

		for (const disposer of extension.disposers) {
			try {
				const result = disposer();
				if (result === undefined) continue;
				const completion = Promise.resolve(result).catch(() => undefined);
				const remainingMs = Math.max(0, deadline - Date.now());
				if (remainingMs === 0) continue;
				let timeout: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					completion,
					new Promise<void>((resolve) => {
						timeout = setTimeout(resolve, remainingMs);
					}),
				]);
				if (timeout) clearTimeout(timeout);
			} catch {
				// Disposal must never break a reload.
			}
		}
		extension.disposers.length = 0;
	}
}
