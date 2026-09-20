import { createHash, randomUUID } from "node:crypto";
import type { ExecutionCharter } from "../autonomy/execution-charter.ts";
import type {
	AcquisitionDecision,
	AcquisitionDisposition,
	AcquisitionRequest,
	DeterministicFinding,
	ExternalAcquisitionRecord,
	ResolvedSafeRoute,
} from "./types.ts";

export interface SteeringPlane {
	requireCertificate(
		checkpoint: string,
		payload: unknown,
		context?: { objectiveId?: string; taskId?: string; evidenceRevision?: number; signal?: AbortSignal },
	): Promise<{ certificate_id: string; answers?: Record<string, unknown> }>;
}

export interface DecisionEngine {
	evaluate(
		program: unknown,
		state?: Record<string, unknown>,
		options?: { consequence?: string; signal?: AbortSignal },
	): Promise<{
		answers?: Record<string, { type?: string; noul?: number; choice?: string; value?: boolean | number }>;
		results?: Record<string, { kind?: string; confidence?: { value?: number }; selected?: unknown }>;
	}>;
}

export interface ExternalCapabilityAcquisitionGateDeps {
	steering?: SteeringPlane;
	decisionEngine?: DecisionEngine;
	availableCapabilities?: readonly string[];
	installedPackages?: readonly string[];
	/**
	 * The actual ExecutionCharter. Authority comes from it and nowhere else; a gate constructed
	 * without one has no authority to grant and denies every acquisition.
	 */
	charter?: ExecutionCharter;
	/**
	 * True when a semantic decision is mandatory. A missing or malformed decision then routes to the
	 * safer alternative or denies; it never becomes a direct allow.
	 */
	systemOneRequired?: boolean;
	/** Resolves a chosen route into an executable plan. */
	resolveRoute?: (route: string, request: AcquisitionRequest) => ResolvedSafeRoute;
	/**
	 * Authority the operator granted at the edge during this session, read live.
	 *
	 * This is a recorded grant, not a default: an operator who granted `package.install` has
	 * authorized package installs just as surely as a charter clause would, and the gate must not
	 * re-deny what the operator already allowed. Absent grants stay denied.
	 */
	getGrantedAuthority?: () => Partial<{
		allowShellExecution: boolean;
		allowNetworkDownloads: boolean;
		allowPackageInstalls: boolean;
	}>;
}

/** Package-manager install shapes the charter's package-install grant governs. */
const PACKAGE_INSTALL_PATTERN =
	/\b(?:npm\s+(?:i|install|add)|pnpm\s+(?:add|install)|yarn\s+add|bun\s+(?:add|install)|pip3?\s+install|cargo\s+install|go\s+install|gem\s+install|apt(?:-get)?\s+install|brew\s+install)\b/i;

export function isPackageInstall(request: AcquisitionRequest): boolean {
	return PACKAGE_INSTALL_PATTERN.test(`${request.command ?? ""} ${request.source} ${request.scriptContent ?? ""}`);
}

/** Closed-world authority: every permission absent from the charter is denied. */
const NO_ACQUISITION_AUTHORITY = {
	allowShellExecution: false,
	allowNetworkDownloads: false,
	allowPackageInstalls: false,
} as const;

/**
 * ExternalCapabilityAcquisitionGate:
 * Evaluates external packages, scripts, binaries, and installer downloads before execution.
 * Deterministic safety checks dominate and cannot be overridden by Jev.
 * Implements FR-080..FR-090.
 */
export class ExternalCapabilityAcquisitionGate {
	private readonly steering?: SteeringPlane;
	private readonly decisionEngine?: DecisionEngine;
	private readonly availableCapabilities: Set<string>;
	private readonly installedPackages: Set<string>;
	private readonly charterAuthority: {
		allowShellExecution: boolean;
		allowNetworkDownloads: boolean;
		allowPackageInstalls: boolean;
	};
	private readonly systemOneRequired: boolean;
	private readonly getGrantedAuthority?: ExternalCapabilityAcquisitionGateDeps["getGrantedAuthority"];
	private readonly resolveRouteFn?: ExternalCapabilityAcquisitionGateDeps["resolveRoute"];
	private readonly records: ExternalAcquisitionRecord[] = [];

