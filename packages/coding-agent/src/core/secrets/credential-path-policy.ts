import {
	assertExecutionAbsolutePath,
	type ExecutionPathFlavor,
	executionPathApi,
	resolveExecutionPath,
} from "@caupulican/pi-agent-core/paths";

export interface CredentialPathProtection {
	protectedFiles?: readonly string[];
	protectedDirectories?: readonly string[];
	/** Native harness storage, not an implicit home on a foreign backend. */
	agentDir?: string;
}

/** Read-only backend facts. Unknown is not proof of a regular file or a native filesystem grant. */
export interface CredentialPathProbe {
	canonicalPath(path: string): string | undefined;
	isFile(path: string): boolean | undefined;
	readonly homeDir?: string;
	readonly harnessRoots?: readonly string[];
	readonly harnessFiles?: readonly string[];
}

/** One path-classification owner for file, process, shell, Python and search credential checks. */
export class CredentialPathPolicy {
	private readonly cwd: string;
	private readonly protection: CredentialPathProtection | undefined;
	private readonly paths: ReturnType<typeof executionPathApi>;
	private readonly flavor: ExecutionPathFlavor;
	private readonly caseSensitive: boolean;
	private readonly probe: CredentialPathProbe;
	private readonly protectionCwd: string | undefined;

	constructor(options: {
		cwd: string;
		flavor: ExecutionPathFlavor;
		caseSensitive: boolean;
		protection?: CredentialPathProtection;
		protectionCwd?: string;
		probe: CredentialPathProbe;
	}) {
		this.cwd = options.cwd;
		this.protection = options.protection;
		this.flavor = options.flavor;
		this.paths = executionPathApi(options.flavor);
		this.caseSensitive = options.caseSensitive;
		this.probe = options.probe;
		this.protectionCwd = options.protectionCwd;
	}

	private samePath(first: string, second: string): boolean {
		return this.caseSensitive ? first === second : first.toLowerCase() === second.toLowerCase();
	}

	private isInside(root: string, target: string): boolean {
		const relative = this.paths.relative(
			this.caseSensitive ? root : root.toLowerCase(),
			this.caseSensitive ? target : target.toLowerCase(),
		);
		return (
			relative === "" ||
			(!relative.startsWith(`..${this.paths.sep}`) && relative !== ".." && !this.paths.isAbsolute(relative))
		);
	}

	private candidates(path: string): string[] {
		const candidates = [path];
		const canonical = this.probe.canonicalPath(path);
		if (canonical !== undefined && canonical !== path) candidates.push(canonical);
		return candidates;
	}

	isProtected(rawPath: string): boolean {
		const candidates = this.candidates(resolveExecutionPath(rawPath, this.cwd, this.flavor));
		const roots = (values: readonly string[] | undefined) =>
			(values ?? []).flatMap((path) => {
				if (this.protectionCwd === undefined) {
					try {
						assertExecutionAbsolutePath(path, this.flavor);
					} catch {
						return [];
					}
				}
				return this.candidates(
					this.protectionCwd === undefined
						? this.paths.normalize(path)
						: resolveExecutionPath(path, this.protectionCwd, this.flavor),
				);
			});
		const files = roots(this.protection?.protectedFiles);
		const directories = roots(this.protection?.protectedDirectories);
		return candidates.some((candidate) => {
			if (
				files.some((file) => this.samePath(file, candidate)) ||
				directories.some((root) => this.isInside(root, candidate))
			)
				return true;
			const name = this.paths.basename(candidate);
			const comparable = this.caseSensitive ? name : name.toLowerCase();
			return comparable === ".env" || comparable.startsWith(".env.") || comparable.endsWith(".env");
		});
	}

	isFile(rawPath: string): boolean | undefined {
		return this.probe.isFile(resolveExecutionPath(rawPath, this.cwd, this.flavor));
	}

	isHarnessOwnedSearchTarget(rawPath: string): boolean {
		const path = this.probe.homeDir === undefined ? rawPath : rawPath.replace(/^~(?=$|[\\/])/u, this.probe.homeDir);
		const target = resolveExecutionPath(path, this.cwd, this.flavor);
		return (
			(this.probe.harnessRoots ?? []).some((root) => this.isInside(root, target)) ||
			(this.probe.harnessFiles ?? []).some((file) => this.samePath(target, file))
		);
	}

	executableName(path: string): string {
		return this.paths
			.basename(path)
			.toLowerCase()
			.replace(/\.exe$/u, "");
	}
}
