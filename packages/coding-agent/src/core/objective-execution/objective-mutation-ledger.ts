/**
 * Paths a typed edit/write actually produced for one objective.
 * Shell output is not an ownership source. A digest that no longer matches the file is drift.
 * An empty or drifted ledger stays fail-closed for automatic shared-worktree commit.
 * Isolated per-objective worktrees are the future mode that could attribute shell edits.
 * This ledger does not infer that mode: shell mutation stays unattributed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface OwnedPathDigest {
	readonly path: string;
	readonly digest: string;
}

export type DeliveryOwnershipBlock = "shell_mutation_unattributed" | "ownership_drift";

export function normalizeRepoRelativePath(repoRoot: string, filePath: string): string | undefined {
	const absolute = isAbsolute(filePath) ? resolve(filePath) : resolve(repoRoot, filePath);
	const repoRelative = relative(resolve(repoRoot), absolute);
	if (!repoRelative || repoRelative.startsWith("..") || isAbsolute(repoRelative)) return undefined;
	return repoRelative.split(sep).join("/");
}

export function hashFileContents(absolutePath: string): string | undefined {
	try {
		return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
	} catch {
		return undefined;
	}
}

export class ObjectiveMutationLedger {
	private boundId = "";
	private readonly owned = new Map<string, Map<string, string>>();
	private readonly shellUnsafe = new Set<string>();
	private readonly drifted = new Set<string>();

	/** Move records captured before the charter id existed onto that objective. */
	bindObjective(objectiveId: string): void {
		if (!objectiveId || this.boundId === objectiveId) {
			this.boundId = objectiveId;
			return;
		}
		const previous = this.boundId;
		this.boundId = objectiveId;
		if (!previous) return;
		const prior = this.owned.get(previous);
		if (prior) {
			const next = this.owned.get(objectiveId) ?? new Map<string, string>();
			for (const [path, digest] of prior) next.set(path, digest);
			this.owned.set(objectiveId, next);
			this.owned.delete(previous);
		}
		if (this.shellUnsafe.delete(previous)) this.shellUnsafe.add(objectiveId);
		if (this.drifted.delete(previous)) this.drifted.add(objectiveId);
	}

	recordOwnedWrite(objectiveId: string, repoRoot: string, filePath: string): void {
		const repoRelative = normalizeRepoRelativePath(repoRoot, filePath);
		if (!repoRelative) return;
		const digest = hashFileContents(resolve(repoRoot, repoRelative));
		if (!digest) {
			this.drifted.add(objectiveId);
			return;
		}
		const paths = this.owned.get(objectiveId) ?? new Map<string, string>();
		paths.set(repoRelative, digest);
		this.owned.set(objectiveId, paths);
	}

	markShellUnsafe(objectiveId: string): void {
		this.shellUnsafe.add(objectiveId);
	}

	/** An owned path whose bytes changed without a new owned write is drift. */
	reconcile(objectiveId: string, repoRoot: string): void {
		const paths = this.owned.get(objectiveId);
		if (!paths) return;
		for (const [repoRelative, digest] of paths) {
			if (hashFileContents(resolve(repoRoot, repoRelative)) !== digest) this.drifted.add(objectiveId);
		}
	}

	deliveryBlockReason(objectiveId: string): DeliveryOwnershipBlock | undefined {
		if (this.shellUnsafe.has(objectiveId)) return "shell_mutation_unattributed";
		if (this.drifted.has(objectiveId)) return "ownership_drift";
		return undefined;
	}

	provenOwnedPaths(objectiveId: string): readonly string[] {
		if (this.deliveryBlockReason(objectiveId)) return [];
		return [...(this.owned.get(objectiveId)?.keys() ?? [])];
	}

	/**
	 * Every path a typed edit or write touched, with no delivery gate.
	 *
	 * Distinct from `provenOwnedPaths`, which returns nothing once shell mutation or drift makes the
	 * set unfit to commit from. A caller asking "did this session write here at all" needs the raw
	 * record: for that question an empty set means "this session wrote nothing", and answering it
	 * with the delivery gate's empty set would claim the session authored none of its own work.
	 */
	writtenPaths(objectiveId: string): readonly string[] {
		return [...(this.owned.get(objectiveId)?.keys() ?? [])];
	}

	ownedDigests(objectiveId: string): readonly OwnedPathDigest[] {
		if (this.deliveryBlockReason(objectiveId)) return [];
		return [...(this.owned.get(objectiveId)?.entries() ?? [])].map(([path, digest]) => ({ path, digest }));
	}
}
