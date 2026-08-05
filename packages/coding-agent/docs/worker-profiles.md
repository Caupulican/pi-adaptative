# Task worker presets

Native delegation does not require a profile. `delegate.authority` can choose a child model, reasoning level, role label, classified tools, capabilities, paths, and budget directly. Omitted fields inherit from the caller, and Pi persists the resulting immutable execution grant.

`profile_writer` remains useful when the foreground orchestrator wants a reusable session-scoped preset. It does not edit user or project profile files. Task presets are:

- Derived only from an owner-authorized base profile.
- Immutable and assigned a `task-...` ID by Pi.
- Stored on the owning session branch, never shared across independent sessions.
- Limited to 32 presets per session.
- Unable to add tools, resources, or budget beyond the base profile.
- Limited to configured, authenticated, non-exhausted models and a reasoning level that model supports.

Use `profile_writer { action: "inspect" }` when the reusable bases or model combinations are unknown. Then call `create` with a concise task and only the defaults worth preserving. Pass the returned profile ID unchanged to `delegate`; never invent one.

Worker agents do not invoke `profile_writer`, but they do inherit `delegate` and may recursively create descendants, inspect exact paginated peer transcripts, and exchange threaded messages. A resumed worker retains the exact admitted preset or adaptive grant, model, resources, lineage, and transcript.
