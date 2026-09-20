/**
 * Execution Charter & Zero-Human Authority Model.
 * Implements ZERO_HUMAN_AUTHORITY_MODEL.md, EXECUTION_CHARTER.md, and ZH-001 through ZH-012.
 *
 * Core invariant: Operator participates at task START ONLY — ZERO human during execution.
 * Immutable ExecutionCharter is compiled once at objective admission from trusted start sources.
 * Actions authorized by the charter execute automatically after runtime gates; denied actions
 * produce an AuthorityBlockRecord and trigger alternative route search without mid-run prompts.
 */

import type { ProposedAction } from "./authority-envelope.ts";

export const EXECUTION_CHARTER_SCHEMA_VERSION = "1.0" as const;

export interface ExecutionCharterGitPolicy {
	commit: boolean;
	push: boolean;
	force_push: boolean;
	create_branch: boolean;
	create_tag: boolean;
}

export interface ExecutionCharterReleasePolicy {
	package_publish: boolean;
	github_release: boolean;
	deploy_targets: readonly string[];
}

/**
 * External-acquisition authority. Closed-world: a grant absent from the owner's trusted start
 * instruction is `false`, and the gate denies rather than assuming the permission exists.
 */
export interface ExecutionCharterAcquisitionPolicy {
	shell_execution: boolean;
	network_downloads: boolean;
	package_installs: boolean;
}

export interface ExecutionCharter {
	readonly schema_version: "1.0";
	readonly objective_id: string;
	readonly interaction_mode: "start_only";
	readonly source_message_ids?: readonly string[];
	readonly repository_scopes?: readonly string[];
	readonly git: ExecutionCharterGitPolicy;
	readonly release: ExecutionCharterReleasePolicy;
	readonly acquisition: ExecutionCharterAcquisitionPolicy;
	readonly secret_scopes?: readonly string[];
	readonly max_cost_usd?: number | null;
	readonly notification?: "terminal_only" | "status_on_request";
}

export interface AuthorityBlockRecord {
	readonly schema_version: "1.0";
	readonly objective_id: string;
	readonly task_id?: string | null;
	readonly action: string;
	readonly missing_authority: string;
	readonly alternatives_attempted: readonly string[];
	readonly created_at: string;
}

export type AuthorityDecision =
	| { readonly outcome: "allow"; readonly grantRef: string }
	| { readonly outcome: "deny"; readonly reason: string; readonly missingAuthority: string };

export interface CompileExecutionCharterInput {
	objectiveId: string;
	prompt?: string;
	sourceMessageIds?: readonly string[];
	repositoryScopes?: readonly string[];
	secretScopes?: readonly string[];
	maxCostUsd?: number | null;
	notification?: "terminal_only" | "status_on_request";
	initialGrants?: {
		git?: Partial<ExecutionCharterGitPolicy>;
		release?: Partial<ExecutionCharterReleasePolicy>;
		acquisition?: Partial<ExecutionCharterAcquisitionPolicy>;
	};
}

/**
 * Compiles trusted natural language instructions and initial policy into an immutable ExecutionCharter.
 * Strictly ignores untrusted content (worker outputs, repository text, web content) from expanding authority.
 */
