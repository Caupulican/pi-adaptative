/**
 * The English words of Auto Learn as the owner reads them: the status block, the notes a settled or re-offered run
 * leaves on the status row, what a launch refused with, the authentication label beside a model in the picker, the
 * footer badge, and the note the model picker adds to an unconfigured model name. The prompts a learner reads, the log
 * lines and the handoff note stay as they are in every language.
 */

export const AUTO_LEARN = {
	title: "Auto Learn status",
	enabled: (on: boolean) => `Enabled: ${on}`,
	model: (model: string) => `Model: ${model}`,
	nextDecision: (value: string) => `Next decision: ${value}`,
	nextReady: "ready",
	messages: (count: number, maximum: number) => `Messages: ${count}/${maximum}`,
	context: (percent: string, maximum: number) => `Context: ${percent}/${maximum}%`,
	cooldown: (value: string) => `Cooldown: ${value}`,
	cooldownRemaining: (minutes: number) => `${minutes}m remaining`,
	ready: "ready",
	reflection: (status: string, toolCalls: number) =>
		`Current-session reflection: ${status} (complex trigger ${toolCalls} tool calls; automatic provider requests 0)`,
	historyRetention: "History retention: 7 days for internal Auto Learn prompts/logs/sessions",
	runningLearners: (count: number, maximum: number) => `Running learners: ${count}/${maximum}`,
	otherProjects: (count: number) => `Learners of other projects: ${count}`,
	artifactFolder: (dir: string) => `Artifact folder: ${dir}`,
	reloadBlockers: (value: string) => `Pi auto-reload blockers: ${value}`,
	reloadBlockerCount: (count: number) => `${count} other session(s)`,
	inFlight: (count: number) => `In-process reload-gate work: ${count > 0 ? `${count} unit(s)` : "none"}`,
	runs: "Runs:",
	noRuns: "- none",
	runLine: (kind: string, model: string, status: string, logPath: string) =>
		`- ${kind} learner on ${model}, ${status}; log: ${logPath}`,
	runKindReflection: "reflection",
	runKindAutomatic: "automatic",
	runStatusStarting: "starting",
	runStatusRunning: "running",
	unknownContext: "unknown",
	enabledWord: "enabled",
	disabledWord: "disabled",
	none: "none",
	outcome: {
		reported: "finished",
		child_failed: "the learner failed",
		unparseable: "its result could not be read",
		learner_not_pass: "the learner did not pass",
		parent_session_changed: "its session changed before it finished",
		apply_failed: "its proposals could not be applied",
	},
	settled: (outcome: string, detail: string | undefined, applied: number, open: number, persisted: boolean) =>
		`Auto Learn: ${outcome}${detail ? ` (${detail})` : ""}; ${applied} applied, ${open} recorded as findings${persisted ? "" : " (result not saved)"}`,
	reoffered: (outcome: string, applied: number, findings: number) =>
		`Auto Learn: re-offered proposals, ${outcome}; ${applied} applied, ${findings} recorded as findings`,
	usageRecordsLost: "Auto Learn: could not recover its usage records.",
	needsAttention: (count: number) => `Auto Learn: ${count} saved learning result(s) need attention.`,
	reofferUnconfirmed: "Auto Learn: could not confirm a re-offered result.",
	noticePending: "Auto Learn: a notice was delivered; some saved copies are still pending cleanup.",
	deferred: (count: number, nearRetention: number) =>
		`Auto Learn: ${count} unapplied proposal set${count > 1 ? "s are" : " is"} held for this project; they are offered when autoLearn is enabled.${
			nearRetention > 0
				? ` ${nearRetention} deferred set${nearRetention === 1 ? " is" : "s are"} approaching or beyond the normal retention age; review before cleanup.`
				: ""
		}`,
	notStarted: (reason: string) => `Auto Learn not started: ${reason}`,
	started: (logPath: string) => `Auto Learn started. Log: ${logPath}`,
	reflectionCurrentOnly:
		"automatic reflection runs only in the current root session; background reflection learners are disabled.",
	noActiveModel: "no active model is available for model=active.",
	cliPathMissing: "could not resolve current pi CLI path.",
	nullByte: (input: string) => `Auto Learn not started: ${input} contains a null byte.`,
	promptWriteFailed: (message: string, logPath: string) =>
		`Auto Learn not started: failed to write prompt file (${message}). Log: ${logPath}`,
	accountingUnavailable: (error: string) => `Auto Learn not started: accounting obligation unavailable (${error}).`,
	spawnFailedWithMessage: (message: string, logPath: string) =>
		`Auto Learn not started: failed to spawn background learner (${message}). Log: ${logPath}`,
	spawnFailed: (logPath: string) => `Auto Learn not started: failed to spawn background learner. Log: ${logPath}`,
	learningBadge: "(learning)",
	current: " · current",
	auth: {
		subscription: "subscription",
		apiKey: "API key",
		runtime: (label: string) => `runtime ${label}`,
		runtimeApiKey: "runtime API key",
		environment: (label: string) => `env ${label}`,
		environmentApiKey: "environment API key",
		modelsJsonKey: "models.json API key",
		modelsJsonCommand: "models.json command",
		customConfig: "custom provider config",
		configured: "configured",
	},
	unverifiedModel: (value: string) =>
		`Auto Learn model "${value}" is not in configured subscription/API models; saved as manual/unverified.`,
};