	constructor(deps: ExternalCapabilityAcquisitionGateDeps = {}) {
		this.steering = deps.steering;
		this.decisionEngine = deps.decisionEngine;
		this.availableCapabilities = new Set(deps.availableCapabilities ?? []);
		this.installedPackages = new Set(deps.installedPackages ?? []);
		this.systemOneRequired = deps.systemOneRequired === true;
		this.getGrantedAuthority = deps.getGrantedAuthority;
		this.resolveRouteFn = deps.resolveRoute;
		// Authority is read from the actual charter. No charter means no authority, which is a denial,
		// never an assumed permission.
		this.charterAuthority = deps.charter
			? {
					allowShellExecution: deps.charter.acquisition.shell_execution,
					allowNetworkDownloads: deps.charter.acquisition.network_downloads,
					allowPackageInstalls: deps.charter.acquisition.package_installs,
				}
			: { ...NO_ACQUISITION_AUTHORITY };
	}

	/**
	 * The authority in force for this call: the charter's clauses plus any grant the operator
	 * recorded at the edge. Both are real sources; nothing is assumed.
	 */
	private authorityNow(): {
		allowShellExecution: boolean;
		allowNetworkDownloads: boolean;
		allowPackageInstalls: boolean;
	} {
		const granted = this.getGrantedAuthority?.() ?? {};
		return {
			allowShellExecution: this.charterAuthority.allowShellExecution || granted.allowShellExecution === true,
			allowNetworkDownloads: this.charterAuthority.allowNetworkDownloads || granted.allowNetworkDownloads === true,
			allowPackageInstalls: this.charterAuthority.allowPackageInstalls || granted.allowPackageInstalls === true,
		};
	}

	getRecords(): readonly ExternalAcquisitionRecord[] {
		return [...this.records];
	}

