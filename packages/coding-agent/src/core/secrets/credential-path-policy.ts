import {
	assertExecutionAbsolutePath,
	type ExecutionPathFlavor,
	executionPathApi,
	resolveExecutionPath,
} from "../../kernel/utils/paths.ts";
import { isPathWithinScopeWithDialect } from "../autonomy/path-scope.ts";
import { requireSynchronousPreflight } from "../preflight.ts";

export interface CredentialPathProtection {
	protectedFiles?: readonly string[];
	protectedDirectories?: readonly string[];
	/**
	 * Protected files a recursive search may pass through: denied to a read that names them, but project files rather
	 * than storage (a project's own settings file), so a search root containing one is not refused for it.
	 */
	searchableFiles?: readonly string[];
	/** Native harness storage, not an implicit home on a foreign backend. */
	agentDir?: string;
}

/** Read-only backend facts. Unknown is not proof of a regular file or a native filesystem grant. */
export interface CredentialPathProbe {
	canonicalPath(path: string, signal?: AbortSignal): Promise<string | undefined> | string | undefined;
	isFile(path: string, signal?: AbortSignal): Promise<boolean | undefined> | boolean | undefined;
	readonly homeDir?: string;
	readonly harnessRoots?: readonly string[];
	readonly harnessFiles?: readonly string[];
}

/** `~`, `$HOME`/`${HOME}` (POSIX shells) and `$USERPROFILE`/`$env:USERPROFILE`/`%USERPROFILE%` (Windows shells) at a path's start. */
const HOME_PREFIX_RE = /^(?:~|\$HOME|\$\{HOME\})(?=$|[\\/])/u;
const WINDOWS_HOME_PREFIX_RE = /^(?:\$USERPROFILE|\$\{USERPROFILE\}|\$env:USERPROFILE|%USERPROFILE%)(?=$|[\\/])/iu;
/**
 * `/proc/<pid>[/task/<tid>]/{environ,mem}`: the environment or memory of whichever process it names (another session's
 * environment can carry credentials). A command line stays readable: `ps` prints every one anyway.
 */
const PROCESS_SECRET_FILE_RE = /^\/proc\/[^/]+(?:\/task\/[^/]+)?\/(?:environ|mem)$/u;

/** Protection entries with every spelling the policy compares: as written and canonical. */
interface ProtectionRoots {
	readonly files: readonly string[];
	readonly directories: readonly string[];
	/** Every protected file and directory except the searchable files: what a search root must not contain. */
	readonly storage: readonly string[];
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
	/** The synchronous protection roots, resolved once per policy (search-output masking asks per output line). */
	private synchronousRoots: ProtectionRoots | undefined;

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

	/** The same policy judging paths from `cwd` instead: a command line that changed directory before naming a path. */
	withCwd(cwd: string): CredentialPathPolicy {
		return new CredentialPathPolicy({
			cwd: resolveExecutionPath(this.expandHome(cwd), this.cwd, this.flavor),
			flavor: this.flavor,
			caseSensitive: this.caseSensitive,
			protection: this.protection,
			protectionCwd: this.protectionCwd,
			probe: this.probe,
		});
	}

	/** Where this policy resolves relative paths. */
	get workingDirectory(): string {
		return this.cwd;
	}

	/**
	 * A path written with the home directory's shell spelling, expanded the way the shell that runs it expands it. With
	 * no known home (a foreign backend), the path stays literal.
	 */
	private expandHome(rawPath: string): string {
		const home = this.probe.homeDir;
		if (home === undefined) return rawPath;
		return rawPath.replace(HOME_PREFIX_RE, home).replace(WINDOWS_HOME_PREFIX_RE, home);
	}

	private samePath(first: string, second: string): boolean {
		return this.caseSensitive ? first === second : first.toLowerCase() === second.toLowerCase();
	}

	private isInside(root: string, target: string): boolean {
		return isPathWithinScopeWithDialect(target, root, this.flavor, this.caseSensitive);
	}

