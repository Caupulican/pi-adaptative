# Task steps

Pi includes a native `task_steps` tool for tracking ordered work inside the active session. It is enabled by default and persists versioned snapshots in the session JSONL, so resumed sessions recover the checklist without a separate extension or global state directory.

Task steps complement the native goal and delegation systems:

- `task_steps` tracks the current execution checklist.
- `goal` records durable outcome requirements and evidence.
- `delegate` starts isolated background worker lanes; `delegate_status` retrieves their results.

## Statuses

Each step has one of these statuses:

- `pending`
- `in_progress`
- `completed`
- `blocked`
- `cancelled`

Starting a step automatically returns any previous `in_progress` step to `pending`, so at most one step is active. Completed and cancelled steps are hidden from normal list output but remain in session state until compacted or cleared.

## Tool actions

The native tool supports:

- `set`: replace the ordered checklist.
- `intake`: replace the checklist with a complete item-preserving `steps` array.
- `add`: append one step.
- `update`: change a selected step and append notes or evidence.
- `list`: show open work; set `showCompleted` to include terminal steps.
- `compact`: archive completed and cancelled counts while retaining open work.
- `clear`: remove all tracked and archived steps.

An update selector can be `current`/`active`, an exact step ID, a unique ID prefix, or unique step content. IDs are shown in tool and command output for unambiguous updates.

Example:

```json
{
  "action": "set",
  "steps": [
    { "content": "Reproduce the issue", "status": "in_progress" },
    { "content": "Implement the smallest fix" },
    { "content": "Run focused regression tests" }
  ]
}
```

After validation:

```json
{
  "action": "update",
  "id": "current",
  "status": "completed",
  "evidence": ["test/regression.test.ts passed"]
}
```

## Interactive commands

Use `/task` or its `/steps` alias:

```text
/task                         # list open steps
/task all                     # include completed/cancelled steps
/task add <text>
/task start <selector>
/task done <selector> -- <evidence>
/task block <selector> -- <reason>
/task cancel <selector> -- <reason>
/task reopen <selector>
/task compact
/task clear
```

`/task <text>` is shorthand for `/task add <text>`.

## Background work migration

The old user-level task-steps extension also implemented detached jobs, teams, and polling. Those duplicate execution commands are not part of the native checklist. `/task run`, `/task route`, `/task bg`, and `/task team` now point to Pi's session-owned `delegate` and `delegate_status` tools instead.

Native worker lanes emit terminal handoff notifications and retain bounded results for explicit retrieval; task steps do not poll worker processes or inspect logs to detect completion.

## Persistence and isolation

Task state is stored only as custom entries in the active `SessionManager`. It follows normal session persistence, resume, and lifecycle behavior. Separate sessions cannot read or mutate each other's checklists, and malformed or future-version snapshots are ignored during restore.

Before each agent turn, Pi injects a hidden bounded reminder containing at most 12 open steps and a first-step steering line. Completed/cancelled history, generated IDs, and full evidence are omitted from that reminder. `/task` and `/steps` render the same native state in the interactive status surface; model tool calls remain visible in the transcript.