	/**
	 * FR-081, FR-082, FR-083, FR-084, FR-085, FR-086, FR-087:
	 * Screen and evaluate acquisition requests.
	 */
	async evaluateAcquisition(request: AcquisitionRequest): Promise<AcquisitionDecision> {
		const targetContent = `${request.source} ${request.command ?? ""} ${request.scriptContent ?? ""}`;
		const digest = request.scriptContent
			? createHash("sha256").update(request.scriptContent).digest("hex")
			: request.command
				? createHash("sha256").update(request.command).digest("hex")
				: createHash("sha256").update(request.source).digest("hex");

		const deterministicFindings = this.inspectDeterministic(request, targetContent);
		const authority = this.authorityNow();

		// FR-087: Check charter authority bounds
		if (
			!authority.allowNetworkDownloads &&
			(request.source.startsWith("http://") || request.source.startsWith("https://"))
		) {
			deterministicFindings.push({
				id: "charter-network-prohibited",
				level: "deny",
				message: "Network downloads are not authorized by the execution charter.",
			});
		}

		if (!authority.allowPackageInstalls && isPackageInstall(request)) {
			deterministicFindings.push({
				id: "charter-package-install-prohibited",
				level: "deny",
				message: "Package installs are not authorized by the execution charter.",
			});
		}

		// Shell execution governs running externally-obtained script content. It deliberately does not
		// fire on the mere presence of a command: that would subsume the package-install and
		// network-download clauses, making both dead and defeating an operator's own edge grant.
		const hasScriptContent = typeof request.scriptContent === "string" && request.scriptContent.length > 0;
		if (!authority.allowShellExecution && hasScriptContent) {
			deterministicFindings.push({
				id: "charter-shell-execution-prohibited",
				level: "deny",
				message: "Executing externally-obtained script content is not authorized by the execution charter.",
			});
		}

		const hasHardDeny = deterministicFindings.some((f) => f.level === "deny");
		const hasRiskSignals = deterministicFindings.some((f) => f.level === "warn");

		// FR-085: Deterministic deny dominates. Jev cannot override it.
		if (hasHardDeny) {
			// Check if a safe inspectable alternative can be used (e.g. for raw fetch-to-shell or unpinned code)
			const fetchToShell = deterministicFindings.some((f) => f.id === "raw-fetch-to-shell");
			const unpinnedPkg = deterministicFindings.some((f) => f.id === "mutable-ref-or-unpinned");

			// For active malicious patterns (reverse shell, credentials exfil, destructive ops, TLS disable), outright deny
			const isSevereExploit = deterministicFindings.some(
				(f) =>
					f.id === "credential-exfiltration" ||
					f.id === "reverse-shell" ||
					f.id === "destructive-filesystem-op" ||
					f.id === "tls-verification-disabled" ||
					f.id === "security-control-tampering" ||
					f.id === "shell-env-hijacking",
			);

			if (isSevereExploit || (!fetchToShell && !unpinnedPkg)) {
				const record = this.createAndStoreRecord(request, digest, deterministicFindings, "deny", null, null);
				const firstDeny = deterministicFindings.find((f) => f.level === "deny");
				return {
					disposition: "deny",
					record,
					summaryEvent: `Acquisition blocked · deterministic deny: ${firstDeny?.message ?? "high-risk pattern"}`,
					allowed: false,
					rewritten: false,
					denied: true,
				};
			}

			// FR-086: For raw fetch-to-shell or unpinned requests, route to safe inspectable alternative
			const safeRoute = this.determineSafeRoute(request);
			const record = this.createAndStoreRecord(
				request,
				digest,
				deterministicFindings,
				"rewrite_safe_route",
				safeRoute,
				null,
			);

			return {
				disposition: "rewrite_safe_route",
				chosenRoute: safeRoute,
				resolvedRoute: this.resolveRoute(safeRoute, request),
				record,
				summaryEvent: `Acquisition hardened · replaced unverified execution with ${safeRoute}`,
				allowed: false,
				rewritten: true,
				denied: false,
			};
		}

		// FR-084: Jev semantic questions (only after deterministic screening passes)
		let certificateId: string | null = null;
		let saferExistingPreferred = false;
		let acquisitionRequired = true;
		let sideEffectsProportionate = true;
		let sourceMatchesCapability = true;
		let semanticDecisionObserved = false;

		if (this.steering) {
			try {
				const cert = await this.steering.requireCertificate(
					"external_capability_acquisition",
					{
						objective_id: request.objectiveId,
						capability_id: request.capabilityId,
						source: request.source,
						digest,
						deterministic_findings: deterministicFindings,
					},
					{ objectiveId: request.objectiveId, signal: request.signal },
				);
				certificateId = cert.certificate_id;
				if (cert.answers) {
					semanticDecisionObserved = true;
					if (typeof cert.answers.acquisition_required_for_objective === "boolean") {
						acquisitionRequired = cert.answers.acquisition_required_for_objective;
					}
					if (typeof cert.answers.side_effects_proportionate === "boolean") {
						sideEffectsProportionate = cert.answers.side_effects_proportionate;
					}
					if (typeof cert.answers.safer_existing_route_preferred === "boolean") {
						saferExistingPreferred = cert.answers.safer_existing_route_preferred;
					}
					if (typeof cert.answers.source_matches_requested_capability === "boolean") {
						sourceMatchesCapability = cert.answers.source_matches_requested_capability;
					}
				}
			} catch {
				// Jev failure retains conservative stance
			}
		} else if (this.decisionEngine) {
			try {
				const evalRes = await this.decisionEngine.evaluate(
					{
						program: "external_capability_acquisition",
						questions: [
							"acquisition_required_for_objective",
							"side_effects_proportionate",
							"safer_existing_route_preferred",
							"source_matches_requested_capability",
						],
					},
					{
						objective_id: request.objectiveId,
						capability_id: request.capabilityId,
						source: request.source,
					},
					{ consequence: "low", signal: request.signal },
				);
				const answers = evalRes.answers ?? {};
				semanticDecisionObserved = Object.keys(answers).length > 0;
				if (answers.acquisition_required_for_objective) {
					acquisitionRequired = (answers.acquisition_required_for_objective.noul ?? 1) >= 0.5;
				}
				if (answers.side_effects_proportionate) {
					sideEffectsProportionate = (answers.side_effects_proportionate.noul ?? 1) >= 0.5;
				}
				if (answers.safer_existing_route_preferred) {
					saferExistingPreferred = (answers.safer_existing_route_preferred.noul ?? 0) >= 0.5;
				}
				if (answers.source_matches_requested_capability) {
					sourceMatchesCapability = (answers.source_matches_requested_capability.noul ?? 1) >= 0.5;
				}
			} catch {
				// Conservative fallback
			}
		}

		// FR-084 fail-closed: under a mandatory semantic plane, an absent or malformed decision cannot
		// become a direct allow. It routes to the safer alternative, or denies when none resolves.
		if (this.systemOneRequired && !semanticDecisionObserved) {
			const safeRoute = this.determineSafeRoute(request);
			const resolved = this.resolveRoute(safeRoute, request);
			if (resolved.command || resolved.requiresManualStep) {
				const record = this.createAndStoreRecord(
					request,
					digest,
					deterministicFindings,
					"rewrite_safe_route",
					safeRoute,
					certificateId,
				);
				return {
					disposition: "rewrite_safe_route",
					chosenRoute: safeRoute,
					resolvedRoute: resolved,
					record,
					summaryEvent: "Acquisition hardened · semantic decision unavailable under a mandatory plane",
					allowed: false,
					rewritten: true,
					denied: false,
				};
			}
			const record = this.createAndStoreRecord(request, digest, deterministicFindings, "deny", null, certificateId);
			return {
				disposition: "deny",
				record,
				summaryEvent: "Acquisition blocked · semantic decision unavailable and no safer route resolves",
				allowed: false,
				rewritten: false,
				denied: true,
			};
		}

		if (!acquisitionRequired || !sourceMatchesCapability) {
			const record = this.createAndStoreRecord(request, digest, deterministicFindings, "deny", null, certificateId);
			return {
				disposition: "deny",
				record,
				summaryEvent: "Acquisition blocked · acquisition not required or source mismatch for objective",
				allowed: false,
				rewritten: false,
				denied: true,
			};
		}

		if (!sideEffectsProportionate || saferExistingPreferred || hasRiskSignals) {
			const safeRoute = this.determineSafeRoute(request);
			const record = this.createAndStoreRecord(
				request,
				digest,
				deterministicFindings,
				"rewrite_safe_route",
				safeRoute,
				certificateId,
			);
			return {
				disposition: "rewrite_safe_route",
				chosenRoute: safeRoute,
				resolvedRoute: this.resolveRoute(safeRoute, request),
				record,
				summaryEvent: `Acquisition hardened · replaced mutable installer with ${safeRoute}`,
				allowed: false,
				rewritten: true,
				denied: false,
			};
		}

		// FR-089: Routine allow is silent
		const record = this.createAndStoreRecord(
			request,
			digest,
			deterministicFindings,
			"allow",
			"direct_verified",
			certificateId,
		);

		return {
			disposition: "allow",
			chosenRoute: "direct_verified",
			record,
			summaryEvent: undefined,
			allowed: true,
			rewritten: false,
			denied: false,
		};
	}