	/**
	 * Every spelling a written path is compared by: resolved from the cwd, and, when it walks `..`, the same words joined
	 * to the cwd unnormalized. A `..` after a symbolic link leaves the link's target, not its lexical parent
	 * (`node_modules/linked/../../x`), which only the probe's canonical form of the unnormalized spelling shows.
	 */
	private spellings(rawPath: string): string[] {
		const expanded = this.expandHome(rawPath);
		const resolved = resolveExecutionPath(expanded, this.cwd, this.flavor);
		if (!expanded.split(this.flavor === "win32" ? /[\\/]/u : /\//u).includes("..")) return [resolved];
		return [resolved, this.paths.isAbsolute(expanded) ? expanded : `${this.cwd}${this.paths.sep}${expanded}`];
	}

	/** The first spelling as written, then the canonical form of each spelling the probe resolves. */
	private candidates(spellings: readonly string[]): string[] {
		const candidates = [spellings[0]];
		for (const spelling of spellings) {
			const canonical = requireSynchronousPreflight(this.probe.canonicalPath(spelling));
			if (typeof canonical === "string" && !candidates.includes(canonical)) candidates.push(canonical);
		}
		return candidates;
	}

	private async candidatesAsync(spellings: readonly string[], signal?: AbortSignal): Promise<string[]> {
		const candidates = [spellings[0]];
		for (const spelling of spellings) {
			signal?.throwIfAborted();
			const canonical = await this.probe.canonicalPath(spelling, signal);
			signal?.throwIfAborted();
			if (canonical !== undefined && !candidates.includes(canonical)) candidates.push(canonical);
		}
		return candidates;
	}

	/** The protection entries resolved the way they are compared, before canonical forms are added. */
	private protectionEntries(): { files: string[]; directories: string[]; storage: string[] } {
		const resolve = (values: readonly string[] | undefined) =>
			(values ?? []).flatMap((path) => {
				if (this.protectionCwd === undefined) {
					try {
						assertExecutionAbsolutePath(path, this.flavor);
					} catch {
						return [];
					}
					return [this.paths.normalize(path)];
				}
				return [resolveExecutionPath(path, this.protectionCwd, this.flavor)];
			});
		const files = resolve(this.protection?.protectedFiles);
		const directories = resolve(this.protection?.protectedDirectories);
		const searchable = resolve(this.protection?.searchableFiles);
		const storage = [...new Set([...files, ...directories])].filter(
			(entry) => !searchable.some((file) => this.samePath(file, entry)),
		);
		return { files, directories, storage };
	}

	private roots(): ProtectionRoots {
		if (this.synchronousRoots === undefined) {
			const entries = this.protectionEntries();
			const canonical = (values: readonly string[]) => values.flatMap((value) => this.candidates([value]));
			this.synchronousRoots = {
				files: canonical(entries.files),
				directories: canonical(entries.directories),
				storage: canonical(entries.storage),
			};
		}
		return this.synchronousRoots;
	}

	private async rootsAsync(signal?: AbortSignal): Promise<ProtectionRoots> {
		const entries = this.protectionEntries();
		const canonical = async (values: readonly string[]) => {
			const collected: string[] = [];
			for (const value of values) collected.push(...(await this.candidatesAsync([value], signal)));
			return collected;
		};
		return {
			files: await canonical(entries.files),
			directories: await canonical(entries.directories),
			storage: await canonical(entries.storage),
		};
	}

	private hasCredentialFilename(path: string): boolean {
		const name = this.paths.basename(path);
		const comparable = this.caseSensitive ? name : name.toLowerCase();
		return comparable === ".env" || comparable.startsWith(".env.") || comparable.endsWith(".env");
	}

	private isLexicallyProtectedToken(token: string, root: string): boolean {
		// With no drive cwd, only lexical evidence is available. Known credential filenames and
		// protected-directory components remain conservative refusals, never filesystem grants.
		const name = this.paths.basename(token);
		const components = this.paths.normalize(token.slice(root.length)).split(this.paths.sep);
		return (
			this.hasCredentialFilename(token) ||
			(this.protection?.protectedFiles ?? []).some((file) => this.samePath(this.paths.basename(file), name)) ||
			(this.protection?.protectedDirectories ?? []).some((directory) =>
				components.some((component) => this.samePath(component, this.paths.basename(directory))),
			)
		);
	}

	/** Opaque argv/code literals are not declared file requests. Never invent a drive cwd for them. */
	isProtectedToken(rawToken: string): boolean {
		const token = this.expandHome(rawToken);
		const root = this.paths.parse(token).root;
		if (this.flavor !== "win32" || !root.endsWith(":") || this.paths.isAbsolute(token))
			return this.isProtected(token);
		return this.isLexicallyProtectedToken(token, root);
	}

	async isProtectedTokenAsync(rawToken: string, signal?: AbortSignal): Promise<boolean> {
		signal?.throwIfAborted();
		const token = this.expandHome(rawToken);
		const root = this.paths.parse(token).root;
		if (this.flavor !== "win32" || !root.endsWith(":") || this.paths.isAbsolute(token))
			return this.isProtectedAsync(token, signal);
		return this.isLexicallyProtectedToken(token, root);
	}

	isProtected(rawPath: string): boolean {
		return this.matchesProtectionCriteria(this.candidates(this.spellings(rawPath)), this.roots());
	}

	async isProtectedAsync(rawPath: string, signal?: AbortSignal): Promise<boolean> {
		signal?.throwIfAborted();
		const candidates = await this.candidatesAsync(this.spellings(rawPath), signal);
		return this.matchesProtectionCriteria(candidates, await this.rootsAsync(signal));
	}

	/**
	 * True when a protected path other than a searchable file lies inside `rawRoot`, so a recursive search from it would
	 * descend into storage. A root that is itself protected is {@link isProtected}'s.
	 */
	containsProtectedPath(rawRoot: string): boolean {
		return this.containsStorage(this.candidates(this.spellings(rawRoot)), this.roots());
	}

	async containsProtectedPathAsync(rawRoot: string, signal?: AbortSignal): Promise<boolean> {
		signal?.throwIfAborted();
		const candidates = await this.candidatesAsync(this.spellings(rawRoot), signal);
		return this.containsStorage(candidates, await this.rootsAsync(signal));
	}

	private containsStorage(candidates: readonly string[], roots: ProtectionRoots): boolean {
		return candidates.some((candidate) => roots.storage.some((entry) => this.isInside(candidate, entry)));
	}

	private matchesProtectionCriteria(candidates: readonly string[], roots: ProtectionRoots): boolean {
		return candidates.some(
			(candidate) =>
				roots.files.some((file) => this.samePath(file, candidate)) ||
				roots.directories.some((root) => this.isInside(root, candidate)) ||
				this.hasCredentialFilename(candidate) ||
				(this.flavor === "posix" && PROCESS_SECRET_FILE_RE.test(candidate)),
		);
	}

	isFile(rawPath: string): boolean | undefined {
		const result = requireSynchronousPreflight(
			this.probe.isFile(resolveExecutionPath(this.expandHome(rawPath), this.cwd, this.flavor)),
		);
		return typeof result === "boolean" ? result : undefined;
	}

	async isFileAsync(rawPath: string, signal?: AbortSignal): Promise<boolean | undefined> {
		signal?.throwIfAborted();
		const resolved = resolveExecutionPath(this.expandHome(rawPath), this.cwd, this.flavor);
		const result = await this.probe.isFile(resolved, signal);
		signal?.throwIfAborted();
		return typeof result === "boolean" ? result : undefined;
	}

	isHarnessOwnedSearchTarget(rawPath: string): boolean {
		const target = resolveExecutionPath(this.expandHome(rawPath), this.cwd, this.flavor);
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
