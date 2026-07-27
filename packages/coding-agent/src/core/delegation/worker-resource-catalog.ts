import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	MAX_WORKER_RESOURCE_METADATA_NAME_LENGTH,
	MAX_WORKER_RESOURCE_PATH_LENGTH,
	MAX_WORKER_RESOURCE_POINTERS,
	type ResourcePointer,
} from "../orchestration/contracts.ts";
import type { NormalizedProfile } from "../profile-registry.ts";
import type { ResourceLoader } from "../resource-loader.ts";
import { mergeResourceProfileSettings } from "../resource-profile-blocks.ts";
import { matchesResourceProfilePattern, type ResourceProfileSettings } from "../settings-manager.ts";

export interface WorkerResourceCatalogLoader {
	getDiscoverableSkillPaths(): string[];
	getDiscoverablePromptPaths(): string[];
}

export interface CatalogWorkerResourcePointersOptions {
	cwd: string;
	resourceLoader: WorkerResourceCatalogLoader;
	/** Profiles linked by one orchestration profile, in its declared deterministic order. */
	resourceProfiles: readonly Pick<NormalizedProfile, "resources">[];
	maxPointers?: number;
}

export type WorkerResourcePointerSelection =
	| { ok: true; pointers: readonly ResourcePointer[] }
	| {
			ok: false;
			reason: "worker_resource_pointer_unknown" | "worker_resource_pointer_duplicate";
			pointerId: string;
	  };

function canonicalFileUri(resourcePath: string): { path: string; uri: string } | undefined {
	try {
		const path = resolve(resourcePath);
		if (path.length === 0 || path.length > MAX_WORKER_RESOURCE_PATH_LENGTH) return undefined;
		return { path, uri: pathToFileURL(path).href };
	} catch {
		return undefined;
	}
}

function mergeWorkerResourceProfiles(
	resourceProfiles: readonly Pick<NormalizedProfile, "resources">[],
): ResourceProfileSettings {
	let merged: ResourceProfileSettings = {};
	for (const profile of resourceProfiles) {
		merged = mergeResourceProfileSettings(merged, profile.resources);
	}
	return merged;
}

function permittedByWorkerResourceProfile(
	resourcePath: string,
	filter: ResourceProfileSettings["skills"],
	cwd: string,
): boolean {
	const allow = filter?.allow ?? [];
	const block = filter?.block ?? [];
	// Worker pointers are an explicit capability grant. A block-only profile does not create a
	// discoverable pointer universe, even though interactive profile presentation supports it.
	if (allow.length === 0) return false;
	return (
		matchesResourceProfilePattern(resourcePath, allow, cwd) &&
		!matchesResourceProfilePattern(resourcePath, block, cwd)
	);
}

export function workerResourcePointerId(kind: "skill" | "prompt", resourcePath: string): string {
	const uri = pathToFileURL(resolve(resourcePath)).href;
	const digest = createHash("sha256").update(kind).update("\0").update(uri).digest("hex");
	return `${kind}:${digest}`;
}

/**
 * Metadata-only resource discovery for native workers. The ResourceLoader methods accepted here
 * deliberately expose paths only: no skill/prompt parser or extension loader can cross admission.
 */
export function catalogWorkerResourcePointers(options: CatalogWorkerResourcePointersOptions): ResourcePointer[] {
	const maxPointers = options.maxPointers ?? MAX_WORKER_RESOURCE_POINTERS;
	if (!Number.isSafeInteger(maxPointers) || maxPointers < 0 || maxPointers > MAX_WORKER_RESOURCE_POINTERS) {
		throw new TypeError(`maxPointers must be between 0 and ${MAX_WORKER_RESOURCE_POINTERS}.`);
	}
	if (maxPointers === 0) return [];
	const filters = mergeWorkerResourceProfiles(options.resourceProfiles);
	const canDiscoverSkills = (filters.skills?.allow?.length ?? 0) > 0;
	const canDiscoverPrompts = (filters.prompts?.allow?.length ?? 0) > 0;
	// UAC withholding means no discovery call, not merely filtering a discovered list afterwards.
	// Discovery can allocate, traverse extension roots, or reveal metadata even when no worker may use it.
	if (!canDiscoverSkills && !canDiscoverPrompts) return [];
	const candidates: Array<{ kind: "skill" | "prompt"; path: string }> = [];
	if (canDiscoverSkills) {
		for (const path of options.resourceLoader.getDiscoverableSkillPaths()) {
			if (typeof path === "string") candidates.push({ kind: "skill", path });
		}
	}
	if (canDiscoverPrompts) {
		for (const path of options.resourceLoader.getDiscoverablePromptPaths()) {
			if (typeof path === "string") candidates.push({ kind: "prompt", path });
		}
	}
	const pointers: ResourcePointer[] = [];
	const identities = new Set<string>();
	for (const candidate of candidates) {
		if (pointers.length >= maxPointers) break;
		const filter = candidate.kind === "skill" ? filters.skills : filters.prompts;
		if (!permittedByWorkerResourceProfile(candidate.path, filter, options.cwd)) continue;
		const canonical = canonicalFileUri(candidate.path);
		if (!canonical) continue;
		const id = workerResourcePointerId(candidate.kind, canonical.path);
		if (identities.has(id)) continue;
		const name = basename(canonical.path);
		if (!name || name.length > MAX_WORKER_RESOURCE_METADATA_NAME_LENGTH) continue;
		identities.add(id);
		pointers.push({
			id,
			kind: candidate.kind,
			uri: canonical.uri,
			readOnly: true,
			metadata: { name },
		});
	}
	return pointers.sort((left, right) => left.id.localeCompare(right.id));
}

/** Select exact admitted pointers only. Unknown and duplicate request ids remain denial reasons. */
export function selectWorkerResourcePointers(
	admittedPointers: readonly ResourcePointer[],
	requestedPointerIds: readonly string[],
): WorkerResourcePointerSelection {
	const admittedById = new Map(admittedPointers.map((pointer) => [pointer.id, pointer]));
	const selected: ResourcePointer[] = [];
	const seen = new Set<string>();
	for (const pointerId of requestedPointerIds) {
		if (seen.has(pointerId)) {
			return { ok: false, reason: "worker_resource_pointer_duplicate", pointerId };
		}
		seen.add(pointerId);
		const pointer = admittedById.get(pointerId);
		if (!pointer) return { ok: false, reason: "worker_resource_pointer_unknown", pointerId };
		selected.push(structuredClone(pointer));
	}
	return { ok: true, pointers: selected };
}

export type WorkerResourceCatalogResourceLoader = Pick<
	ResourceLoader,
	"getDiscoverableSkillPaths" | "getDiscoverablePromptPaths"
>;
