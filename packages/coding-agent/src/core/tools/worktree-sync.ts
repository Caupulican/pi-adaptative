import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ResolvedWorktreeSyncSettings } from "../settings-manager.ts";
import type { ConflictWorklist, SyncStatus } from "../worktree-sync/codes.ts";
import {
	abortSync,
	buildSyncStatus,
	continueSync,
	createLane,
	landLane,
	reconcile,
	releaseLane,
	syncLane,
	type WorktreeSyncEngineDeps,
} from "../worktree-sync/git-engine.ts";

/**
 * `worktree_sync` -- the ENTIRE agent-facing surface of the worktree-per-lane workflow: a closed
 * action set over the engine (`core/worktree-sync/git-engine.ts`) so agents never improvise git
 * ceremony. Every outcome carries a tagged code in `details`; refusal text always names the exact
 * recovery step. See docs/worktree-sync.md for the workflow and the G1-G11 gate table.
 */

function createWorktreeSyncSchema() {
	return Type.Object(
		{
			action: Type.Union(
				[
					Type.Literal("status"),
					Type.Literal("create_lane"),
					Type.Literal("sync"),
					Type.Literal("continue"),
					Type.Literal("abort_sync"),
					Type.Literal("land"),
					Type.Literal("release_lane"),
					Type.Literal("reconcile"),
				],
				{
					description:
						"status: the deterministic full picture (epoch, hub, lock, per-lane freshness/staleness, advice). create_lane: new worktree+branch off main. sync: rebase current main into a lane (conflicts return a worklist and leave the rebase in progress). continue: verify resolved conflicts (zero markers, mechanically checked), stage, drive on. abort_sync: abort the in-progress rebase. land: the ONLY door to main -- serialized, freshness-checked, gate-command-verified, ff-only. release_lane: remove a fully-landed lane (discarding unlanded work needs confirm). reconcile: re-sync the registry with git reality.",
				},
			),
			laneKey: Type.Optional(
				Type.String({
					description:
						"Target lane. Defaults to this session's bound lane (PI_WORKTREE_LANE) for sync/continue/abort_sync/land.",
				}),
			),
			goalId: Type.Optional(
				Type.String({ description: "create_lane: goal to scope the auto-allocated lane key by." }),
			),
			requirementId: Type.Optional(Type.String({ description: "create_lane: requirement this lane will work." })),
			confirm: Type.Optional(
				Type.String({
					description:
						'release_lane: pass exactly "yes-discard-lane" to release a lane that still has unlanded commits or dirty files (G11: never silent).',
				}),
			),
		},
		{ additionalProperties: false },
	);
}

const worktreeSyncSchema = createWorktreeSyncSchema();

export type WorktreeSyncToolInput = Static<typeof worktreeSyncSchema>;

export interface WorktreeSyncToolDeps {
	engineDeps: () => WorktreeSyncEngineDeps;
	settings: () => ResolvedWorktreeSyncSettings;
	boundLaneKey: () => string | undefined;
	/** True iff this is a worker session (see session-role.ts) -- narrows the action surface below. */
	isWorker: () => boolean;
}

/** Actions a worker session may run unconditionally -- read-only status plus the sync/conflict
 * cycle on its own bound lane. Everything else is refused as `role_forbidden`, EXCEPT `land`,
 * which is instead gated by the `worktreeSync.workerLand` setting (still subject to normal
 * ownership/freshness gating downstream when allowed). */
const WORKER_ALLOWED_ACTIONS: ReadonlySet<WorktreeSyncToolInput["action"]> = new Set([
	"status",
	"sync",
	"continue",
	"abort_sync",
]);

function formatWorklist(worklist: ConflictWorklist): string[] {
	const lines = [
		`Conflicts at rebase step ${worklist.step}${worklist.stoppedAtCommit ? ` (replaying ${worklist.stoppedAtCommit.sha.slice(0, 12)}: ${worklist.stoppedAtCommit.subject})` : ""}:`,
	];
	for (const file of worklist.files) {
		lines.push(`- ${file.path} [${file.kind}]`);
	}
	lines.push(
		'Resolve the zdiff3 hunks in exactly these files (base section included), save, then call {"action":"continue"}. Staging and marker verification are automatic.',
	);
	return lines;
}

