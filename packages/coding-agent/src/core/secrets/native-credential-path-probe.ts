import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecutionContext } from "@caupulican/pi-agent-core";
import { getWorkTenantDir } from "../agent-paths.ts";
import {
	CredentialPathPolicy,
	type CredentialPathProbe,
	type CredentialPathProtection,
} from "./credential-path-policy.ts";

/** Native defaults stay in this adapter; an explicit probe never falls back to operator I/O. */
export function createCredentialPathPolicy(
	cwd: string,
	protection?: CredentialPathProtection,
	context?: ExecutionContext,
	explicitProbe?: CredentialPathProbe,
): CredentialPathPolicy {
	const nativeFlavor = process.platform === "win32" ? "win32" : "posix";
	const flavor = context?.attachment.flavor ?? nativeFlavor;
	const native = explicitProbe === undefined && flavor === nativeFlavor;
	let probe = explicitProbe;
	if (!probe && native) {
		const homeDir = homedir();
		const agentDir = resolve(protection?.agentDir ?? join(homeDir, ".pi", "agent"));
		probe = {
			canonicalPath(path) {
				try {
					return realpathSync.native(path);
				} catch {
					// Preserve the native lexical check for missing/inaccessible paths and new write targets.
					return undefined;
				}
			},
			isFile: (path) => statSync(path).isFile(),
			homeDir,
			harnessRoots: [
				join(agentDir, "okf-memory"),
				join(agentDir, "skills"),
				join(agentDir, "sessions"),
				join(agentDir, "memory"),
				getWorkTenantDir(agentDir, "context", "sessions"),
			],
			harnessFiles: [join(agentDir, "MEMORY.md"), join(agentDir, "USER.md")],
		};
	}
	return new CredentialPathPolicy({
		cwd: context?.cwd ?? resolve(cwd),
		flavor,
		caseSensitive: context?.attachment.caseSensitive ?? nativeFlavor !== "win32",
		protection,
		protectionCwd: native ? process.cwd() : undefined,
		probe: probe ?? { canonicalPath: () => undefined, isFile: () => undefined },
	});
}
