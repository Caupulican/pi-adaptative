import { acquireWorkRun, boundedWorkRetention, extensionCacheDir, extensionStateDir } from "../agent-paths.ts";
import type { ExtensionStorage, ExtensionWorkRunOptions } from "./types.ts";

/**
 * Create a pure, namespaced extension storage view. Merely requesting the view performs no I/O;
 * durable/cache directories are created only when the extension writes to them, and transient work
 * is created only through an explicit leased acquisition.
 */
export function createExtensionStorage(
	agentDir: string,
	namespace: string,
	assertActive: () => void,
	registerDisposer: (disposer: () => void) => void,
): ExtensionStorage {
	const stateDir = extensionStateDir(agentDir, namespace);
	const cacheDir = extensionCacheDir(agentDir, namespace);

	return {
		namespace,
		stateDir,
		cacheDir,
		acquireWorkRun(options: ExtensionWorkRunOptions = {}) {
			assertActive();
			const lease = acquireWorkRun({
				agentDir,
				category: "extensions",
				tenant: namespace,
				runId: options.runId,
				retention: boundedWorkRetention(options.retention),
			});
			registerDisposer(lease.release);
			return lease;
		},
	};
}