function formatStatus(status: SyncStatus): string[] {
	const lines = [
		`epoch ${status.epoch} | main ${status.mainBranch}@${status.mainSha.slice(0, 12)}` +
			`${status.hub ? ` | hub ${status.hub.clean ? "clean" : "has local changes"}` : " | hub: main not checked out"}` +
			`${status.lock.held ? ` | LOCK held by pid ${status.lock.holder?.pid ?? "?"}` : ""}`,
	];
	for (const lane of status.lanes) {
		const flags = [
			lane.registrationStatus !== "active" ? lane.registrationStatus : undefined,
			lane.rebaseInProgress ? "REBASE-IN-PROGRESS" : undefined,
			lane.syncRequired ? "SYNC-REQUIRED" : lane.stale ? "stale" : "fresh",
			lane.dirty ? "dirty" : undefined,
		]
			.filter(Boolean)
			.join(", ");
		lines.push(
			`- ${lane.laneKey} (${lane.branch}) +${lane.aheadOfMain}/-${lane.behindMain} [${flags}]` +
				`${lane.overlapWithLastLand.length > 0 ? ` overlap: ${lane.overlapWithLastLand.slice(0, 5).join(", ")}` : ""}`,
		);
	}
	if (status.lanes.length === 0) lines.push("(no lanes)");
	if (status.advice) lines.push(`advice: ${status.advice}`);
	return lines;
}

const WORKTREE_SYNC_PROMPT_GUIDELINES = [
	"Work ONLY inside your lane worktree on your lane branch; never edit the hub checkout or touch main directly -- main moves exclusively through the land action.",
	"Commit your work on the lane branch, then land. Landing is refused while the lane is stale (G3): call sync first, resolve conflicts locally, then land.",
	"When a sync stops on conflicts, edit exactly the listed files, then call continue -- staging, marker verification, and rebase continuation are mechanical.",
	"After any other lane lands, your lane becomes stale; under the mandatory policy your file mutations are refused until you sync. git add/commit stay available to save WIP first.",
	"Check status when unsure -- it is the deterministic full picture; never infer sync state from raw git output.",
];