	private inspectDeterministic(request: AcquisitionRequest, text: string): DeterministicFinding[] {
		const findings: DeterministicFinding[] = [];

		// Credential / SSH / cloud key reads combined with network output
		if (
			/(?:id_rsa|\.aws\/credentials|\.ssh|AWS_SECRET|PRIVATE KEY)[\s\S]*?(?:curl|wget|nc|bash|sh|socat)/i.test(
				text,
			) ||
			/(?:curl|wget)[\s\S]*?(?:\$AWS_|\.ssh|\/etc\/shadow)/i.test(text)
		) {
			findings.push({
				id: "credential-exfiltration",
				level: "deny",
				message: "Credential or secret material access combined with network exfiltration.",
			});
		}

		// Reverse shells
		if (
			/bash\s+-i\s+>&/i.test(text) ||
			/\/dev\/tcp\/\d+/i.test(text) ||
			/nc(?:\.traditional)?\s+-[el]/i.test(text) ||
			/socat\s+exec/i.test(text)
		) {
			findings.push({
				id: "reverse-shell",
				level: "deny",
				message: "Reverse shell command pattern detected.",
			});
		}

		// TLS verification disabled
		if (/--insecure\b|-k\b|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/i.test(text)) {
			findings.push({
				id: "tls-verification-disabled",
				level: "deny",
				message: "TLS verification explicitly disabled in download command.",
			});
		}

		// Destructive filesystem / disk operations
		if (/\brm\s+-(?:rf|fr)\s+\/(?:\s|$)|mkfs\b|dd\s+if=\/dev\/zero\s+of=\/dev/i.test(text)) {
			findings.push({
				id: "destructive-filesystem-op",
				level: "deny",
				message: "Destructive root filesystem or disk overwrite detected.",
			});
		}

		// Security-control tampering
		if (/\bsetenforce\s+0\b|\biptables\s+-F\b|\bufw\s+disable\b/i.test(text)) {
			findings.push({
				id: "security-control-tampering",
				level: "deny",
				message: "Security control tampering or firewall disabling detected.",
			});
		}

		// Shell / environment hijacking
		if (/\bLD_PRELOAD\b|\/etc\/ld\.so\.preload\b/i.test(text)) {
			findings.push({
				id: "shell-env-hijacking",
				level: "deny",
				message: "Dynamic linker hijacking via LD_PRELOAD detected.",
			});
		}

		// Raw fetch to shell
		if (/(?:curl|wget)[^|\n]*\|\s*(?:bash|sh|zsh)/i.test(text)) {
			findings.push({
				id: "raw-fetch-to-shell",
				level: "deny",
				message: "Raw fetch-to-shell pipeline detected.",
			});
		}

		// Scheduled persistence
		if (/\bcrontab\b|\/etc\/cron/i.test(text)) {
			findings.push({
				id: "unauthorized-persistence",
				level: "deny",
				message: "Unauthorized scheduled persistence detected.",
			});
		}

		// Privileged install without policy verification
		if (/\bsudo\b|\bdoas\b/i.test(text)) {
			findings.push({
				id: "unverified-privilege-escalation",
				level: "deny",
				message: "Privilege escalation (sudo/doas) detected in automated script.",
			});
		}

		// Risk signals (warnings): mutable refs
		if (/@latest\b|:latest\b|#main\b|#master\b|:HEAD\b/i.test(text)) {
			findings.push({
				id: "mutable-ref-or-unpinned",
				level: "warn",
				message: "Mutable branch or latest tag reference detected without hash pin.",
			});
		}

		// Raw IP or URL shorteners
		if (/https?:\/\/(?:\d{1,3}\.){3}\d{1,3}|bit\.ly|tinyurl\.com/i.test(text)) {
			findings.push({
				id: "raw-ip-or-shortener",
				level: "warn",
				message: "Raw IP address or URL shortener download source.",
			});
		}

		// Missing checksum when downloading binaries
		if (/\.(?:tar\.gz|zip|bin|sh|exe)\b/i.test(request.source) && !request.checksum) {
			findings.push({
				id: "missing-checksum",
				level: "warn",
				message: "Downloadable archive or binary specified without verification checksum.",
			});
		}

		return findings;
	}