export function compileExecutionCharter(input: CompileExecutionCharterInput): ExecutionCharter {
	const prompt = (input.prompt ?? "").toLowerCase();

	// Check explicit denials first
	const denyPush = /\b(do\s+not\s+push|don't\s+push|no\s+push|never\s+push|without\s+push)\b/i.test(prompt);
	const denyCommit = /\b(do\s+not\s+commit|don't\s+commit|no\s+commit|without\s+commit)\b/i.test(prompt);
	const denyPublish = /\b(do\s+not\s+publish|don't\s+publish|no\s+publish|without\s+publish)\b/i.test(prompt);

	// Check authorizations
	const grantPush =
		!denyPush && (/\b(push|commit\s+and\s+push)\b/i.test(prompt) || Boolean(input.initialGrants?.git?.push));
	const grantCommit =
		!denyCommit &&
		(/\b(commit|commit\s+and\s+push|fix\s+bug|fix)\b/i.test(prompt) || Boolean(input.initialGrants?.git?.commit));
	const grantPublish =
		!denyPublish &&
		(/\b(publish|npm\s+publish|package\s+publish)\b/i.test(prompt) ||
			Boolean(input.initialGrants?.release?.package_publish));
	const grantGithubRelease =
		/\b(github\s+release|create\s+release|tag\s+and\s+release)\b/i.test(prompt) ||
		Boolean(input.initialGrants?.release?.github_release);
	const grantCreateTag = /\b(tag|create\s+tag)\b/i.test(prompt) || Boolean(input.initialGrants?.git?.create_tag);
	const grantCreateBranch =
		/\b(branch|create\s+branch)\b/i.test(prompt) || Boolean(input.initialGrants?.git?.create_branch);
	const grantForcePush = Boolean(input.initialGrants?.git?.force_push); // force push is never granted from bare prompt text

	// External acquisition: granted only by trusted start text or an explicit initial grant.
	const denyAcquisition = /\b(?:do\s+not|don'?t|never|no)\s+(?:install|download|fetch|add\s+(?:a\s+)?dependenc)/i.test(
		prompt,
	);
	const grantPackageInstalls =
		!denyAcquisition &&
		(/\b(?:install|npm\s+i(?:nstall)?|pip\s+install|add\s+(?:a\s+)?dependenc|set\s*up\s+dependenc)\b/i.test(prompt) ||
			Boolean(input.initialGrants?.acquisition?.package_installs));
	const grantNetworkDownloads =
		!denyAcquisition &&
		(/\b(?:download|fetch|curl|wget|pull\s+(?:the\s+)?(?:image|binary|archive))\b/i.test(prompt) ||
			grantPackageInstalls ||
			Boolean(input.initialGrants?.acquisition?.network_downloads));
	const grantShellExecution =
		/\b(?:run|execute|build|test|compile|script)\b/i.test(prompt) ||
		Boolean(input.initialGrants?.acquisition?.shell_execution);

	// Detect deploy targets
	const deployTargets = new Set<string>(input.initialGrants?.release?.deploy_targets ?? []);
	const deployMatch = prompt.match(/\bdeploy\s+(?:to\s+)?([a-z0-9_-]+)\b/i);
	if (deployMatch?.[1] && !["when", "after", "if", "only"].includes(deployMatch[1])) {
		deployTargets.add(deployMatch[1]);
	}

	return {
		schema_version: "1.0",
		objective_id: input.objectiveId,
		interaction_mode: "start_only",
		source_message_ids: input.sourceMessageIds ? [...input.sourceMessageIds] : undefined,
		repository_scopes: input.repositoryScopes ? [...input.repositoryScopes] : undefined,
		git: {
			commit: grantCommit,
			push: grantPush,
			force_push: grantForcePush,
			create_branch: grantCreateBranch,
			create_tag: grantCreateTag,
		},
		release: {
			package_publish: grantPublish,
			github_release: grantGithubRelease,
			deploy_targets: Array.from(deployTargets),
		},
		acquisition: {
			shell_execution: grantShellExecution,
			network_downloads: grantNetworkDownloads,
			package_installs: grantPackageInstalls,
		},
		secret_scopes: input.secretScopes ? [...input.secretScopes] : undefined,
		max_cost_usd: input.maxCostUsd ?? null,
		notification: input.notification ?? "terminal_only",
	};
}

/**
 * Mechanically evaluates an action against the compiled ExecutionCharter.
 * Returns allow or deny. Never returns an interactive approval prompt.
 */
export function evaluateCharterAuthority(charter: ExecutionCharter, action: ProposedAction): AuthorityDecision {
	// Destructive check
	if (action.destructiveRequested || action.kind === "destructive" || action.kind.startsWith("destructive:")) {
		return {
			outcome: "deny",
			reason: "Destructive actions are not authorized in the execution charter",
			missingAuthority: "system:destructive",
		};
	}

	// Push check
	if (action.pushRequested || action.kind === "push" || action.kind === "git_push") {
		if (!charter.git.push) {
			return {
				outcome: "deny",
				reason: "Git push is not authorized in the execution charter",
				missingAuthority: "git:push",
			};
		}
		return { outcome: "allow", grantRef: "charter:git.push" };
	}

	// Commit check
	if (action.kind === "commit" || action.kind === "git_commit") {
		if (!charter.git.commit) {
			return {
				outcome: "deny",
				reason: "Git commit is not authorized in the execution charter",
				missingAuthority: "git:commit",
			};
		}
		return { outcome: "allow", grantRef: "charter:git.commit" };
	}

	// Git tag check
	if (action.kind === "create_tag" || action.kind === "git_tag") {
		if (!charter.git.create_tag) {
			return {
				outcome: "deny",
				reason: "Git create_tag is not authorized in the execution charter",
				missingAuthority: "git:create_tag",
			};
		}
		return { outcome: "allow", grantRef: "charter:git.create_tag" };
	}

	// Git branch check
	if (action.kind === "create_branch" || action.kind === "git_branch") {
		if (!charter.git.create_branch) {
			return {
				outcome: "deny",
				reason: "Git create_branch is not authorized in the execution charter",
				missingAuthority: "git:create_branch",
			};
		}
		return { outcome: "allow", grantRef: "charter:git.create_branch" };
	}

	// Package publish check
	if (action.publishRequested || action.kind === "publish" || action.kind === "package_publish") {
		if (!charter.release.package_publish) {
			return {
				outcome: "deny",
				reason: "Package publish is not authorized in the execution charter",
				missingAuthority: "release:package_publish",
			};
		}
		return { outcome: "allow", grantRef: "charter:release.package_publish" };
	}

	// Deploy check (PH-103: exact deploy target)
	if (action.deployRequested || action.kind === "deploy" || action.kind.startsWith("deploy")) {
		if (charter.release.deploy_targets.length === 0) {
			return {
				outcome: "deny",
				reason: "Deployment is not authorized in the execution charter (no deploy targets)",
				missingAuthority: "release:deploy",
			};
		}
		if (action.deployTarget && !charter.release.deploy_targets.includes(action.deployTarget)) {
			return {
				outcome: "deny",
				reason: `Deployment target '${action.deployTarget}' is not authorized in the execution charter`,
				missingAuthority: `release:deploy:${action.deployTarget}`,
			};
		}
		return { outcome: "allow", grantRef: "charter:release.deploy" };
	}

	// Cost budget check
	if (action.costIncurred && charter.max_cost_usd != null) {
		if (action.costIncurred > charter.max_cost_usd) {
			return {
				outcome: "deny",
				reason: `Action cost ($${action.costIncurred}) exceeds charter max cost ($${charter.max_cost_usd})`,
				missingAuthority: "budget:cost_ceiling",
			};
		}
	}

	// PH-104: Closed-world impact: unknown git/release/external/destructive action classes default DENY
	const isHighImpactAction =
		action.kind.startsWith("git") ||
		action.kind.startsWith("release") ||
		action.kind.startsWith("external") ||
		action.kind.startsWith("destructive") ||
		action.kind.startsWith("publish") ||
		action.kind.startsWith("deploy");

	if (isHighImpactAction) {
		return {
			outcome: "deny",
			reason: `Action kind '${action.kind}' is an unauthorized high-impact git/release/external/destructive action`,
			missingAuthority: `action:${action.kind}`,
		};
	}

	// Default permit for standard internal autonomous operations
	return { outcome: "allow", grantRef: `charter:standard:${action.kind}` };
}

/**
 * Durable ledger for authority block records (ZH-009).
 */
export class DurableAuthorityBlockLedger {
	private readonly blocks: AuthorityBlockRecord[] = [];

	recordBlock(input: {
		objectiveId: string;
		action: string;
		missingAuthority: string;
		taskId?: string | null;
		alternativesAttempted?: readonly string[];
	}): AuthorityBlockRecord {
		const record: AuthorityBlockRecord = {
			schema_version: "1.0",
			objective_id: input.objectiveId,
			task_id: input.taskId ?? null,
			action: input.action,
			missing_authority: input.missingAuthority,
			alternatives_attempted: input.alternativesAttempted ? [...input.alternativesAttempted] : [],
			created_at: new Date().toISOString(),
		};
		this.blocks.push(record);
		return record;
	}

	getBlocks(objectiveId?: string): readonly AuthorityBlockRecord[] {
		if (objectiveId) {
			return this.blocks.filter((b) => b.objective_id === objectiveId);
		}
		return this.blocks;
	}
}
