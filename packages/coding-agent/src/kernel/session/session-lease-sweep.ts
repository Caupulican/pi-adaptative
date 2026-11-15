/**
 * The start sweep of one orchestration home's lifetime lease registries (`deletions/<session-key>.json.leases.json`,
 * `session-bundle-lifecycle.ts`). A process that ends without releasing its hold (a crash) stays recorded as a holder
 * until a process on its host proves it gone, and only an acquisition of that same session pruned it; meanwhile the
 * registry's presence reads as the home holding the session (`orchestrationHomeHoldsSession`) and it is never removed.
 * Each registry is pruned here under its tombstone's lock, as every acquisition and release takes it, of the holders
 * whose record names this machine by its machine id and whose process is proven gone (`isOwnerProvenDeadOnThisMachine`);
 * no holder is ended by age, and a registry left with none is removed. A record naming only a hostname (an older build's)
 * may be another system's under the same name (Windows beside WSL), whose pid cannot be probed here: it is left to the
 * acquisition of its session, as before. A holder on another machine, or one that cannot be judged yet, is kept: only a
 * process on its own host proves it gone, which this same sweep does there when pi starts on that machine. A registry that does not read, or that
 * names a session whose tombstone it is not beside, is left as it is and logged.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { harnessLog } from "../harness-log.ts";
import { isOwnerProvenDeadOnThisMachine, judgeOwner } from "../reliability/owner-identity.ts";
import { isMissingFileError, withFileLockSync } from "../storage/atomic-file.ts";
import {
	readLeaseRegistry,
	type SessionLeaseHolderRef,
	sessionLeaseHolderRef,
	writeHolders,
} from "./session-bundle-lifecycle.ts";
import {
	type OrchestrationHome,
	orchestrationSessionDeletionFile,
	orchestrationSessionDeletionsDir,
} from "./session-bundle-paths.ts";

const LEASE_REGISTRY_SUFFIX = ".leases.json";

/**
 * Prunes the holders proven dead of every lease registry in `home`; `logName` names the home in the harness log. Returns,
 * by session, the holders on another machine that still hold it, as read under the lock.
 */
export async function sweepSessionLeaseRegistries(
	home: OrchestrationHome,
	logName: string,
): Promise<Map<string, SessionLeaseHolderRef[]>> {
	const heldElsewhere = new Map<string, SessionLeaseHolderRef[]>();
	const dir = orchestrationSessionDeletionsDir(home);
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(LEASE_REGISTRY_SUFFIX));
	} catch (error) {
		// No deletions directory: no registry. Any other failure is the retention's to tell (`sessionBundleRetentionsInFlight`).
		if (!isMissingFileError(error))
			harnessLog.warn("sessions", "a home's lease registries do not list", {
				home: logName,
				detail: describe(error),
			});
		return heldElsewhere;
	}
	for (const [index, name] of names.entries()) {
		// The pruning is synchronous: yield now and then.
		if (index % 64 === 63) await new Promise<void>((resolve) => setImmediate(resolve));
		const file = join(dir, name);
		const tombstone = file.slice(0, -LEASE_REGISTRY_SUFFIX.length);
		try {
			withFileLockSync(tombstone, () => {
				const registry = readLeaseRegistry(file);
				if (!registry) return;
				if (orchestrationSessionDeletionFile(home, registry.parentSessionId) !== tombstone) {
					harnessLog.warn("sessions", "a lease registry names a session it does not belong to; it is left", {
						home: logName,
						file,
					});
					return;
				}
				const { parentSessionId, holders } = registry;
				const kept = holders.filter((holder) => !isOwnerProvenDeadOnThisMachine(holder.owner));
				if (kept.length !== holders.length) writeHolders(file, parentSessionId, kept);
				const elsewhere = kept.flatMap((holder) => {
					const standing = judgeOwner(holder.owner);
					return standing === "foreign" ? [sessionLeaseHolderRef(holder, standing)] : [];
				});
				if (elsewhere.length > 0) heldElsewhere.set(registry.parentSessionId, elsewhere);
			});
		} catch (error) {
			harnessLog.warn("sessions", "a lease registry was not swept; it is left", {
				home: logName,
				file,
				detail: describe(error),
			});
		}
	}
	return heldElsewhere;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
