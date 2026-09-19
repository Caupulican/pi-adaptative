import { isAbsolute, relative, resolve } from "node:path";

export type InteractionPolicy = "edge_only" | "interactive" | "fully_silent_until_terminal";

export type NotificationPolicy = "terminal_or_edge" | "milestones" | "verbose";

export interface AuthorityFilesystemScope {
	readonly read_roots: readonly string[];
	readonly write_roots: readonly string[];
	readonly denied_roots: readonly string[];
}

export interface AuthorityExternalScope {
	readonly network?: boolean;
	readonly push?: boolean;
	readonly deploy?: boolean;
	readonly publish?: boolean;
	readonly destructive?: boolean;
	readonly legal_identity?: boolean;
	readonly financial?: boolean;
	readonly [key: string]: boolean | undefined;
}

export interface AuthoritySpendScope {
	readonly currency: string;
	readonly max_per_objective: number;
}

export interface AuthorityEnvelope {
	readonly schema_version: "2.0";
	readonly interaction_policy: InteractionPolicy;
	readonly notification_policy: NotificationPolicy;
	readonly filesystem: AuthorityFilesystemScope;
	readonly external: AuthorityExternalScope;
	readonly spend: AuthoritySpendScope;
}

export interface ProposedAction {
	readonly kind: string;
	readonly targetPath?: string;
	readonly networkRequested?: boolean;
	readonly pushRequested?: boolean;
	readonly deployRequested?: boolean;
	readonly deployTarget?: string;
	readonly publishRequested?: boolean;
	readonly destructiveRequested?: boolean;
	readonly costIncurred?: number;
}

export interface AuthorityValidationResult {
	readonly allowed: boolean;
	readonly edgeType?:
		| "authority"
		| "information"
		| "product_direction"
		| "legal_identity"
		| "financial"
		| "secret_scope"
		| "irreversible_external"
		| "semantic_gate_unavailable";
	readonly requiredAuthority?: string;
	readonly reason?: string;
	readonly alternativesTried?: readonly string[];
	readonly impact?: string;
}

function isPathInside(childPath: string, parentRoot: string): boolean {
	const rel = relative(parentRoot, childPath);
	return !rel.startsWith("..") && !isAbsolute(rel);
}

export function validateProposedAction(action: ProposedAction, envelope: AuthorityEnvelope): AuthorityValidationResult {
	// 1. Filesystem write verification
	if (action.targetPath) {
		const target = resolve(action.targetPath);

		// Check denied roots first
		for (const denied of envelope.filesystem.denied_roots) {
			if (isPathInside(target, resolve(denied))) {
				return {
					allowed: false,
					edgeType: "authority",
					requiredAuthority: `write_to_path:${target}`,
					reason: `Target path ${target} is within denied root ${denied}`,
					alternativesTried: ["check_alternate_staging_directory", "in_memory_buffer"],
					impact: "Writing to denied filesystem location could compromise secrets or sensitive files",
				};
			}
		}

		// Check write roots
		const inWriteRoot = envelope.filesystem.write_roots.some((root) => isPathInside(target, resolve(root)));
		if (!inWriteRoot) {
			return {
				allowed: false,
				edgeType: "authority",
				requiredAuthority: `write_root:${target}`,
				reason: `Target path ${target} is outside configured write roots: ${envelope.filesystem.write_roots.join(", ")}`,
				alternativesTried: ["use_project_local_scratch_dir"],
				impact: "Writing outside project bounds could alter system files",
			};
		}
	}

	// 2. External side effect permissions
	if (action.networkRequested && envelope.external.network !== true) {
		return {
			allowed: false,
			edgeType: "irreversible_external",
			requiredAuthority: "external:network",
			reason: "Network access requested but envelope has network=false",
			alternativesTried: ["use_local_offline_fixtures"],
			impact: "External network requests may exfiltrate data or mutate external state",
		};
	}

	if (action.pushRequested && envelope.external.push !== true) {
		return {
			allowed: false,
			edgeType: "irreversible_external",
			requiredAuthority: "external:push",
			reason: "Git push or remote publication requested without explicit authorization",
			alternativesTried: ["commit_locally_to_task_branch"],
			impact: "Publishing changes to remote upstream affects shared repository state",
		};
	}

	if (action.deployRequested && envelope.external.deploy !== true) {
		return {
			allowed: false,
			edgeType: "irreversible_external",
			requiredAuthority: "external:deploy",
			reason: "Deployment requested without explicit envelope authority",
			alternativesTried: ["local_build_verification"],
			impact: "Deployment modifies production or live environments",
		};
	}

	if (action.publishRequested && envelope.external.publish !== true) {
		return {
			allowed: false,
			edgeType: "irreversible_external",
			requiredAuthority: "external:publish",
			reason: "Package publish requested without explicit envelope authority",
			alternativesTried: ["local_pack_verification"],
			impact: "Publishing packages is irreversible",
		};
	}

	if (action.destructiveRequested && envelope.external.destructive !== true) {
		return {
			allowed: false,
			edgeType: "authority",
			requiredAuthority: "external:destructive",
			reason: "Destructive file or system operation requested without authorization",
			alternativesTried: ["soft_delete_to_trash", "backup_first"],
			impact: "Destructive operations risk data loss",
		};
	}

	// 3. Spend limits
	if (action.costIncurred && action.costIncurred > envelope.spend.max_per_objective) {
		return {
			allowed: false,
			edgeType: "financial",
			requiredAuthority: `spend_limit:${action.costIncurred}`,
			reason: `Cost ${action.costIncurred} exceeds objective spend ceiling ${envelope.spend.max_per_objective} ${envelope.spend.currency}`,
			alternativesTried: ["downgrade_worker_model", "reduce_concurrency"],
			impact: "Exceeds authorized financial budget",
		};
	}

	return { allowed: true };
}

export function createDefaultAuthorityEnvelope(repoRoot: string): AuthorityEnvelope {
	return {
		schema_version: "2.0",
		interaction_policy: "edge_only",
		notification_policy: "terminal_or_edge",
		filesystem: {
			read_roots: [repoRoot],
			write_roots: [repoRoot],
			denied_roots: [resolve(repoRoot, ".git"), resolve(repoRoot, ".env"), resolve(repoRoot, ".env.local")],
		},
		external: {
			network: true,
			push: false,
			deploy: false,
			publish: false,
			destructive: false,
			legal_identity: false,
			financial: false,
		},
		spend: {
			currency: "USD",
			max_per_objective: 10.0,
		},
	};
}
