/**
 * The English words of the local model commands (`/models`, `/fitness`) and of the model router set-up: the status lines
 * of every install, removal and probe stage, the disclosures that precede a delete, the listings, the selector labels and
 * the route previews. Leaves that carry a value, a count or a plural are functions, so each language places the value and
 * agrees with it in its own way.
 */

export const LOCAL_MODELS = {
	models: {
		/** The thinking-level picker that follows a router role: the level is inherited from the session unless pinned. */
		thinkingInheritLabel: "(inherit)",
		thinkingInheritDescription: "Use current session default for this tier.",
		/** `/models stop`. */
		stopStopped: (sidecars: number, prismServer: boolean) =>
			`Pi-managed local model server stopped${sidecars > 0 ? ` (${sidecars} Transformers sidecar(s))` : ""}${prismServer ? " (prism llama.cpp server)" : ""}; models remain installed.`,
		stopNone: "No pi-managed server running (a system server, if any, is not pi's to stop).",
		/** `/models import`. */
		imported: (args: {
			sourceDir: string;
			targetDir: string;
			manifests: number;
			hardlinked: number;
			copied: number;
			skipped: number;
		}) =>
			`Imported Ollama models from ${args.sourceDir} into pi-owned store ${args.targetDir}: ${args.manifests} manifest(s), ${args.hardlinked} blob(s) hardlinked, ${args.copied} blob(s) copied, ${args.skipped} existing file(s) skipped.`,
		/** Usage lines and argument hints. The command and its arguments never change. */
		needleUsage: "Usage: /models needle <query> [tools-json]",
		needleToolsHint: "  tools-json defaults to the built-in smoke-test tool set (one city weather lookup)",
		addUsage:
			"Usage: /models add <ollama-tag | hf.co/org/repo[:quant] | curated HF full-base ref | huggingface URL | pasted install command>",
		addSuggestHint: "Or start from a validated suggestion: /models suggest",
		removalUsage: (action: string) => `Usage: /models ${action} <ref> confirm`,
		uninstallRuntimeUsage: "Usage: /models uninstall-runtime <prism> confirm",
		enableUsage: (action: string) => `Usage: /models ${action} <ollama | llamacpp | transformers>`,
		/** `/models add`: what a pasted ref turned out to be. */
		notAdded: (reason: string) => `Not added: ${reason}`,
		apiModel: (ref: string) =>
			`${ref} is an API model — nothing to install. Configure auth for the provider, then probe it with /fitness ${ref}.`,
		descriptorMissing: (modelId: string) =>
			`${modelId} has no curated prism llama.cpp descriptor — this is a wiring bug.`,
		runtimeEnabled: (runtime: string, enabled: boolean) =>
			`Local runtime ${runtime} is now ${enabled ? "enabled" : "disabled"}.`,
		/** The Ollama store as the listing names it. The store kind is an identifier and stays as it is. */
		unknownStore: "unknown store (0 model(s))",
		store: (path: string, kind: string, count: number) => `${path} [${kind}, ${count} model(s)]`,
		/** Starting the local server. */
		serverAlreadyRunning: (serverUrl: string) =>
			`Ollama is already running on ${serverUrl}; this session cannot verify its ownership or store. Stop the other server before adding models.`,
		startingServer: (binarySource: string, ownedModelsDir: string) =>
			`Starting local model server (${binarySource} binary, owned storage: ${ownedModelsDir})…`,
		startFailed: (reason: string) => `Could not start the local server: ${reason}`,
		/** The `/models` listing. */
		listHeader: (activeStore: string, ownedModelsDir: string, count: number) =>
			`Ollama models (active store: ${activeStore}; pi-owned store: ${ownedModelsDir} with ${count} model(s)):`,
		listNone: "  (none installed — /models add <ref>, /models import, or /models suggest for a validated roster)",
		listHeaderDown: "Ollama models:",
		listServerDown: (binarySource: string) =>
			`  server not running (binary: ${binarySource}). /models add starts it on demand; /fitness probes registered models.`,
		transformersHeader: "Pi-managed Transformers models:",
		/** How ready a pi-managed runtime is, as the model row says it. */
		readinessRunning: "server running",
		readinessInstalled: "runtime installed",
		readinessMissing: "runtime missing",
		probed: (args: {
			at: string;
			digestSucceeded: string;
			digestTotal: string;
			toolSucceeded: number;
			toolTotal: number;
			tokensPerSecond?: number;
		}) =>
			`probed ${args.at}: digest ${args.digestSucceeded}/${args.digestTotal}, tool-calls ${args.toolSucceeded}/${args.toolTotal}${args.tokensPerSecond ? `, ~${args.tokensPerSecond} tok/s` : ""}`,
		unprobed: (ref: string) => `unprobed — run /fitness ${ref}`,
		transformersRow: (modelId: string, readiness: string, cacheDir: string, probe: string) =>
			`  - ${modelId} (${readiness}, cache: ${cacheDir}) · ${probe}`,
		ollamaRow: (name: string, gigabytes: string, probe: string) => `  - ${name} (${gigabytes} GB) · ${probe}`,
		listCommands: "Commands: /models import · /models add <ref> · /models remove <ref> confirm · /models stop",
		/** A long stage's progress line, indented under the command that started it. */
		pulling: (ref: string) => `Pulling ${ref}… (weights land in pi's owned Ollama store)`,
		progress: (stage: string, progress: string) => `  ${stage}: ${progress}`,
		indented: (progress: string) => `  ${progress}`,
		installFailed: (stage: string, reason: string) => `Installation failed at the ${stage} step: ${reason}`,
		installedRegistered: (ref: string, modelRef: string) =>
			`${ref} installed and registered as ${modelRef}. Probing fitness…`,
		/** The pi-managed Transformers pipeline. */
		installingTransformers: (modelId: string, venvDir: string) =>
			`Installing isolated Transformers runtime for ${modelId} at ${venvDir}…`,
		transformersInstallFailed: (error: string) => `Transformers runtime install failed: ${error}`,
		transformersUnavailable: (venvDir: string) => `Transformers runtime is still unavailable at ${venvDir}.`,
		downloadFailed: (error: string) => `Model download failed: ${error}`,
		downloadFailedLabel: "Model download failed",
		sidecarStartFailed: (reason: string) => `Could not start Transformers sidecar: ${reason}`,
		notAutoRegistered: (reason: string) => `Installed, but not auto-registered: ${reason}`,
		addToModelsJson: (path: string, snippet: string) => `Add this to ${path} yourself:\n${snippet}`,
		registeredAs: (what: string, modelRef: string) =>
			`${what} installed and registered as ${modelRef}. Probing fitness…`,
		/** The pi-managed prism llama.cpp pipeline. */
		installingPrism: (displayName: string, runtimeDir: string) =>
			`Installing prism llama.cpp runtime for ${displayName} at ${runtimeDir}…`,
		prismInstallFailed: (error: string) => `Prism llama.cpp runtime install failed: ${error}`,
		prismUnavailable: (runtimeDir: string) => `Prism llama.cpp runtime is still unavailable at ${runtimeDir}.`,
		visionDownloadFailed: "Vision projector download failed",
		llamaServerStartFailed: "Could not start llama-server",
		servedNotRegistered: (reason: string) => `Served, but not auto-registered: ${reason}`,
		/** Removal. The disclosure names every file the delete touches and ends in the command that confirms it. */
		localServerDown: "Local server not running — start it (any /models action) before removing.",
		notInstalled: (ref: string, installed: string) => `${ref} is not installed. Installed: ${installed}`,
		noneInstalled: "(none)",
		systemStorage: "the system server's storage",
		removalTitle: (what: string) => `Removing ${what} will delete:`,
		removalWeights: (gigabytes: string, where: string) => `  - model weights (${gigabytes} GB) from ${where}`,
		removalRegistration: (entry: string) => `  - the ${entry} entry in models.json`,
		removalFitness: "  - its cached fitness report for this host",
		removalRun: (command: string) => `Run: ${command}`,
		stoppedSidecarNote: "It will stop this session's Transformers sidecar if running.",
		weightsRemain: (cacheDir: string) => `Cached weights remain under ${cacheDir}.`,
		weightsAt: (gigabytes: string, dir: string) => `  - downloaded model weights (${gigabytes} GB) at ${dir}`,
		noWeights: (cacheDir: string) => `  - no cached weights found under ${cacheDir}`,
		ggufRemain: (modelsDir: string) => `Downloaded GGUF weights remain under ${modelsDir}.`,
		ggufAt: (gigabytes: string, modelsDir: string) =>
			`  - downloaded GGUF weights (${gigabytes} GB) under ${modelsDir}`,
		prismServerNote: (port: number) =>
			`Its llama-server will be stopped if this session started it; if it was started by a different pi process or session, it will keep serving on 127.0.0.1:${port} until stopped manually.`,
		removeFailed: (error: string) => `Remove failed: ${error}`,
		removed: (ref: string) => `${ref} removed: weights deleted, registration and fitness report dropped.`,
		droppedWeightsRemain: (modelId: string, cacheDir: string) =>
			`${modelId} registration and fitness report dropped; cached weights remain under ${cacheDir}.`,
		prismDropped: (modelId: string, modelsDir: string, stopped: boolean, port: number) =>
			`${modelId} registration and fitness report dropped; downloaded weights remain under ${modelsDir}.${
				stopped
					? " Its llama-server was stopped."
					: ` No llama-server tracked by this session — if one is still running (started by a different pi process or session), stop it manually on port ${port}.`
			}`,
		uninstallTitle: (what: string) => `Uninstalling ${what} will delete:`,
		prismUninstallServerNote: "Its llama-server will be stopped if this session started it.",
		deleteWeightsFailed: (error: string) => `Failed to delete weights: ${error}`,
		uninstalled: (what: string, size: string) =>
			`${what} uninstalled: weights deleted (${size} GB), registration and fitness dropped.`,
		prismUninstalled: (what: string, size: string, stopped: boolean) =>
			`${what} uninstalled: GGUF weights deleted (${size} GB), registration and fitness dropped.${
				stopped ? " Its llama-server was stopped." : ""
			}`,
		/** Uninstalling the runtime itself. */
		runtimeNotInstalled: (runtimeDir: string) => `Prism llama.cpp runtime is not installed at ${runtimeDir}.`,
		runtimeUninstallTitle: "Uninstalling prism llama.cpp runtime will delete:",
		runtimeUninstallBinaries: (runtimeDir: string) =>
			`  - Pi-owned runtime binaries and manifest under ${runtimeDir}`,
		runtimeDeleted: (runtimeDir: string) => `Prism llama.cpp runtime binaries deleted from ${runtimeDir}.`,
		runtimeDeleteFailed: (error: string) => `Failed to delete runtime binaries: ${error}`,
		unknownRuntime: (runtime: string) => `Unknown runtime: ${runtime}. Supported: prism`,
		/** The pi-managed needle bench. */
		installingNeedle: (runtimeDir: string) => `Installing needle (function-call test bench) at ${runtimeDir}…`,
		needleInstallFailed: (error: string) => `needle install failed: ${error}`,
		needleUnavailable: (runtimeDir: string) => `needle is still unavailable at ${runtimeDir}.`,
		needleWeightsFailed: (error: string) => `needle weights download failed: ${error}`,
		needleSmokeRunning: "Running needle smoke test (function-call probe)…",
		needleSmokeFailed: (error: string) => `needle smoke test failed: ${error}`,
		needleSmokeNoCall: "smoke test reported success but returned no parsed call",
		needleVerified: (args: { called: string; argumentsJson: string; latencyMs: number }) =>
			`needle installed and verified: smoke test called ${args.called}(${args.argumentsJson}) in ${args.latencyMs}ms. Use /models needle <query> [tools-json] to test it further — it is a standalone bench, not a chat/executor lane.`,
		needleRemovalTitle: "Removing needle will delete:",
		needleRuntimeLine: (runtimeDir: string) => `  - the pi-managed needle runtime (clone + venv) at ${runtimeDir}`,
		needleCheckpointLine: (checkpointPath: string) => `  - the downloaded checkpoint at ${checkpointPath}`,
		needleNoRegistration:
			"needle has no models.json entry or fitness report — it is a standalone function-call test bench, never registered as a chat/lane model.",
		needleRemoved: (runtimeDir: string, modelsDir: string) =>
			`needle removed: deleted ${runtimeDir} and ${modelsDir}.`,
		needleNotInstalled:
			"needle is not installed. Run /models add hf.co/Cactus-Compute/needle first (or /models suggest).",
		needleCheckpointMissing:
			"needle is installed but its checkpoint hasn't been downloaded. Run /models add hf.co/Cactus-Compute/needle to fetch and verify it.",
		needleRunning: (query: string) => `needle: running "${query}"…`,
		needleCallFailed: (latencyMs: number, error: string, rawOutput: string) =>
			`needle call failed (${latencyMs}ms): ${error}\nraw output:\n${rawOutput}`,
		needleCall: (latencyMs: number, called: string, argumentsJson: string) =>
			`needle (${latencyMs}ms): ${called}(${argumentsJson})`,
		/** Suggestions that cannot be installed. */
		suggestionUnknownPrism: (name: string, modelId: string) =>
			`Suggestion ${name} maps to an unknown curated prism model "${modelId}" — wiring bug.`,
		suggestionNotInstallable: (name: string, why: string) => `Suggestion ${name} is not installable: ${why}`,
		/** What the local runtime itself prints while it installs: the manual steps behind `/models add`. */
		installGuide: {
			ollama: (distDir: string) => [
				"Ollama is not installed. Pi can install it for you now (asks first, never curl|sh) — or follow these manual steps yourself:",
				"  1. Download the pinned release archive for your platform:",
				"     https://github.com/ollama/ollama/releases (asset: ollama-linux-amd64.tar.zst or your platform)",
				`  2. Extract it to ${distDir}`,
				"  3. Re-run your /models command - pi detects the binary automatically.",
				"Alternatively install system-wide from https://ollama.com/download and pi will use the system server.",
			],
			transformers: (args: {
				venvDir: string;
				cacheDir: string;
				pythonPath: string;
				packages: string;
				torchArgs: string;
			}) => [
				"Hugging Face Transformers runtime is not installed for this model.",
				`Pi can install it into its own venv at ${args.venvDir} and cache weights under ${args.cacheDir}.`,
				"Manual equivalent:",
				`  python -m venv ${args.venvDir}`,
				`  ${args.pythonPath} -m pip install --upgrade pip`,
				`  ${args.pythonPath} -m pip install ${args.packages}`,
				`  ${args.pythonPath} ${args.torchArgs}`,
			],
		},
	},
	fitness: {
		/** The probe and the role it lands. */
		probeRunning: (modelRef: string) =>
			`Model fitness probe running on ${modelRef}… (6 surfaces; local models may take a few minutes)`,
		allSurfacesFailed: (model: string) =>
			`${model} failed the fitness probe on all surfaces — not configured. Use /model to set it manually if you accept the risk.`,
		toolProbeRunning: (model: string) => `Real tool execution probe running on ${model}…`,
		toolProbeUnavailable: (model: string, error: string) =>
			`Real tool execution probe unavailable for ${model}: ${error}`,
		notAssignedTool: (model: string, role: string, failure: string) =>
			`${model} not assigned as ${role}: real tool execution ${failure}.`,
		scoutLaneFailed: (lane: string) => `failed ${lane === "toolCall" ? "tool call" : lane} check`,
		scoutNotProbed: "was not probed",
		scoutRefused: (model: string, reason: string) =>
			`${model} not assigned as scout: ${reason} in the scout fitness exam. Use the docs/scout.md Modelfile recipe, then rerun /fitness.`,
		roleNone: (modelRef: string) => `Fitness result for ${modelRef} saved. Assign a role later from /settings.`,
		roleCurator: (modelRef: string) => `Context curation enabled with ${modelRef} as the curator.`,
		roleExecutor: (modelRef: string, hint: string) =>
			`${modelRef} set as the toolkit executor (direct Level-0 hits route to it).${hint}`,
		routerDisabledHint: " Model router is currently disabled — enable it in /settings → Model Router.",
		roleScout: (modelRef: string) => `${modelRef} set as the repository scout and turned on.`,
		roleSet: (modelRef: string, role: string, hint: string) => `${modelRef} set as ${role} model.${hint}`,
	},
	/** The progress lines a `/models` install prints while it runs. */
	installProgress: {
		downloading: (asset: string) => `Downloading ${asset}…`,
		extracting: (asset: string) => `Extracting ${asset}…`,
		ollamaInstalled: "Ollama installed.",
		creatingVenv: (dir: string) => `creating isolated Python venv at ${dir}`,
		repairingVenv: "repairing pi-managed Transformers venv with ensurepip",
		recreatingVenv: "recreating pi-managed Transformers venv",
		bootstrappingPip: "bootstrapping pip inside pi-managed venv",
		upgradingPip: "upgrading pip inside pi-managed venv",
		installingPackages: "installing pinned Transformers runtime packages",
		installingTorch: "installing pinned CPU PyTorch backend",
		downloadingModel: (modelId: string, cacheDir: string) => `downloading ${modelId} into ${cacheDir}`,
	},
	/** The model router's status report: its labels, the words of its state, and one line per provider account. */
	routerStatus: {
		status: "Status:",
		enabled: "enabled",
		disabled: "disabled",
		selectionMode: "Selection mode:",
		candidatePool: "Candidate pool:",
		poolPreference: "Pool preference:",
		cheapModel: "Cheap model:",
		mediumModel: "Medium model:",
		expensiveModel: "Expensive model:",
		executorModel: "Executor model:",
		learningModel: "Learning model:",
		active: "active",
		unset: "unset",
		inheritThinking: "(inherit)",
		thinking: (level: string) => `thinking ${level}`,
		fitness: (value: string) => ` · fitness ${value}`,
		fitnessFit: "fit",
		fitnessUnprobed: "unprobed",
		fitnessUnfit: (lane: string, succeeded: number, total: number) => `UNFIT (${lane} ${succeeded}/${total})`,
		routing: "Routing:",
		inactive: "inactive (disabled)",
		skipped: (reason: string) => `skipped (${reason})`,
		waitingForPrompt: "waiting for prompt",
		latestIntent: "Latest intent:",
		none: "none",
		lastDecision: "Last decision:",
		escalatedTo: (model: string) => `escalated -> ${model}`,
		failed: "failed",
		selectedBy: (by: string) => `, selected by ${by}`,
		exhaustedModels: "Exhausted models:",
		lastFailover: "Last failover:",
		providerFailures: "Provider failures:",
		providerFailuresDetail: (total: number, unknown: number) =>
			`${total} provider failures this session (${unknown} unclassified — see failure corpus)`,
		recentDecisions: "Recent decisions:",
		hmoe: "H-MoE:",
		unavailable: (detail: string) => `unavailable (${detail})`,
		accounts: "Accounts:",
		poolSelected: (count: number, source: string) =>
			`${count} selected ${count === 1 ? "model" : "models"} (${source})`,
		poolFavorite: (count: number) => `${count} favorite ${count === 1 ? "model" : "models"}`,
		poolSource: {
			favorites: "favorites",
			modelsConfig: "Models config",
			modelsArg: "--models",
			sdkScope: "SDK scope",
			modelsSelector: "Models selector",
		},
		poolExceptions: "Pool exceptions:",
		poolException: (tier: string, model: string, pool: string) =>
			`${tier} pin ${model} is outside the candidate pool (${pool}); this tier selects an eligible favorite instead.`,
		configDiagnostics: "Config diagnostics:",
	},
	/** One line per provider account the router checked. */
	routerAccounts: {
		noModels: "no models offered",
		keyValid: (provider: string) => `${provider}: key valid`,
		rejected: (provider: string, reason: string) => `${provider}: rejected (${reason})`,
		notChecked: (provider: string, reason: string) => `${provider}: not checked (${reason})`,
		refused: (ref: string, reason: string) => `${ref}: refused (${reason})`,
	},
	routerSetup: {
		/** The Router Setup actions in `/settings`. */
		calibrationEmpty: "Router calibration: the candidate pool is empty. Configure models first.",
		calibrateOneTitle: "Calibrate One Model",
		calibrateOneDescription: (scope: string) => `Runs the ${scope} (provider calls), then offers a router role.`,
		batchNothing: (title: string) => `${title}: nothing to calibrate in the current pool.`,
		batchCostKnown: (total: string, models: number) => `last fitness runs cost $${total} across ${models} model(s)`,
		batchCostUnknown: "cost unknown until the first run (subscription-backed models may cost $0.00)",
		runOnModels: (models: number) => `Run calibration on ${models} model(s)`,
		providerCalls: (scope: string, costNote: string) => `Provider calls: yes (${scope}, per model). ${costNote}.`,
		cancelLabel: "Cancel",
		cancelDescription: "Run nothing.",
		covers: (scope: string) => `Covers ${scope}. Models run one at a time.`,
		calibrating: (args: { modelRef: string; index: number; total: number; surfaces: string }) =>
			`Calibrating ${args.modelRef} (${args.index}/${args.total}): ${args.surfaces}…`,
		calibrationSkipped: (modelRef: string, reason: string) => `Calibration skipped for ${modelRef}: ${reason}`,
		toolProbeOn: (modelRef: string) => `Calibrating ${modelRef}: real tool execution probe…`,
		toolProbeUnavailable: (modelRef: string, error: string) => `Tool probe unavailable for ${modelRef}: ${error}`,
		failed: (modelRef: string, error: string) => `Calibration failed for ${modelRef}: ${error}`,
		complete: "Router calibration complete:",
		poolFollowsModels: "Router pool follows the Models selection; Router Setup is showing the edited pool.",
		livePreviewRunning: "Live route preview running (routing judge / H-MoE may spend)…",
		livePreviewFailed: (error: string) => `Live route preview failed: ${error}`,
		unknownAction: (action: string) => `Unknown router setup action: ${action}`,
		calibrateUnprobedTitle: "Calibrate Unprobed Models",
		calibrateAllTitle: "Recalibrate Selected Models",
		/** The route previews. The values after each label are identifiers and stay as they are. */
		preview: {
			intent: (value: string) => `Intent: ${value}`,
			baselineTier: (value: string) => `Baseline tier: ${value}`,
			risk: (value: string) => `Risk: ${value}`,
			reason: (value: string) => `Reason: ${value}`,
			selectionMode: (value: string) => `Selection mode: ${value}`,
			manualPin: (value: string) => `Manual pin: ${value}`,
			poolSelected: (count: number, source: string) => `Pool: ${count} selected (${source})`,
			poolFavorites: (count: number) => `Pool: ${count} favorites`,
			poolPreference: (value: string) => `Pool preference: ${value}`,
			subscriptionCandidates: (count: number) => `Subscription candidates: ${count}`,
			eligibleCandidates: (count: number) => `Eligible candidates: ${count}`,
			wouldChoose: (value: string) => `Would choose: ${value}`,
			source: (value: string) => `Source: ${value}`,
			sourceManualPin: "manual pin",
			none: "none",
			noModel: "no model (turn stays on the session model)",
			excludedPin:
				"Excluded pin: the manual pin is outside the candidate pool; an eligible favorite is selected instead.",
			fitness: (value: string) => `Fitness: ${value}`,
			skipReason: (value: string) => `Skip reason: ${value}`,
			candidates: "Candidates:",
			deterministic: "Deterministic preview: no provider call was made and the session model is unchanged.",
			chosenTier: (value: string) => `Chosen tier: ${value}`,
			chosenModel: (value: string) => `Chosen model: ${value}`,
			preference: (value: string) => `Preference: ${value}`,
			reasons: "Reasons:",
			live: "Live preview: the routing judge/H-MoE may have run; the session model is unchanged.",
		},
	},
};