	/**
	 * Turns a route label into something the caller can actually carry out. A label with no command
	 * and no manual step is not a resolved route, and the gate treats that as a denial.
	 */
	private resolveRoute(route: string, request: AcquisitionRequest): ResolvedSafeRoute {
		if (this.resolveRouteFn) return this.resolveRouteFn(route, request);
		return resolveDefaultSafeRoute(route, request);
	}

	private determineSafeRoute(request: AcquisitionRequest): string {
		// 1. Existing installed capability
		if (request.capabilityId && this.availableCapabilities.has(request.capabilityId)) {
			return "existing_installed";
		}
		if (request.source.includes("npm") && this.installedPackages.has(request.source)) {
			return "existing_installed";
		}

		// 2. Pinned package / release
		if (/@latest\b|:latest\b|#main\b|#master\b/i.test(request.source)) {
			return "pinned_verified_release";
		}

		// 3. Inspected source
		if (request.source.startsWith("http://") || request.source.startsWith("https://")) {
			return "inspected_source";
		}

		// 4. Local minimal capability synthesis
		return "local_minimal_synthesis";
	}

	private createAndStoreRecord(
		request: AcquisitionRequest,
		digest: string,
		deterministicFindings: DeterministicFinding[],
		disposition: AcquisitionDisposition,
		chosenRoute: string | null,
		certificateId: string | null = null,
	): ExternalAcquisitionRecord {
		const record: ExternalAcquisitionRecord = {
			schema_version: "1.0",
			record_id: randomUUID(),
			objective_id: request.objectiveId,
			capability_id: request.capabilityId ?? null,
			source: request.source,
			revision: request.revision ?? null,
			digest,
			deterministic_findings: deterministicFindings,
			jev_certificate_id: certificateId,
			disposition,
			chosen_route: chosenRoute,
			created_at: new Date().toISOString(),
		};
		this.records.push(record);
		return record;
	}
}

