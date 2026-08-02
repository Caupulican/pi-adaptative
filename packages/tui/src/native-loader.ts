import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const cjsRequire = createRequire(import.meta.url);

/** Resolve a validated packaged native addon from source, npm-package, or binary layouts. */
export function loadNativeAddon<T>(nativePath: string, isValid: (value: unknown) => value is T): T | undefined {
	const moduleDir = path.dirname(fileURLToPath(import.meta.url));
	const candidates = [
		path.join(moduleDir, "..", nativePath),
		path.join(moduleDir, nativePath),
		path.join(path.dirname(process.execPath), nativePath),
	];

	for (const modulePath of candidates) {
		try {
			const candidate = cjsRequire(modulePath) as unknown;
			if (isValid(candidate)) return candidate;
		} catch {
			// Try the next supported packaging layout.
		}
	}

	return undefined;
}
