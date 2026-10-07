import { captureInstalledCliEnvironment, type InstalledCliEnvironment } from "../utils/installed-cli.ts";
import {
	ANTHROPIC_OAUTH_PROTOCOL,
	type AnthropicClientIdentity,
	type AnthropicOAuthProtocol,
	createAnthropicClientIdentity,
	PACKAGED_ANTHROPIC_IDENTITY,
	REVIEWED_CLAUDE_INSTALLATIONS,
} from "./anthropic-compatibility-profile.ts";
import { type ClaudeInstallationInspection, ClaudeInstallationInspector } from "./claude-installation.ts";

/** Packaged defaults; runtime requests consume a resolved compatibility snapshot. */
export const ANTHROPIC_MESSAGES_USER_AGENT = PACKAGED_ANTHROPIC_IDENTITY.messagesUserAgent;
export const ANTHROPIC_USAGE_USER_AGENT = PACKAGED_ANTHROPIC_IDENTITY.usageUserAgent;

export interface AnthropicCompatibilitySnapshot {
	readonly identity: AnthropicClientIdentity;
	readonly oauth: AnthropicOAuthProtocol;
	readonly source: "installed" | "packaged";
	readonly inspection: "reviewed" | "absent" | "unavailable" | "unreviewed";
	readonly installedVersion?: string;
	readonly warning?: string;
}

export interface ClaudeCompatibilityInspectionPort {
	inspect(override?: string, environment?: InstalledCliEnvironment): Promise<ClaudeInstallationInspection>;
}

/** Owns selection, concurrent discovery and bounded refresh of process-local compatibility data. */
export class AnthropicCompatibilityResolver {
	private readonly inspector: ClaudeCompatibilityInspectionPort;
	private readonly now: () => number;
	private cache: { key: string; expiresAt: number; snapshot: AnthropicCompatibilitySnapshot } | undefined;
	private readonly pending = new Map<string, Promise<AnthropicCompatibilitySnapshot>>();

	constructor(inspector: ClaudeCompatibilityInspectionPort, now: () => number = () => performance.now()) {
		this.inspector = inspector;
		this.now = now;
	}

	resolve(
		key: string,
		override?: string,
		environment?: InstalledCliEnvironment,
	): Promise<AnthropicCompatibilitySnapshot> {
		if (this.cache?.key === key && this.now() < this.cache.expiresAt) return Promise.resolve(this.cache.snapshot);
		const existing = this.pending.get(key);
		if (existing) return existing;
		if (this.pending.size >= 4) return Promise.resolve(this.snapshot({ status: "unavailable" }));
		const promise = this.inspect(override, environment).then((snapshot) => {
			if (this.pending.get(key) === promise) {
				this.cache = {
					key,
					expiresAt: this.now() + (snapshot.inspection === "reviewed" ? 60_000 : 30_000),
					snapshot,
				};
				this.pending.delete(key);
			}
			return snapshot;
		});
		this.pending.set(key, promise);
		return promise;
	}

	private async inspect(
		override?: string,
		environment?: InstalledCliEnvironment,
	): Promise<AnthropicCompatibilitySnapshot> {
		let result: ClaudeInstallationInspection;
		try {
			result = await this.inspector.inspect(override, environment);
		} catch {
			result = { status: "unavailable" };
		}
		return this.snapshot(result);
	}

	private snapshot(result: ClaudeInstallationInspection): AnthropicCompatibilitySnapshot {
		const reviewed =
			result.status === "inspected"
				? REVIEWED_CLAUDE_INSTALLATIONS.find(
						(profile) => profile.version === result.version && profile.sha256 === result.sha256,
					)
				: undefined;
		const identity =
			reviewed && result.status === "inspected"
				? createAnthropicClientIdentity(result.version)
				: PACKAGED_ANTHROPIC_IDENTITY;
		const inspection = reviewed ? "reviewed" : result.status === "inspected" ? "unreviewed" : result.status;
		const installedVersion = result.status === "inspected" ? result.version : undefined;
		const warning =
			inspection === "unreviewed"
				? `Installed Claude ${installedVersion} has not been verified for login and token refresh. Using packaged Claude ${identity.version} compatibility; Pi needs a compatibility update.`
				: inspection === "unavailable"
					? `Claude compatibility inspection was unavailable. Using packaged Claude ${identity.version} compatibility.`
					: undefined;
		return Object.freeze({
			identity,
			oauth: reviewed?.oauth ?? ANTHROPIC_OAUTH_PROTOCOL,
			source: reviewed ? "installed" : "packaged",
			inspection,
			installedVersion,
			warning,
		});
	}
}

const compatibilityResolver = new AnthropicCompatibilityResolver(new ClaudeInstallationInspector());

export function resolveAnthropicCompatibility(): Promise<AnthropicCompatibilitySnapshot> {
	const override = typeof process === "undefined" ? undefined : process.env?.PI_CLAUDE_PATH;
	try {
		const environment = captureInstalledCliEnvironment();
		const key = JSON.stringify([override ?? "", environment?.path, environment?.cwd, environment?.platform]);
		return compatibilityResolver.resolve(key, override, environment);
	} catch {
		return compatibilityResolver.resolve("unavailable-environment", override);
	}
}