/**
 * Default route resolution. Each route yields a command the caller can run instead, or an explicit
 * manual step; a route that yields neither is not usable and the gate denies rather than pretending
 * a label is a plan.
 */
export function resolveDefaultSafeRoute(route: string, request: AcquisitionRequest): ResolvedSafeRoute {
	switch (route) {
		case "existing_installed":
			return {
				route,
				rationale: `The capability '${request.capabilityId ?? request.source}' is already installed; use it instead of acquiring it again.`,
				requiresManualStep: false,
				...(request.capabilityId ? { command: `# use already-installed ${request.capabilityId}` } : {}),
			};
		case "pinned_verified_release": {
			const pinned = pinMutableReference(request.command ?? request.source);
			return {
				route,
				...(pinned ? { command: pinned } : {}),
				rationale:
					"The request names a mutable reference. Re-run it against an exact pinned version so the bytes acquired are the bytes reviewed.",
				requiresManualStep: pinned === undefined,
			};
		}
		case "inspected_source": {
			const target = extractDownloadTarget(request.command ?? request.source);
			return {
				route,
				...(target
					? {
							command: `curl --fail --proto '=https' --tlsv1.2 -sSLo acquired-source ${target} && sha256sum acquired-source`,
						}
					: {}),
				rationale:
					"Download to disk and take its digest first, so the content is inspectable and pinned before anything executes it.",
				requiresManualStep: target === undefined,
			};
		}
		default:
			return {
				route: "local_minimal_synthesis",
				rationale:
					"No safe external route resolves. Build the minimal local capability that satisfies the need instead of acquiring an external one.",
				requiresManualStep: true,
			};
	}
}

/** Rewrites a mutable reference (`@latest`, `#main`) into an explicit pin placeholder. */
function pinMutableReference(text: string): string | undefined {
	if (!/@latest\b|:latest\b|#main\b|#master\b|:HEAD\b/i.test(text)) return undefined;
	return text
		.replace(/@latest\b/gi, "@<exact-version>")
		.replace(/:latest\b/gi, ":<exact-tag>")
		.replace(/#(?:main|master)\b/gi, "#<exact-commit-sha>")
		.replace(/:HEAD\b/g, ":<exact-commit-sha>");
}

/** The first https URL a command or source names. */
function extractDownloadTarget(text: string): string | undefined {
	return /https:\/\/[^\s'"|;]+/i.exec(text)?.[0];
}
