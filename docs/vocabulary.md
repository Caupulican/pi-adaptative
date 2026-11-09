# Vocabulary

One definition per concept. Use the preferred term in new code, new comments and new user-facing text. Existing identifiers are not renamed: where the code already uses a word for a different thing, the "Do not use" column says what the word means elsewhere, so a reader can tell the two apart.

The "Defined in" column is generated from the exported type named in the "Type" column, by `node scripts/vocabulary-map.mjs` (checked by `check:static`). A type that is no longer exported, or is exported from two files, fails the check and the row must be fixed. The definitions and the other columns are hand-written. "—" marks a concept that has no single defining type.

Read this file with [architecture.md](architecture.md), which maps the modules that define these types.

## Terms

<!-- vocabulary-map:start -->
| Concept | Preferred term | Meaning | Type | Defined in | Do not use |
|---|---|---|---|---|---|
| owner | owner | The human whose own typed words, or words from a verified owner channel, set a run's authority; automation the owner set up never does. | TurnOriginKind | `packages/coding-agent/src/kernel/turn-origin-stamp.ts` | operator or user for the human; principal |
| user | user message | The provider's message role for a turn's input; it never names a person. | UserMessage | `packages/ai/src/types.ts` | user as a name for the human (use owner or third party) |
| operator | operator projection | The status view of an objective (its phase, control and active actors) as the owner reads it. | OperatorProjection | `packages/coding-agent/src/core/operator-projection/types.ts` | operator as a name for the human or for a worker role |
| worker | worker | A delegated model run: one task attempt executed under a worker execution contract on a lane, reporting to its parent. | WorkerExecutionContract | `packages/coding-agent/src/core/orchestration/contracts.ts` | subagent, child agent, sub-agent; agent for a delegated run |
| agent | agent loop | The running model loop: the kernel Agent, which owns a transcript and runs tools; an AgentSession wraps it for one session. | Agent | `packages/coding-agent/src/kernel/agent.ts` | agent for a worker run or a bot; agentDir, which is the config directory |
| agent identity | agent binding | The durable logical identity (agentId) that a replacement process resumes. | AgentBindingContract | `packages/coding-agent/src/core/orchestration/contracts.ts` | agent for a process; agent id for a bot record until that id space is confirmed |
| specialist | specialist spec | A synthesized role spec with a lifetime (one task, session, project or global), or a live worker a session reuses for a matching specialization. | SpecialistSpec | `packages/coding-agent/src/core/adaptive/types.ts` | specialist for a reusable profile (say orchestration profile) |
| bot | bot | A persistent, owner-visible identity with a soul, a model and a chat, which runs as worker turns and can be a routine target. | PersistentBotRecord | `packages/coding-agent/src/core/delegation/persistent-bot-team-store.ts` | bot daemon, which is a detached process; platform bot, which is a chat-platform sender |
| leader | standing leader, goal leader | A bot flagged to lead: it works a delegated goal with the bots it owns and reports once. | LeaderCharter | `packages/coding-agent/src/core/delegation/leader-delegation-ledger.ts` | leader for a machine's root session (placement kind); lead for the foreground model |
| lane | lane | One background execution record, tracked live and persisted when it ends; it projects one attempt. | LaneRecord | `packages/coding-agent/src/core/autonomy/lane-tracker.ts` | lane for a git worktree (say worktree lane) or a shell pool lane |
| attempt | attempt | One durable execution of a task under a grant and a lease, by one agent. | AttemptRuntimeState | `packages/coding-agent/src/core/orchestration/task-runtime-state.ts` | attempt for a CI run or a peer review; retry as a synonym |
| task | task | A unit of delegated work under an objective, with a role, dependencies and acceptance criteria, run by one or more attempts. | TaskContract | `packages/coding-agent/src/core/orchestration/contracts.ts` | task for a checklist item (say task step) or a background tool call (say background tool task) |
| task step | task step | One item of the foreground checklist that the task_steps tool keeps. | TaskStep | `packages/coding-agent/src/core/tasks/task-state.ts` | bare step; task for a checklist item |
| objective | objective | The orchestration container of tasks and evidence, with acceptance criteria and a risk budget; a goal, a plan's work and a leader delegation each live under one. | ObjectiveContract | `packages/coding-agent/src/core/orchestration/contracts.ts` | objective for the goal's text (say goal text) |
| goal | goal | The owner-requested outcome, with requirements, evidence and a status lifecycle, persisted per session. | GoalState | `packages/coding-agent/src/core/goals/goal-state.ts` | goal for a leader's request (say lead request); objective for the goal |
| plan | plan | A versioned graph of work and join nodes that the plan executor releases as tasks onto the fleet. | PlanRecord | `packages/coding-agent/src/core/plan/plan-graph.ts` | plan for a provider subscription; plan for a checklist |
| step | plan step | One node of a plan as the plan tool writes it. | PlanNodeSpec | `packages/coding-agent/src/core/plan/plan-graph.ts` | bare step |
| machine | machine | One pi install, identified by the machine id its install generated; the owner gives it a label. | MachineIdentity | `packages/coding-agent/src/core/remote/registry.ts` | node for a machine (node is a plan node); peer for a machine |
| peer | chat-mesh peer | A session connected on the local chat mesh. | PeerRecord | `packages/coding-agent/src/core/chat/state.ts` | bare peer; say link peer (the other machine on a link), collaboration member or peer reviewer |
| hub | hub | The listening side of a machine link: one session per agent directory hosts it, and machines join it with a secret. | RemoteHub | `packages/coding-agent/src/core/remote/hub.ts` | channel hub; hub for the main checkout (say main checkout) |
| join | join node | A plan node that combines member outcomes in one of the offered ways: collect, reduce, vote, race, verify or merge (each merge lands its members' worktrees in order). | JoinResult | `packages/coding-agent/src/core/plan/joins.ts` | link join (say joined hub) |
| routine | routine | A persisted, owner-authored schedule (calendar, interval, host event or watch) whose firings run a prompt for a bot, a team or a session. | PersistentRoutineDefinition | `packages/coding-agent/src/core/routines/routine-contract.ts` | cron job; scheduled task |
| occurrence | routine occurrence | One recorded firing of a routine, with its trigger and phase. | RoutineOccurrence | `packages/coding-agent/src/core/routines/routine-contract.ts` | event for a schedule firing; host event, which is a GitHub or platform event |
| notice | harness notice | One owner-actionable state: a stable reason plus the one line the owner reads, saved once per episode. | HarnessNotice | `packages/coding-agent/src/core/harness-notice.ts` | terminal notice (a worker result sent to the model); notification; note |
| record | session entry | One row of a session transcript. | SessionEntry | `packages/coding-agent/src/kernel/session/session-entries.ts` | bare record for a transcript row; record for live state (LaneRecord is live, not durable) |
| handoff | handoff | A transfer of responsibility for work from one party to another: a foreground call moved to a background task, or a rule conflict handed to System One. | — | — | handoff for a result (say terminal delivery) |
| terminal delivery | terminal delivery | Delivering a worker's terminal result to the parent that started it. | WorkerTerminalHandoff | `packages/coding-agent/src/core/delegation/worker-terminal-handoff-coordinator.ts` | handoff for the result |
| fleet | fleet | The scheduler that prepares and admits dispatches from plans, leaders and the delegate tool, using room terms. | FleetScheduler | `packages/coding-agent/src/core/fleet/fleet-types.ts` | fleet for the set of linked machines (say linked machines) |
| room | room | A capacity count: how many more nodes one term admits; the smallest term decides. | RoomTerm | `packages/coding-agent/src/core/fleet/fleet-types.ts` | room for a machine's job slots or a container of peers |
| window | account window | The adaptive count of concurrent fleet workers one provider account serves. | AccountWindows | `packages/coding-agent/src/core/fleet/capacity/account-window.ts` | usage window, which is a provider quota period; spend window; context window |
| admit | admit | The synchronous decision that turns a prepared dispatch into a running task and attempt, a queued one, or a refusal. | AdmitDecision | `packages/coding-agent/src/core/fleet/fleet-types.ts` | admission alone (say provider admission, channel wake gate or preference gate) |
| prepare | prepare | The asynchronous first phase of a worker start; it persists nothing until admit materializes it or a cancel releases it. | PrepareDecision | `packages/coding-agent/src/core/fleet/fleet-types.ts` | release for a prepared dispatch (a plan release binds a node to a task; keep the two apart) |
<!-- vocabulary-map:end -->

## Naming rule for new code

- Two to four words, one of them a domain word from this file (for example `leader_delegation`, not `handleLeaderDelegationRequestForPlanNode`).
- No sentence names: a name states what the thing is, not what it does in a flow.
- New code uses the preferred term. Existing names are not renamed for this rule; they are brought in line only where a change already touches them.
