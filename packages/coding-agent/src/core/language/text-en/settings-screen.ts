/**
 * The settings screen's words: every row label, description, submenu title, value word, hint and one-line
 * summary the settings selector draws. English is the reference text and the shape the Portuguese catalogue
 * is typed by. Machine values (the strings the settings files store and the code compares) never appear
 * here; they stay in the code and this catalogue supplies the label a person reads for them.
 */

export const SETTINGS_SCREEN = {
	/** Words the value column shows in place of a stored state. */
	values: {
		on: "On",
		off: "Off",
		onLower: "on",
		offLower: "off",
		notSet: "(not set)",
		unset: "(unset)",
		none: "(none)",
		inherit: "(inherit)",
		active: "active",
		agentChooses: "Agent chooses",
		agentChoosesEffort: "agent chooses effort",
		agentChoosesLower: "agent chooses",
		auto: "AUTO",
		autoTier: "(AUTO)",
		autonomyModeFull: "standing autonomy",
		noModel: "no model",
		unknown: "unknown",
		enterTask: "enter a task",
		show: "show",
		configure: "configure",
		yes: "Yes",
		no: "No",
	},
	/** The label a person reads for each stored value, keyed by the stored value itself. */
	valueLabels: {
		onOff: { true: "On", false: "Off" },
		scope: {
			global: "Global",
			project: "This project",
			directoryProfile: "This directory",
		},
		delivery: { "one-at-a-time": "One at a time", all: "All" },
		costGuardAction: { warn: "Warn only", downgrade: "Reduce reasoning" },
		projectContextScope: {
			"this-directory": "This directory",
			"this-project": "This project",
			"all-projects": "All projects",
		},
		projectContextLoad: {
			"global-only": "Global only",
			"on-demand": "On demand",
		},
		autonomyMode: {
			off: "Off",
			safe: "Safe",
			balanced: "Balanced",
			full: "Standing autonomy",
		},
		modelCapability: {
			auto: "Automatic",
			off: "Off",
			full: "Full",
			lean: "Lean",
			minimal: "Minimal",
			chat: "Chat",
		},
		routerSelection: { manual: "Manual", auto: "Automatic", hybrid: "Hybrid" },
		unsetModel: { "(unset)": "(unset)" } as Record<string, string>,
		routerPoolPreference: {
			"subscription-first": "Subscriptions first",
			balanced: "Balanced",
		},
		transport: {
			sse: "Streaming (SSE)",
			websocket: "WebSocket",
			"websocket-cached": "WebSocket, cached",
			auto: "Automatic",
		},
		httpIdleTimeout: {
			"30 sec": "30 sec",
			"1 min": "1 min",
			"2 min": "2 min",
			"5 min": "5 min",
			"11 min": "11 min",
			disabled: "disabled",
		} as Record<string, string>,
		doubleEscape: { tree: "Open tree", fork: "Fork", none: "None" },
		treeFilter: {
			default: "Default",
			"no-tools": "No tools",
			"user-only": "Your messages only",
			"labeled-only": "Labeled only",
			all: "All",
		},
		systemOneProvider: {
			auto: "Automatic",
			typesafe: "TypeSafe",
			openrouter: "OpenRouter",
		},
		hmoePreset: {
			balanced: "Balanced",
			quality: "Quality",
			"subscription-first": "Subscriptions first",
			cost: "Cost",
			speed: "Speed",
			"local-first": "Local first",
			custom: "Custom",
		},
		hmoeTeam: {
			single: "Single model",
			primary_critic: "Primary + critic",
			independent_verifier: "Independent verifier",
			adaptive_team: "Adaptive team",
		},
		hmoeIndependence: {
			none: "None",
			fresh_context: "Fresh context",
			distinct_profile: "Distinct profile",
			distinct_model: "Distinct model",
			distinct_family: "Distinct family",
			distinct_provider: "Distinct provider",
		},
		hmoePreference: {
			prefer_subscription: "Prefer subscription",
			prefer_local: "Prefer local",
			neutral: "Neutral",
		},
	},
	hints: {
		searchAndChange: "Type to search · Enter/Space to change · Esc to cancel",
		change: "Enter/Space to change · Esc to cancel",
		select: "Enter to select · Esc to go back",
		filterAndSelect: "Type to filter · Enter to select · Esc to go back",
		textInput: (emptyHint: string) => `Enter to save · Esc to go back · ${emptyHint}`,
		emptyClearsSetting: "empty clears the setting",
		noSettings: "No settings available",
		noMatch: "No matching settings",
	},
	/** The one-line state the value column of a row with a submenu shows. */
	summaries: {
		disabled: "disabled",
		disabledLegacyDirectApply: "disabled (legacy direct apply)",
		enabled: "enabled",
		enabledUnbounded: "enabled (unbounded)",
		selfModification: (hasPath: boolean): string => (hasPath ? "enabled" : "enabled (missing path)"),
		costGuard: (action: string, usd: string) => `${action} at $${usd}/turn`,
		autonomy: (mode: string, turns: string, stall: number, autoContinue: string) =>
			`${mode}, ${turns}, stall ${stall}, auto ${autoContinue}`,
		turns: (turns: number): string => (turns === 0 ? "unbounded turns" : `${turns} turns`),
		researchLane: (usd: string, runs: number) => `enabled ($${usd}/pass, ${runs} runs/session)`,
		contextCuration: (model: string, jobs: number) => `on · ${model} · ${jobs} jobs/turn`,
		learningPolicy: (autoApply: string, confidence: number) =>
			`on · auto-apply ${autoApply} · confidence at least ${confidence}`,
		modelCapabilityAuto: "Automatic (derived from the model's context window)",
		workerDelegationBudget: (usd: string) => `enabled ($${usd}/worker)`,
		autoLearn: (model: string) => `enabled (${model})`,
		contextPolicy: (preserve: number, minChars: number) => `enabled (preserve ${preserve}, min ${minChars} chars)`,
		contextMemoryOff: (externalConsent: string) => `disabled (${externalConsent})`,
		contextMemoryExternalConsent: (on: boolean): string => (on ? "external consent on" : "external off"),
		contextMemory: (max: number, inPrompt: string, external: string) =>
			`enabled (max ${max}${inPrompt}, ${external})`,
		contextMemoryInPrompt: ", in prompt",
		contextMemoryExternal: (on: boolean): string => (on ? "external on" : "local only"),
		router: (parts: {
			state: string;
			mode: string;
			pool: string;
			preference: string;
			gate: string;
			cheap: string;
			medium: string;
			expensive: string;
			learn: string;
		}) =>
			`${parts.state} · ${parts.mode} · pool ${parts.pool} · ${parts.preference} · ${parts.gate} · cheap: ${parts.cheap} · medium: ${parts.medium} · expensive: ${parts.expensive} · learn: ${parts.learn}`,
		routerGate: (on: boolean): string => (on ? "gate on" : "gate off"),
		routerTier: (model: string, thinking: string) => `${model} · thinking ${thinking}`,
	},
	/** The main list of the settings screen. */
	/** The scope a setting is saved to: the stored value stays the code's own word. */
	scopes: {
		global: "global",
		project: "project",
		directoryProfile: "directoryProfile",
	},
	statuses: {
		costGuardOn: (usd: string, action: string) => `Foreground cost guard enabled at $${usd}/turn (${action}).`,
		costGuardOff: "Foreground cost guard disabled.",
		httpIdleTimeout: (value: string) => `HTTP idle timeout: ${value}`,
		themeFailed: (name: string, error: string) =>
			`Failed to load theme "${name}": ${error}\nFell back to dark theme.`,
		projectContextOn: "lists this project's AGENTS.md",
		projectContextGlobalOnly: "global AGENTS.md only",
		projectContextWhere: {
			thisDirectory: "this directory",
			thisProject: "this project",
			allProjects: "all projects",
		},
		projectContextFiles: (load: string, where: string) =>
			`Project context files: ${load} (${where}). Run /reload to apply.`,
		selfModificationSaved: (scope: string) =>
			`Self modification settings saved to ${scope}. Start a new session or /reload for system-prompt guardrails to fully refresh.`,
		autonomySaved: (mode: string, scope: string) => `Autonomy mode ${mode} saved to ${scope}. Use /autonomy status.`,
		researchLaneSaved: (scope: string) =>
			`Research lane settings saved to ${scope}. Use /autonomy research or /autonomy diagnostics.`,
		workerDelegationSaved: (scope: string) =>
			`Worker delegation settings saved to ${scope}. The delegate tool uses them.`,
		learningPolicySaved: (scope: string) => `Learning policy saved to ${scope}.`,
		systemOneProviderSaved: (provider: string) =>
			`System One provider set to ${provider}; the next evaluation uses it.`,
		peerError: (error: string) => `Peer configuration error: ${error}`,
		peerSelectionDisabled: "disabled",
		peerSelection: (model: string, effort: string) => `${model} (${effort})`,
		peerOtherScope: (scope: string, activeScope: string, selection: string) =>
			`Peer saved to ${scope}; active ${activeScope} configuration remains ${selection}.`,
		peerSaved: (scope: string, reason: string) => `Peer settings saved to ${scope}: ${reason}`,
		peerToolUnavailable: "the root peer tool is unavailable in this session",
		peerDisabled: "Peer disabled; existing findings remain available.",
		peerApplied: (selection: string, scope: string) =>
			`Peer: ${selection}, saved to ${scope}. Applies to the next review; omitted effort uses the model default.`,
		modelCapabilitySaved: (scope: string) =>
			`Model capability mode saved to ${scope}. Applies on the next model switch or /reload.`,
		contextCurationSaved: (scope: string) =>
			`Context curation settings saved to ${scope}. Run /fitness <model> first if the model is unprobed.`,
		modelRouterSaved: (scope: string) =>
			`Model Router settings saved to ${scope}. Use /session or /usage to inspect routing.`,
		autoLearnSaved: (scope: string) =>
			`Auto Learn settings saved to ${scope}. Use /auto-learn status or /auto-learn run.`,
		contextPolicySaved: (scope: string) => `Context/prompt-policy settings saved to ${scope}.`,
		contextMemorySaved: (scope: string) => `Context/memory-retrieval settings saved to ${scope}.`,
	},
	rows: {
		autoCompact: {
			label: "Auto-compact",
			description: "Automatically compact context when it gets too large",
		},
		costGuard: {
			label: "Foreground cost guard",
			description: "Optional per-turn USD projection warning or reasoning downgrade; disabled by default",
		},
		steeringMode: {
			label: "Steering mode",
			description:
				"Enter while streaming queues steering messages. 'One at a time': deliver one, wait for response. 'All': deliver all at once.",
		},
		followUpMode: {
			label: "Follow-up mode",
			description: (key: string) =>
				`${key} queues follow-up messages until agent stops. 'One at a time': deliver one, wait for response. 'All': deliver all at once.`,
		},
		transport: {
			label: "Transport",
			description: "Preferred transport for providers that support multiple transports",
		},
		httpIdleTimeout: {
			label: "HTTP idle timeout",
			description:
				"Maximum idle gap while waiting for HTTP headers or body chunks. Disable for local models that pause longer than five minutes.",
		},
		hideThinking: {
			label: "Hide thinking",
			description: "Hide thinking blocks in assistant responses",
		},
		projectInstructions: {
			label: "Project instructions",
			description:
				"Opt in to this directory's AGENTS-family files, extensions, skills, and prompts. Global/bundled resources remain available.",
		},
		collapseChangelog: {
			label: "Collapse changelog",
			description: "Show condensed changelog after updates",
		},
		quietStartup: {
			label: "Quiet startup",
			description: "Disable verbose printing at startup",
		},
		doubleEscapeAction: {
			label: "Double-escape action",
			description: "Action when pressing Escape twice with empty editor",
		},
		treeFilterMode: {
			label: "Tree filter mode",
			description: "Default filter when opening /tree",
		},
		selfModification: {
			label: "Self modification",
			description: "Enable Pi self-evolution guardrails and configure the editable pi-adaptative source checkout",
		},
		autonomy: {
			label: "Autonomy",
			description: "Choose one autonomy preset instead of tuning many background-learning knobs",
		},
		researchLane: {
			label: "Research Lane",
			description:
				"Opt-in autonomous read-only research: bounded background passes that produce evidence bundles for active goals",
		},
		workerDelegation: {
			label: "Worker Delegation",
			description:
				"Default-on provider-neutral leaf workers with inherited authority and optional owner-authored execution presets",
		},
		learningPolicy: {
			label: "Learning Policy",
			description: "Gate reflection-sourced durable writes: proposals, confidence thresholds, audits, and rollback",
		},
		modelCapability: {
			label: "Model Capability",
			description:
				"How pi adapts the tool surface and lane budgets to small models (derived from the model's own metadata)",
		},
		contextCuration: {
			label: "Context Curation",
			description:
				"Opt-in local brain curator: digests GC-packed context stubs and scores stale-chunk relevance in small local-model jobs",
		},
		systemOneProvider: { label: "System One provider" },
		peer: { label: "Peer" },
		modelRouter: {
			label: "Model Router",
			description:
				"Router Setup: selection mode (Manual, Automatic or Hybrid), favorite candidate models, Subscriptions first preference, tier pins, calibration, route preview and diagnostics",
		},
		autoLearn: {
			label: "Auto Learn Advanced",
			description: "Advanced overrides for autonomous background learning/scavenging",
		},
		contextPolicy: {
			label: "Context / Prompt Policy",
			description:
				"Opt-in artifact-stub prompt-policy enforcement: stubs stale artifact-backed tool output in the model-visible prompt only, never the transcript. Requires the artifact retrieval tool to be active.",
		},
		contextMemory: {
			label: "Context / Memory Retrieval",
			description:
				"Default-on local safe-auto recall with budgeted prompt evidence. External query egress is a separate visible consent and remains off by default.",
		},
		warnings: {
			label: "Warnings",
			description: "Enable or disable individual warnings",
		},
		thinkingLevel: {
			label: "Thinking level",
			description: "Reasoning depth for the active model; delegation policy is configured independently",
		},
		theme: { label: "Theme", description: "Color theme for the interface" },
		resources: {
			label: "Resources",
			description: "Manage profiles/situations, library, and external resource sources.",
		},
		showImages: {
			label: "Show images",
			description: "Render images inline in terminal",
		},
		imageWidth: {
			label: "Image width",
			description: "Preferred inline image width in terminal cells",
		},
		autoResizeImages: {
			label: "Auto-resize images",
			description: "Resize large images to 2000x2000 max for better model compatibility",
		},
		blockImages: {
			label: "Block images",
			description: "Prevent images from being sent to LLM providers",
		},
		skillCommands: {
			label: "Skill commands",
			description: "Register skills as /skill:name commands",
		},
		showHardwareCursor: {
			label: "Show hardware cursor",
			description: "Show the terminal cursor while still positioning it for IME support",
		},
		editorPadding: {
			label: "Editor padding",
			description: "Horizontal padding for input editor (0-3)",
		},
		autocompleteMaxItems: {
			label: "Autocomplete max items",
			description: "Max visible items in autocomplete dropdown (3-20)",
		},
		clearOnShrink: {
			label: "Clear on shrink",
			description: "Clear empty rows when content shrinks (may cause flicker)",
		},
		terminalProgress: {
			label: "Terminal progress",
			description: "Show OSC 9;4 progress indicators in the terminal tab bar",
		},
	},
	/** The resources hub the Resources row opens. */
	resourcesMenu: {
		addCatalog: {
			label: "Add your catalog directory →",
			description: "First-run nudge: Add a directory of shared skills, extensions, profiles, and agents.",
		},
		profile: {
			label: "Profile / Situation",
			description: (current: string) => `Select the active profile/situation. Current: ${current}`,
		},
		library: {
			label: "Manage Library",
			description: "Toggle allowed tools/skills/extensions in the active profile/scope.",
		},
		profiles: {
			label: "Manage Profiles / Situations",
			description: "Create, delete, or persist profile/situation definitions.",
		},
		sources: {
			label: "Sources",
			description: (count: number) => `Manage external resource roots (${count} registered).`,
		},
		title: "Resources Hub",
		description: "Configure profiles/situations and external resource catalogs.",
		profileDefault: "Use configured profile selection (session default)",
	},
	costGuard: {
		title: "Foreground Cost Guard Threshold",
		description: "Enter a nonnegative finite USD projection threshold. The Enabled switch is still mandatory.",
		hint: "nonnegative finite number; invalid input keeps the current value",
		scope: {
			label: "Save scope",
			description: "Save this foreground cost guard globally or in the current project's .pi/settings.json",
		},
		enabled: {
			label: "Enabled",
			description: "Explicit opt-in. A saved threshold alone remains dormant and never limits or labels a turn.",
		},
		maxTurnUsd: {
			label: "Maximum USD per turn",
			description: "Projected foreground plus current-turn background spend; zero keeps the guard inactive",
		},
		action: {
			label: "Action",
			description: "warn only, or reduce reasoning one supported level for the imminent request",
		},
	},
	projectContext: {
		scope: {
			label: "Save scope",
			description:
				"This directory: this folder only (user overlay). This project: .pi/settings.json. All projects: every repo.",
		},
		load: {
			label: "Load",
			description:
				"Global only excludes project AGENTS-family files, extensions, skills, and prompts. On demand admits them.",
		},
		summaryGlobalOnly: "global only",
		summaryThisProject: "this project",
		summaryAllProjects: "all projects",
		summaryThisDirectory: "this directory",
	},
	selfModification: {
		scope: {
			label: "Save scope",
			description:
				"Save this self-modification configuration globally or in the current project's .pi/settings.json",
		},
		enabled: {
			label: "Enabled",
			description: "Allow agents to modify Pi's own source/harness only when explicitly tasked",
		},
		sourcePath: {
			label: "Source path",
			description: "Path to the pi-adaptative source checkout agents may edit for self-evolution",
		},
		sourcePathTitle: "Pi-adaptative Source Path",
		sourcePathDescription: "Set the source checkout path used by self-evolution guardrails. Empty clears it.",
	},
	autonomy: {
		scope: {
			label: "Save scope",
			description: "Save this autonomy preset globally or in the current project's .pi/settings.json",
		},
		mode: {
			label: "Mode",
			description:
				"One preset for learning and root-session reflection cues: off, safe, balanced, or standing autonomy",
		},
		autoContinue: {
			label: "Goal auto-continue",
			description: "Continue an active goal whenever Pi becomes idle until a real terminal condition",
		},
		turns: {
			label: "Goal turns",
			description: "Optional continuation prompt limit; 0 is unbounded like Codex",
		},
		recoveryThreshold: {
			label: "Goal recovery threshold",
			description: "Unchanged rounds before Pi must inspect failure evidence and switch approach without stopping",
		},
		maxMinutes: {
			label: "Goal max minutes",
			description: "Wall-clock budget per goal continuation loop; 0 disables the time budget",
		},
		delayMs: {
			label: "Goal delay ms",
			description: "Delay before idle auto-continuation starts; 0 starts immediately after idle",
		},
	},
	researchLane: {
		scope: {
			label: "Save scope",
			description: "Save these research-lane settings globally or in the current project's .pi/settings.json",
		},
		enabled: {
			label: "Enabled",
			description:
				"Run bounded, read-only background research when idle with an active goal (requires autonomy mode on)",
		},
		budget: {
			label: "Budget per pass",
			description: "USD budget per research pass; breaches mark the lane as budget exhausted in diagnostics",
		},
		maxMilliseconds: {
			label: "Max milliseconds",
			description: "Wall-clock budget per research pass; 0 disables the time budget",
		},
		idleDelayMs: {
			label: "Idle delay ms",
			description: "Delay before idle-triggered research starts; 0 starts immediately after idle",
		},
		runsPerSession: {
			label: "Runs per session",
			description: "Maximum idle-triggered research passes per session; explicit /autonomy research is uncapped",
		},
	},
	workerDelegation: {
		scope: {
			label: "Save scope",
			description: "Save these delegation settings globally or in the current project's .pi/settings.json",
		},
		enabled: {
			label: "Enabled",
			description:
				"Allow capable models to dispatch autonomous persistent leaf workers; enabled by default, and explicit false is a hard off-switch",
		},
		budget: {
			label: "Budget per worker task",
			description: "Cumulative USD budget for one worker task; 0 disables this ceiling",
		},
		budgetTitle: "Worker Task USD Budget",
		budgetDescription: (max: number) =>
			`Enter a nonnegative finite number no greater than ${max}. Zero disables the settings-level cost ceiling.`,
		budgetHint: (max: number) => `number in [0, ${max}]; invalid input keeps the current value`,
		milliseconds: {
			label: "Worker task milliseconds",
			description: "Active wall-clock budget for one worker task; 0 disables the time budget",
		},
		millisecondsTitle: "Worker Task Active Time",
		millisecondsDescription:
			"Enter active milliseconds per worker task as a nonnegative safe integer. Zero disables the time ceiling.",
		millisecondsHint: "nonnegative safe integer; invalid input keeps the current value",
		writeEnabled: {
			label: "Allow file writes",
			description:
				"Let workers change files through direct write/edit tools; default authority is machine-wide and explicit false revokes it",
		},
	},
	learningPolicy: {
		scope: {
			label: "Save scope",
			description: "Save these learning-policy settings globally or in the project's .pi/settings.json",
		},
		enabled: {
			label: "Enabled",
			description:
				"Gate root-session reflection writes through the learning policy (proposals, audits, rollback). Disabled keeps legacy direct-apply with audit records.",
		},
		autoApply: {
			label: "Auto-apply",
			description: "Allow eligible writes to auto-apply; otherwise everything becomes a proposal",
		},
		autoApplySupersessions: {
			label: "Auto-apply supersessions",
			description:
				"Allow a memory replace or remove (overwrites or deletes an existing fact) to auto-apply once otherwise eligible; off keeps every supersession a proposal",
		},
		confidence: {
			label: "Confidence threshold",
			description: "Minimum confidence (0-100) before a write may auto-apply; below it, proposal or no-op",
		},
		minObservations: {
			label: "Min observations",
			description: "Observations required before auto-apply (allowedAutoApplyLayers stays JSON-only)",
		},
	},
	modelCapability: {
		scope: {
			label: "Save scope",
			description: "Save globally or in the project's .pi/settings.json",
		},
		mode: {
			label: "Mode",
			description:
				'"Automatic" derives the tool surface and lane budgets from the model\'s own context window; "Off" disables adaptation; a class name forces it',
		},
	},
	contextCuration: {
		scope: {
			label: "Save scope",
			description: "Save these curation settings globally or in the current project's .pi/settings.json",
		},
		enabled: {
			label: "Enabled",
			description:
				"Local brain curator: digests GC-packed stubs and scores stale-chunk relevance. Requires a digest-fit local model (run /fitness <model>).",
		},
		model: {
			label: "Curator model",
			description:
				"Local model that runs curation jobs; refused until it passes the digest fitness probe on this host",
		},
		maxJobsPerTurn: {
			label: "Max jobs per turn",
			description: "Curation jobs drained per turn (each is one small local completion)",
		},
	},
	/** The System One provider row and the access line it shows. */
	systemOne: {
		inForce: (name: string, model: string) => `In force: ${name} (${model}).`,
		noKey: (setup: string) => `No key for this choice: System One is off until you ${setup}.`,
		orJoiner: ", or ",
		setupTypesafe: "use /login typesafe or TYPESAFE_API_KEY",
		setupOpenRouter: "use /login openrouter or OPENROUTER_API_KEY",
	},
	peer: {
		description: (scope: string) =>
			`Root peer independent of System One; active scope: ${scope}. Directory profile overrides project, which overrides global.`,
		scope: {
			label: "Save scope",
			description:
				"Each scope replaces the whole peer configuration; directory profile overrides project, which overrides global.",
		},
		enabled: {
			label: "Enabled",
			description: "Root-only independent peer; works with System One off. Disabling preserves earlier findings.",
		},
		model: {
			label: "Model",
			description:
				"Choose a peer from configured accounts. Lead model, quota and explicit --models/SDK scope can make a choice unavailable.",
		},
		thinking: {
			label: "Thinking",
			description:
				"Choose a supported effort or let the agent choose. Omitted effort uses the model default. Selecting another model clears an incompatible override.",
		},
		thinkingTitle: "Peer Thinking",
		thinkingDescription: "Choose an effort or let the agent choose; omitted effort uses the model default",
		choosesForEachReview: "Choose independently for each review",
	},
	autoLearn: {
		scope: {
			label: "Save scope",
			description: "Save this Auto Learn configuration globally or in the current project's .pi/settings.json",
		},
		enabled: {
			label: "Enabled",
			description: "Autonomously trigger background history scavenging for long sessions",
		},
		model: {
			label: "Scavenger model",
			description: (pattern?: string) =>
				pattern
					? `Model for explicit/background learning. "active" uses ${pattern}; configured subscription/API models are listed first. Automatic reflection uses the orchestrator's current session turn.`
					: 'Model for explicit/background learning. Use "active" for the current session model, or choose a configured subscription/API model. Automatic reflection uses the orchestrator\'s current session turn.',
		},
		messageTrigger: {
			label: "Message trigger",
			description: "Trigger after this many message entries in the active branch",
		},
		contextTrigger: {
			label: "Context trigger %",
			description: "Trigger when current context usage reaches this percentage",
		},
		cooldown: {
			label: "Cooldown minutes",
			description: "Per-session-tenant cooldown between learner launches",
		},
		lease: {
			label: "Lease minutes",
			description: "Shared-state lease duration for a running background learner",
		},
		maxLearners: {
			label: "Max learners",
			description: "Maximum running Auto Learn background learners per session tenant",
		},
		applyHighConfidence: {
			label: "Apply high confidence",
			description:
				"Allow high-confidence memory candidates to be applied automatically; broader write authority follows autonomy.mode",
		},
		reflectionReview: {
			label: "Reflection review",
			description:
				"Include one durable root-session reflection cue on eligible external turns; completed-turn signals coalesce into it",
		},
		reflectionToolTrigger: {
			label: "Reflection tool trigger",
			description: "Queue a root-session reflection cue after this many tool calls in one completed turn",
		},
		reflectionCooldown: {
			label: "Reflection cooldown",
			description: "Per-session-tenant cooldown between automatic root-session reflection cues",
		},
	},
	contextPolicy: {
		scope: {
			label: "Save scope",
			description:
				"Save this context/prompt-policy configuration globally or in the current project's .pi/settings.json",
		},
		enabled: {
			label: "Prompt policy enforcement",
			description:
				"Opt-in: stub stale artifact-backed grep/find output in the model-visible prompt only. Never touches transcript/session history. Requires the artifact retrieval tool to be active this turn (not configurable here -- it's a runtime fact, not a setting).",
		},
		preserveRecent: {
			label: "Preserve recent messages",
			description: "Never stub a tool result within this many of the most recent messages",
		},
		minChars: {
			label: "Minimum chars before stubbing",
			description: "Only stub a tool result whose original provider-visible text is at least this many characters",
		},
	},
	contextMemory: {
		scope: {
			label: "Save scope",
			description:
				"Save this local memory-retrieval configuration globally or in the current project's .pi/settings.json",
		},
		enabled: {
			label: "Local memory retrieval",
			description:
				"Default on: search local Pi memory for relevant evidence. Explicit false is a hard off-switch for both legacy recall and context retrieval. External providers remain blocked by the separate consent below.",
		},
		maxResults: {
			label: "Max results",
			description: "Maximum number of memory items to retrieve per query (1-20)",
		},
		includeInPrompt: {
			label: "Include in prompt",
			description:
				"Default on and budget-gated: surface retrieved memory as bounded, source-labeled untrusted evidence in the model prompt only -- never the transcript or an instruction.",
		},
		externalQueries: {
			label: "Allow external queries",
			description:
				"Explicit consent to send bounded query text to eligible external memory providers. Default off; secret-like and oversized queries still fail closed, and returned recall is centrally fenced as untrusted data.",
		},
	},
	modelRouter: {
		scope: {
			label: "Save scope",
			description: "Save this routing configuration globally or in the current project's .pi/settings.json",
		},
		enabled: {
			label: "Enabled",
			description: "Route read-only/research turns to cheap model and modify/tool-heavy turns to expensive model",
		},
		selectionMode: {
			label: "Selection mode",
			description:
				"Manual: exact tier pins only · Automatic: the router picks each tier's model from the candidate pool · Hybrid: pinned tiers win, unpinned tiers auto-select",
		},
		pool: {
			label: "Candidate pool",
			description:
				"Only available favorites can be routed. Configure models narrows that list; favorite models in /model. An empty favorite list leaves no routing candidates.",
		},
		configureModels: {
			label: "Configure models →",
			description: "Open the Models selector; closing it brings Router Setup back on the edited pool.",
		},
		poolMenuTitle: "Router Candidate Pool",
		poolMenuDescription: (summary: string, subscriptions: number) =>
			`${summary} · ${subscriptions} subscription-backed · select a model to calibrate it`,
		poolUnavailable: "Pool unavailable in this view",
		poolPreference: {
			label: "Pool preference",
			description:
				"Subscriptions first: adequate subscription-backed models rank ahead of metered ones (after hard admission) · Balanced: evidence ranking only",
		},
		cheapModel: {
			label: "Cheap model",
			description: "Pick the model for read-only, research, explanation, and question turns",
		},
		mediumModel: {
			label: "Medium model",
			description: "Pick the model for normal scoped implementation, edits, tests, and mechanical refactors",
		},
		expensiveModel: {
			label: "Expensive model",
			description: "Pick the model for modify, implementation, and escalated tool-heavy turns",
		},
		executorModel: {
			label: "Executor model",
			description: "Pick the local executor lane model; unset disables direct toolkit execution",
		},
		learningModel: {
			label: "Learning model",
			description:
				"Pick the model for explicit/background learning and skill-creator work; automatic reflection uses the orchestrator's current session turn",
		},
		cheapThinking: {
			label: "Cheap thinking",
			description:
				"Thinking-level override for cheap-tier (read-only/research) routed turns; (inherit) keeps today's behavior: the session level, clamped to the routed model",
		},
		mediumThinking: {
			label: "Medium thinking",
			description:
				"Thinking-level override for medium-tier (scoped implementation) routed turns; (inherit) keeps today's behavior: the session level, clamped to the routed model",
		},
		expensiveThinking: {
			label: "Expensive thinking",
			description:
				"Thinking-level override for expensive-tier (modify/escalated) routed turns; (inherit) keeps today's behavior: the session level, clamped to the routed model",
		},
		executorThinking: {
			label: "Executor thinking",
			description:
				"Thinking-level override for the local executor-direct lane; (inherit) keeps today's behavior: the session level, clamped to the routed model",
		},
		cheapThinkingTitle: "Cheap Tier Thinking",
		cheapThinkingDescription:
			"Select a thinking-level override for cheap-tier routed turns, or inherit the session level",
		mediumThinkingTitle: "Medium Tier Thinking",
		mediumThinkingDescription:
			"Select a thinking-level override for medium-tier routed turns, or inherit the session level",
		expensiveThinkingTitle: "Expensive Tier Thinking",
		expensiveThinkingDescription:
			"Select a thinking-level override for expensive-tier routed turns, or inherit the session level",
		executorThinkingTitle: "Executor Thinking",
		executorThinkingDescription:
			"Select a thinking-level override for the executor-direct lane, or inherit the session level",
		inheritThinking: "Inherit the session thinking level for this turn, clamped to the routed model",
		fitnessGate: {
			label: "Fitness gate",
			description: "Opt-in subtractive gate: blocks tier models only when their probed router lane failed",
		},
		calibrate: {
			label: "Calibrate",
			description:
				"Operator-triggered only. Reuses the fitness probe (runModelFitness) and the real tool probe; nothing runs by opening settings.",
			currentValue: (pending: number | undefined) =>
				pending === undefined ? "unavailable" : `${pending} need calibration`,
			title: "Router Calibration",
			subtitle: (scope: string) => `Covers ${scope}. You confirm before anything runs.`,
			one: {
				label: "Calibrate one model",
				description: (scope: string) => `Pick one pool model; runs the ${scope}, then offers a role.`,
			},
			unprobed: {
				label: (pending: number) => `Calibrate unprobed (${pending})`,
				description: "Probe every pool model whose router evidence is missing or stale. Provider calls required.",
			},
			all: {
				label: (count: number) => `Recalibrate selected (${count})`,
				description: "Re-probe every pool model, replacing existing evidence. Provider calls required.",
			},
			surfaces: (count: number, names: string) => `${count} router fitness surfaces (${names})`,
			probe: "real tool execution probe",
			scope: (surfaces: string, probe: string) => `${surfaces} + ${probe}`,
			surfaceNames: {
				cheap: "cheap",
				medium: "medium",
				expensive: "expensive",
				executor: "executor",
				compaction: "compaction",
				curation: "curation",
				scout: "scout",
			} as Record<string, string>,
		},
		clearCheap: "Clear cheap routing model; research turns fall back to the active session model",
		clearMedium: "Clear medium routing model; implementation turns fall back according to router policy",
		clearExpensive: "Clear expensive routing model; modify turns fall back to the active session model",
		clearExecutor: "Clear executor lane model; direct toolkit execution stays disabled",
		autoSelectTier: "Let the router select this tier's model automatically from the candidate pool",
		preview: {
			label: "Preview route",
			description:
				"Enter an example task. Deterministic preview makes no provider call; live preview (judge/H-MoE) is a separate explicit action.",
			title: "Preview Route",
			taskDescription:
				"Type an example task. Enter previews deterministically (no provider call). Prefix with `live:` to run the judge/H-MoE path.",
			emptyHint: "empty cancels",
		},
		diagnostics: {
			label: "Diagnostics",
			description:
				"Show router status: mode, pool, preference, tier fitness, recent decisions with selection provenance.",
			title: "Router Diagnostics",
			reportInto: "Prints the router status report into the conversation.",
			show: {
				label: "Show diagnostics",
				description: "Same report as /session routing status",
			},
		},
		hmoePreset: {
			label: "H-MoE preset",
			description: "Numeric policy preset for ability, operational, and reliability weighting",
		},
		hmoeTeam: {
			label: "H-MoE team strategy",
			description: "Selection mode for single model, primary+critic, independent verifier, or adaptive team",
		},
		hmoeIndependence: {
			label: "H-MoE independence",
			description: "Independence level required when selecting verifier or critic models",
		},
		hmoePreference: {
			label: "H-MoE preference",
			description: "Ordering preference among adequate candidates after hard admission",
		},
	},
	warnings: {
		anthropicExtraUsage: {
			label: "Anthropic extra usage",
			description: "Warn when Anthropic subscription auth may use paid extra usage",
		},
	},
	dialogs: {
		thinkingTitle: "Thinking Level",
		thinkingDescription: "Select the reasoning depth supported by the active model",
		themeTitle: "Theme",
		themeDescription: "Select color theme",
		themeCurrent: "(current)",
		showImagesInline: "Show images inline in terminal",
		showImagesPlaceholder: "Show text placeholder instead",
		thinkingLevels: {
			off: "No reasoning",
			minimal: "Very brief reasoning (~1k tokens)",
			low: "Light reasoning (~2k tokens)",
			medium: "Moderate reasoning (~8k tokens)",
			high: "Deep reasoning (~16k tokens)",
			xhigh: "Maximum reasoning (~32k tokens)",
			max: "Maximum reasoning depth for the hardest problems",
			ultra: "Maximum available reasoning effort (provider permitting)",
		} as Record<string, string>,
	},
	/** The model pickers a row opens, and the words shared by all of them. */
	modelPicker: {
		description:
			"Choose from models available through configured subscription/API accounts. Type to filter; manual is fallback.",
		executorDescription: "Choose from configured models. Type to filter; manual is fallback.",
		customDescription: "Enter a provider/model pattern from pi --list-models.",
		emptyClears: "empty clears the setting",
		manualOption: "Manual / custom…",
		manualOptionDescription: "Type a model pattern not listed above",
		customSetting: "Current custom setting",
		activeOption: "Use the current session model",
		activeOptionWithModel: (pattern: string) => `Use the current session model (${pattern})`,
		clearModel: "Clear this model setting",
		favoriteMark: "favorite",
		outsidePoolMark: "outside pool · favorite and include in scope to route",
		cheap: {
			title: "Cheap / Research Model",
			customTitle: "Custom Cheap / Research Model",
		},
		medium: {
			title: "Medium / Implementation Model",
			customTitle: "Custom Medium / Implementation Model",
		},
		expensive: {
			title: "Expensive / Modify Model",
			customTitle: "Custom Expensive / Modify Model",
		},
		executor: {
			title: "Executor Lane Model",
			customTitle: "Custom Executor Lane Model",
		},
		learning: {
			title: "Learning Model",
			description:
				"Choose active or a model from configured subscription/API accounts for explicit/background learning. Automatic reflection uses the orchestrator's current session turn. Type to filter; manual is fallback.",
			customTitle: "Custom Learning Model",
			customDescription:
				'Enter "active" or a provider/model pattern for explicit/background learning from pi --list-models.',
			customEmptyHint: 'empty uses "active"',
		},
		peer: {
			title: "Peer Model",
			description:
				"Type to filter configured models. Selecting a model enables the root peer; unsupported effort resets to Agent chooses.",
			customTitle: "Peer Model",
			customDescription: "Enter an exact provider/model reference.",
			customEmptyHint: "empty lets the agent choose",
		},
		autoLearn: {
			title: "Auto Learn Scavenger Model",
			description:
				"Choose active or a model from currently configured subscription/API accounts. Type to filter; choose manual for a custom pattern.",
			customTitle: "Custom Auto Learn Model",
			customDescription: 'Enter "active" or a provider/model pattern like "openai/gpt-5.4".',
			customEmptyHint: 'empty uses "active"',
		},
	},
};
