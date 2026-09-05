import { getStableSelfLaunchTarget } from "../process-matrix/self-launch-target.ts";
import {
	type CollaborationCommandResult,
	type CollaborationCommandRunner,
	runCollaborationCommand,
} from "./command-runner.ts";

export interface NativeProviderSelection {
	provider?: string;
	model?: string;
	/** Explicit wrapper binary, probed with the selected provider's native status protocol. */
	executable?: string;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
}
export interface NativeAuthVerdict {
	authenticated: boolean;
	launchArgs: string[];
}
export interface NativeProviderInvocation {
	executable: string;
	argsPrefix: string[];
	/** Only stable invocation overrides, never the provider's ambient authentication environment. */
	environment?: Readonly<Record<string, string>>;
	lifecycle: "current-harness" | "external-cli";
}
export interface NativeProviderStrategy {
	readonly id: string;
	/** A supported interactive agent kind in the selected collaboration backend. */
	readonly kind: string;
	readonly executable: string;
	readonly presenceArgs?: readonly string[];
	authArgs(selection: NativeProviderSelection): string[];
	parseAuth(result: CollaborationCommandResult, selection: NativeProviderSelection): NativeAuthVerdict;
}
export interface NativeProviderReadiness {
	id: string;
	kind?: string;
	executable?: string;
	invocation?: NativeProviderInvocation;
	installed: boolean;
	authenticated: boolean;
	status: "ready" | "not-installed" | "login-required" | "probe-failed" | "unsupported";
	launchArgs: string[];
	/** Local CLI evidence is not a paid inference or a guarantee against server-side revocation. */
	evidence: "native-status" | "model-catalog" | "none";
}

/** Explicit user-authorized collaboration policy; this never changes a native CLI's global configuration. */
export function nativeCollaborationLaunchArgs(kind: string, args: readonly string[]): string[] {
	const flag =
		kind === "codex"
			? "--dangerously-bypass-approvals-and-sandbox"
			: kind === "claude" || kind === "agy"
				? "--dangerously-skip-permissions"
				: undefined;
	if (!flag) return [...args];
	const conflicts =
		kind === "codex" ? /^(?:--sandbox|--ask-for-approval|--full-auto|-s|-a)(?:=|$)/ : /^--permission-mode(?:=|$)/;
	if (args.some((arg) => conflicts.test(arg)))
		throw new Error(
			"Native collaboration launch conflicts with the explicitly authorized unrestricted permission mode.",
		);
	return [...args.filter((arg) => arg !== flag), flag];
}

function jsonRecord(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

const nativeStrategies: readonly NativeProviderStrategy[] = [
	{
		id: "pi",
		kind: "pi",
		executable: "pi",
		authArgs: (selection) => [
			"auth",
			"check",
			"--json",
			"--no-refresh",
			...(selection.provider ? ["--provider", selection.provider] : []),
			...(selection.model ? ["--model", selection.model] : []),
		],
		parseAuth: (result, selection) => {
			const providers = jsonRecord(result.stdout)?.providers;
			const provider = Array.isArray(providers)
				? (providers.find((entry: unknown) => {
						if (typeof entry !== "object" || entry === null) return false;
						const report = entry as Record<string, unknown>;
						return (
							typeof report.provider === "string" &&
							report.provider.length <= 128 &&
							report.configured === true &&
							report.status === "valid" &&
							(!selection.provider || selection.provider === report.provider)
						);
					}) as Record<string, unknown> | undefined)
				: undefined;
			return {
				authenticated: provider !== undefined,
				launchArgs: provider
					? ["--provider", String(provider.provider), ...(selection.model ? ["--model", selection.model] : [])]
					: [],
			};
		},
	},
	{
		id: "codex",
		kind: "codex",
		executable: "codex",
		authArgs: () => ["login", "status"],
		parseAuth: (result) => ({
			authenticated: result.code === 0 && /\bLogged in\b/i.test(`${result.stdout}\n${result.stderr}`),
			launchArgs: [],
		}),
	},
	{
		id: "claude",
		kind: "claude",
		executable: "claude",
		authArgs: () => ["auth", "status"],
		parseAuth: (result) => ({ authenticated: jsonRecord(result.stdout)?.loggedIn === true, launchArgs: [] }),
	},
	{
		id: "agy",
		kind: "agy",
		executable: "agy",
		presenceArgs: ["--help"],
		authArgs: () => ["models"],
		parseAuth: (result) => ({
			authenticated: result.stdout
				.split(/\r?\n/)
				.some((line) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}\t[^\t\r\n]{1,256}$/.test(line)),
			launchArgs: [],
		}),
	},
];