export function createWorktreeSyncToolDefinition(deps: WorktreeSyncToolDeps): ToolDefinition {
	return {
		name: "worktree_sync",
		label: "worktree_sync",
		description:
			"Hard-gated worktree-per-lane parallel work: each agent works in its own git worktree/branch; integration is always rebase-onto-main + ff-only land, serialized under one integration lock with the gate command verified at the exact landing tip. status/create_lane/sync/continue/abort_sync/land/release_lane/reconcile. Every outcome is a tagged code with the exact recovery step; landing while stale is structurally impossible.",
		promptSnippet: "Coordinate parallel work: lane worktrees, rebase-onto-main sync, serialized gated landing.",
		promptGuidelines: WORKTREE_SYNC_PROMPT_GUIDELINES,
		parameters: worktreeSyncSchema,
		executionMode: "sequential",
		async execute(_toolCallId, input: WorktreeSyncToolInput, signal) {
			const engineDeps: WorktreeSyncEngineDeps = { ...deps.engineDeps(), ...(signal ? { signal } : {}) };
			const settings = deps.settings();
			const laneKey = input.laneKey ?? deps.boundLaneKey();

			const respond = (lines: string[], details: unknown) => ({
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: details as Record<string, unknown>,
			});
			const needLane = (): string | undefined => {
				if (laneKey) return undefined;
				return "laneKey required: pass laneKey, or run inside a lane-bound session (PI_WORKTREE_LANE).";
			};

			if (deps.isWorker()) {
				const bound = deps.boundLaneKey();
				if (input.laneKey !== undefined && input.laneKey !== bound) {
					const message = "workers may only target their bound lane";
					return respond([message], { code: "role_forbidden", message });
				}
				const landAllowed = input.action === "land" && settings.workerLand === "allow";
				if (!WORKER_ALLOWED_ACTIONS.has(input.action) && !landAllowed) {
					const message =
						input.action === "land"
							? 'workers may not land (worktreeSync.workerLand is "deny")'
							: `workers may not run action "${input.action}"`;
					return respond([message], { code: "role_forbidden", message });
				}
			}

			switch (input.action) {
				case "status": {
					const status = await buildSyncStatus(engineDeps, { policy: settings.syncPolicy });
					if (status.code !== "ok") return respond([`[${status.code}] ${status.message}`], status);
					return respond(formatStatus(status), status);
				}
				case "create_lane": {
					const created = await createLane(engineDeps, {
						...(input.laneKey !== undefined ? { laneKey: input.laneKey } : {}),
						...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
						...(input.requirementId !== undefined ? { requirementId: input.requirementId } : {}),
					});
					if (created.code !== "ok") return respond([`[${created.code}] ${created.message}`], created);
					return respond(
						[
							`lane '${created.lane.laneKey}' created: branch ${created.lane.branch}, checkout ${created.lane.worktreePath}`,
						],
						created,
					);
				}
				case "sync": {
					const missing = needLane();
					if (missing) return respond([missing], { code: "lane_not_found", message: missing });
					const synced = await syncLane(engineDeps, { laneKey: laneKey as string });
					if (synced.code === "sync_clean") {
						return respond(
							[
								synced.alreadyFresh
									? `lane '${synced.laneKey}' already contains current main -- nothing to do`
									: `lane '${synced.laneKey}' rebased onto current main (auto-continued ${synced.autoContinued} step(s))`,
							],
							synced,
						);
					}
					if (synced.code === "sync_conflicts") return respond(formatWorklist(synced.worklist), synced);
					return respond(
						[`[${synced.code}] ${synced.message}${synced.paths ? `\n${synced.paths.join("\n")}` : ""}`],
						synced,
					);
				}
				case "continue": {
					const missing = needLane();
					if (missing) return respond([missing], { code: "lane_not_found", message: missing });
					const continued = await continueSync(engineDeps, { laneKey: laneKey as string });
					if (continued.code === "sync_clean") {
						return respond(
							[`lane '${continued.laneKey}' rebase completed -- lane is fresh relative to the synced main`],
							continued,
						);
					}
					if (continued.code === "sync_conflicts") return respond(formatWorklist(continued.worklist), continued);
					return respond(
						[
							`[${continued.code}] ${continued.message}${continued.paths ? `\n${continued.paths.join("\n")}` : ""}`,
						],
						continued,
					);
				}
				case "abort_sync": {
					const missing = needLane();
					if (missing) return respond([missing], { code: "lane_not_found", message: missing });
					const aborted = await abortSync(engineDeps, { laneKey: laneKey as string });
					if (aborted.code !== "ok") return respond([`[${aborted.code}] ${aborted.message}`], aborted);
					return respond(
						[`lane '${aborted.laneKey}' rebase aborted -- back to its pre-sync tip (still stale)`],
						aborted,
					);
				}
				case "land": {
					const missing = needLane();
					if (missing) return respond([missing], { code: "lane_not_found", message: missing });
					const landed = await landLane(engineDeps, {
						laneKey: laneKey as string,
						gate: settings.gate,
						...(settings.gateCommand !== undefined ? { gateCommand: settings.gateCommand } : {}),
						gateTimeoutMs: settings.gateTimeoutMs,
					});
					if (landed.code !== "ok") {
						return respond(
							[`[${landed.code}] ${landed.message}${landed.paths ? `\n${landed.paths.join("\n")}` : ""}`],
							landed,
						);
					}
					return respond(
						[
							`lane '${landed.laneKey}' LANDED: epoch ${landed.epoch}, main is now ${landed.mainSha.slice(0, 12)} (gate: ${landed.gate}). All other lanes must sync before their next land.`,
						],
						landed,
					);
				}
				case "release_lane": {
					const missing = needLane();
					if (missing) return respond([missing], { code: "lane_not_found", message: missing });
					const released = await releaseLane(engineDeps, {
						laneKey: laneKey as string,
						...(input.confirm !== undefined ? { confirm: input.confirm } : {}),
					});
					if (released.code !== "released") return respond([`[${released.code}] ${released.message}`], released);
					return respond([`lane '${released.laneKey}' released`], released);
				}
				case "reconcile": {
					const reconciled = await reconcile(engineDeps);
					if (reconciled.code !== "reconciled")
						return respond([`[${reconciled.code}] ${reconciled.message}`], reconciled);
					return respond(
						[
							`reconciled: ${reconciled.orphanedLaneKeys.length} orphaned, ${reconciled.reRegisteredLaneKeys.length} re-registered, ${reconciled.ownerClearedLaneKeys.length} owners cleared${reconciled.staleLockReleased ? ", stale lock released" : ""}`,
						],
						reconciled,
					);
				}
			}
		},
	};
}
