/**
 * The English words of the machine commands: the link between machines (`/remote` and its job commands), the goals handed
 * to leaders (`/lead`) and the machine-wide load and emergency stop (`/load`, `/estop`), together with the load listing
 * that `/load` prints. Machine names, link names, tokens and the words a model or the owner wrote stay as they are.
 */

export const MACHINES = {
	remote: {
		usage: (jobUsage: string) =>
			`Usage: /remote [status] | /remote listen [port] [host] | /remote stop | /remote add <name> | /remote revoke <name> | /remote join <host:port> <token> | /remote leave <host:port> | /remote name <name> | ${jobUsage}`,
		/** How a join stands. The state itself is an identifier. */
		connected: "connected",
		connectedUnsealed: "connected, not sealed",
		status: {
			thisMachine: (name: string) => `This machine is ${name}.`,
			listening: (host: string, port: number) => `Hub: listening on ${host}:${port}.`,
			hostedBy: (where: string) => `Hub: hosted by ${where}; this session uses it.`,
			notListening: "Hub: not listening (/remote listen [port] [host]).",
			machineRevoked: "revoked",
			machineConnectedSealed: "connected",
			machineConnectedUnsealed: "connected (not sealed)",
			machineOffline: "offline",
			machinesSome: (list: string) => `Machines: ${list}.`,
			machinesNone: "Machines: none yet (/remote add <name>).",
			jobJoined: (args: { hubName: string; address: string; name: string; state: string }) =>
				`${args.hubName} at ${args.address} as ${args.name} (${args.state})`,
			joinedSome: (list: string) => `Joined to: ${list}.`,
			joinedNone: "Joined to: no hub (/remote join <host:port> <token>).",
		},
		listen: {
			listening: (host: string, port: number) => `Listening on ${host}:${port}.`,
			publicNote:
				"The link proves a secret per machine and seals (encrypts and authenticates) every message with machines on a current build; a machine on an older build links unsealed. Prefer a private network (Tailscale, WireGuard) or an SSH tunnel.",
			loopbackNote: "Bound to this machine only; use an SSH tunnel or give a host to reach it from another machine.",
			stopped: "The hub stopped listening. Joined machines stay known and reconnect when it listens again.",
		},
		add: {
			usage: (usage: string) => `Usage: /remote add <name> (lowercase letters, digits, dashes). ${usage}`,
			added: (args: { name: string; address: string; token: string; listening: boolean }) =>
				`${args.name} can join now, as a bot named ${args.name}. On that machine run:\n/remote join ${args.address} ${args.token}\nThe token is shown once; keep it private.${
					args.listening ? "" : "\nThis hub is not listening yet: run /remote listen."
				}`,
			revoked: (name: string) => `${name} was cut off and its bot retired.`,
			unknown: (name: string) => `No machine named ${name}.`,
		},
		join: {
			usage: "Usage: /remote join <host:port> <token>",
			joined: (args: { hubName: string; address: string; name: string }) =>
				`Joined ${args.hubName} at ${args.address} as ${args.name}. Its messages reach this session as a peer's words, never as yours.`,
			left: "Left that hub.",
			notJoined: "No hub joined at that address.",
		},
		rename: (name: string) => `This machine is now ${name}.`,
		unknownCommand: (usage: string) => `Unknown /remote command. ${usage}`,
		failed: "The link command failed.",
	},
	jobs: {
		usage: "/remote jobs | /remote run <name> <task> | /remote cancel <name> | /remote hold <name> | /remote release <name> | /remote trust <name> answers|reads|changes | /remote accept <name> on|off | /remote rotate <name>",
		/** Where one placed job stands. */
		reporting: (status: string) => `${status}, reporting`,
		waitingFor: (executor: string) => `waiting for ${executor} to take it`,
		progress: (phase: string, line: string) => `${phase}: ${line}`,
		taken: "taken",
		/** A record this build cannot read is named rather than read. */
		unreadablePart: (machineName: string, count: number) => `${machineName}: ${count}`,
		unreadableUnnamedMachine: "a machine no longer linked",
		unreadableUnnamed: (count: number) => `${count} with no machine named`,
		unreadableLine: (parts: string) =>
			`Job records this build cannot read, kept as they are and counted as open: ${parts}.`,
		row: (label: string, executor: string, words: string) => `- ${label} on ${executor}: ${words}`,
		placed: (count: number) => `Jobs placed from here (${count}):`,
		nonePlaced: "No jobs placed from here.",
		older: (count: number) => `and ${count} older.`,
		runningHere: (count: number) => `Running here for other machines: ${count}.`,
		nothingRunningHere: "Nothing running here for other machines.",
		unavailable: "Remote jobs are not available in this session.",
		refused: (machine: string, reason: string) => `${machine} was not given the job: ${reason}.`,
		accepted: (machine: string, detail: string) =>
			`${machine} has the job, read-only, ${detail}. Its end reaches this session as a worker report.`,
		inCheckout: "in its checkout of this project",
		noCheckout: "as a question without a checkout (it does not offer this project)",
		rotateUnknown: (name: string) => `No machine named ${name} joined this hub.`,
		rotated: (name: string, token: string) =>
			`${name} has a new secret and was disconnected; its jobs are kept. On that machine run /remote leave, then:\n/remote join <this-hub-address> ${token}\nThe token is shown once; keep it private.`,
		unknownMachine: (name: string, jobUsage: string) =>
			`No linked machine named ${name} has connected yet. Usage: ${jobUsage}`,
		runUsage: "Usage: /remote run <name> <task>",
		noOpenJob: (machine: string) => `No open job on ${machine}.`,
		stopped: (count: number, machine: string) => `Stopped ${count} job(s) on ${machine}.`,
		stopRecorded: (count: number, machine: string) =>
			`Recorded a stop for ${count} job record(s) on ${machine} that this build cannot read. The records stay as they are; the placing session ends each job's lane when it next reconciles, and the stop is sent to ${machine} when it is connected.`,
		held: (machine: string) => `No new job goes to ${machine}; jobs already there continue.`,
		released: (machine: string) => `${machine} can be given jobs again.`,
		trustUsage: "Usage: /remote trust <name> answers|reads|changes",
		trustAnswers: (machine: string) => `${machine} may ask this machine for answers only.`,
		trustReads: (machine: string) => `${machine} may ask this machine for answers and reads of its checkouts.`,
		trustChanges: (machine: string) => `${machine} may ask this machine for answers, reads and changes.`,
		acceptUsage: "Usage: /remote accept <name> on|off",
		accepts: (machine: string) => `This machine runs jobs ${machine} places here.`,
		refuses: (machine: string) => `This machine takes no new jobs from ${machine}; jobs already here finish.`,
	},
	lead: {
		usage: "Usage: /lead [list|show <leader>|cancel <leader>|pause <leader>|resume <leader>]. This works on goals handed to leaders; to make a bot a leader, use /bot lead <id>.",
		/** Why a delegation ended, in the owner's words. The close reason itself is an identifier. */
		closeWords: {
			settled: "the leader finished",
			cancelled: "cancelled",
			deadline: "its time ran out",
			budget: "its budget ran out",
			allowance: "a subscription in use had no allowance left",
			leader_unavailable: "its leader was not available",
		},
		noSuchBot: (alias: string) => `There is no bot named ${alias}. Bot names are in /bot list.`,
		notALeader: (bot: string, alias: string) =>
			`${bot} is not a leader, so it has no goals to show or override. To make it a leader, use /bot lead ${alias}.`,
		listEmpty:
			"No goal has been handed to a leader. The orchestrator hands one over with bot lead; /bot lead <id> makes a bot a standing leader.",
		listHeader: "Goals handed to leaders:",
		listRow: (args: { name: string; leader: string; goal: string; state: string }) =>
			`  ${args.name} (${args.leader}) · ${args.goal} · ${args.state}`,
		leads: (name: string, goal: string) => `${name} leads: ${goal}`,
		state: (state: string, closeWord?: string) => `State: ${state}${closeWord ? ` (${closeWord})` : ""}`,
		appointed: "Appointed by the orchestrator for this goal; retired once it ends.",
		standing: "A standing leader the owner made.",
		requirements: "Must be true at the end:",
		rules: "Rules:",
		mayChange: (paths: string) => `May change: ${paths}`,
		readOnly: "Read-only: no file is changed.",
		budget: (amount: string) =>
			`Budget: $${amount} of metered spending. Subscription turns cost nothing in metered terms, so they are not counted in it.`,
		stopsAt: (at: string) => `Stops at: ${at}`,
		heldBack: "Held back:",
		updatesSent: (count: number) => `Updates sent: ${count}`,
		ledNothing: (name: string) => `${name} is a leader and has led no goal yet.`,
		actionDone: (name: string, state: string) => `${name}: ${state}.`,
	},
	load: {
		usage: "/load",
		estopUsage: "/estop [status] · /estop on [reason] · /estop off",
		estopStatusOn: (args: { reason?: string; engagedAt?: string; usage: string }) =>
			`Emergency stop: engaged${args.reason ? ` — ${args.reason}` : ""}${args.engagedAt ? ` (since ${args.engagedAt})` : ""}; new worker and background provider requests are held on this machine. ${args.usage}`,
		estopStatusOff: (usage: string) => `Emergency stop: off. ${usage}`,
		estopEngaged: (reason?: string) =>
			`Emergency stop engaged${reason ? ` — ${reason}` : ""}: every pi on this machine holds new worker and background provider requests; foreground turns continue. /estop off lifts it.`,
		estopLifted: "Emergency stop lifted; held work resumes now.",
		estopNotEngaged: "No emergency stop was engaged; held paid starts and queued workers resume now.",
		/** The `/load` listing, built by `formatProviderLoadView`. */
		view: {
			header: (count: number) => `Provider load — ${count} request${count === 1 ? "" : "s"} in flight machine-wide`,
			provider: (args: {
				account: string;
				inFlight: number;
				foreground: number;
				worker: number;
				background: number;
				processes: number;
				limit?: number;
				oldest: string;
			}) =>
				`  ${args.account}: ${args.inFlight} in flight (${args.foreground} foreground, ${args.worker} worker, ${args.background} background) ` +
				`across ${args.processes} process${args.processes === 1 ? "" : "es"}${args.limit ? `, limit ${args.limit}` : ""}, oldest ${args.oldest} ago`,
			limitedHeader: "Limited:",
			limitedRow: (args: {
				account: string;
				reason: string;
				until: string;
				left: string;
				pid: number;
				detail?: string;
			}) =>
				`  ${args.account}: ${args.reason} until ${args.until} ` +
				`(${args.left} left, recorded by pid ${args.pid}${args.detail ? `: ${args.detail}` : ""})`,
			limitedNone: "Limited: none recorded",
			windowsHeader: "Provider windows:",
			window: (args: { account: string; name: string; parts: string; seen: string }) =>
				`  ${args.account} ${args.name}: ${args.parts} (seen ${args.seen} ago)`,
			windowUsed: (args: { minutes: string; percent: number; resetsAt?: string }) =>
				`${args.minutes} ${args.percent}% used${args.resetsAt ? ` resets ${args.resetsAt}` : ""}`,
			windowMinutes: (minutes: number) => `${minutes}m`,
			windowFallbackName: "window",
			creditsUnlimited: "unlimited",
			creditsBalance: (balance: string) => `balance ${balance}`,
			creditsNone: "none",
			creditsUnknown: "unknown",
			credits: (args: { account: string; state: string; seen: string }) =>
				`  ${args.account} credits: ${args.state} (seen ${args.seen} ago)`,
			stopEngaged: (args: { reason?: string; engagedAt?: string; path: string }) =>
				`Emergency stop: ENGAGED${args.reason ? ` — ${args.reason}` : ""}${args.engagedAt ? ` (since ${args.engagedAt})` : ""}; new worker and background requests are held (${args.path})`,
			stopOff: "Emergency stop: off (/estop on [reason] pauses new worker and background work on this machine)",
		},
	},
};