/** One readiness policy. Native strategies only supply the provider's status I/O and projection. */
export class NativeProviderRegistry {
	private readonly strategies = new Map<string, NativeProviderStrategy>();
	private readonly run: CollaborationCommandRunner;
	private readonly selfLaunch: typeof getStableSelfLaunchTarget;

	constructor(
		run: CollaborationCommandRunner = runCollaborationCommand,
		additional: readonly NativeProviderStrategy[] = [],
		selfLaunch: typeof getStableSelfLaunchTarget = getStableSelfLaunchTarget,
	) {
		this.run = run;
		this.selfLaunch = selfLaunch;
		for (const strategy of [...nativeStrategies, ...additional]) {
			if (this.strategies.has(strategy.id))
				throw new Error(`Duplicate native collaboration provider strategy: ${strategy.id}`);
			this.strategies.set(strategy.id, strategy);
		}
	}

	/** A preview and an admitted launch share this exact argv owner; probes never resolve a second target. */
	resolveInvocation(id: string, selection: NativeProviderSelection = {}): NativeProviderInvocation {
		const strategy = this.strategies.get(id);
		if (!strategy) throw new Error(`Unsupported native collaboration provider: ${id}`);
		if (id === "pi" && !selection.executable) {
			const target = this.selfLaunch();
			if (!target) throw new Error("A stable current-harness Pi launch target is unavailable.");
			return {
				executable: target.executable,
				argsPrefix: [...target.argsPrefix],
				...(target.environment ? { environment: { ...target.environment } } : {}),
				lifecycle: "current-harness",
			};
		}
		return { executable: selection.executable ?? strategy.executable, argsPrefix: [], lifecycle: "external-cli" };
	}

	async inspect(id: string, selection: NativeProviderSelection = {}): Promise<NativeProviderReadiness> {
		const strategy = this.strategies.get(id);
		const base: NativeProviderReadiness = {
			id,
			installed: false,
			authenticated: false,
			status: "unsupported",
			launchArgs: [],
			evidence: "none",
		};
		if (!strategy) return base;
		base.kind = strategy.kind;
		let invocation: NativeProviderInvocation;
		try {
			invocation = this.resolveInvocation(id, selection);
		} catch {
			return { ...base, status: "probe-failed" };
		}
		base.invocation = invocation;
		base.executable = invocation.executable;
		const env = invocation.environment
			? { ...process.env, ...selection.env, ...invocation.environment }
			: selection.env;
		const version = await this.run(
			base.executable,
			[...invocation.argsPrefix, ...(strategy.presenceArgs ?? ["--version"])],
			{
				timeoutMs: 10000,
				env,
				cwd: selection.cwd,
			},
		);
		if (version.reason !== "exited" || version.code !== 0)
			return { ...base, status: version.reason === "not_found" ? "not-installed" : "probe-failed" };
		base.installed = true;
		const result = await this.run(base.executable, [...invocation.argsPrefix, ...strategy.authArgs(selection)], {
			timeoutMs: 30000,
			env,
			cwd: selection.cwd,
		});
		if (result.reason !== "exited") return { ...base, status: "probe-failed" };
		const verdict =
			result.code === 0 ? strategy.parseAuth(result, selection) : { authenticated: false, launchArgs: [] };
		return {
			...base,
			...verdict,
			launchArgs: verdict.authenticated ? nativeCollaborationLaunchArgs(strategy.kind, verdict.launchArgs) : [],
			status: verdict.authenticated ? "ready" : "login-required",
			evidence: id === "agy" ? "model-catalog" : "native-status",
		};
	}

	async list(): Promise<NativeProviderReadiness[]> {
		return Promise.all([...this.strategies.keys()].map((id) => this.inspect(id)));
	}
}
