# Task worker profiles

`profile_writer` lets the foreground orchestrator create the smallest worker profile needed for one bounded task. It does not edit user or project profile files.

Task profiles are:

- Derived only from an owner-authorized base profile.
- Immutable and assigned a `task-...` ID by Pi.
- Stored on the owning session branch, never shared across independent sessions.
- Limited to 32 profiles per session.
- Unable to add tools, resources, or budget beyond the base profile.
- Limited to configured, authenticated, non-exhausted models and a thinking level that model supports.

Use `profile_writer { action: "inspect" }` when the authorized bases or model combinations are unknown. Then call `create` with a concise task and only the fields that need narrowing. Pass the returned profile ID unchanged to `delegate`; never invent one.

Workers cannot invoke `profile_writer`, recursively delegate, or expand their admitted contract. A resumed worker retains the exact profile, model, resources, and transcript admitted for that task.
