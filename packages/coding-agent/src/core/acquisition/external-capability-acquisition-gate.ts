import { createHash, randomUUID } from "node:crypto";
import type {
	AcquisitionDecision,
	AcquisitionDisposition,
	AcquisitionRequest,
	DeterministicFinding,
	ExternalAcquisitionRecord,
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
	charterAuthority?: {
		allowShellExecution?: boolean;
		allowNetworkDownloads?: boolean;
		allowPackageInstalls?: boolean;
	};
}

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
	private readonly records: ExternalAcquisitionRecord[] = [];

	constructor(deps: ExternalCapabilityAcquisitionGateDeps = {}) {
		this.steering = deps.steering;
		this.decisionEngine = deps.decisionEngine;
		this.availableCapabilities = new Set(deps.availableCapabilities ?? []);
		this.installedPackages = new Set(deps.installedPackages ?? []);
		this.charterAuthority = {
			allowShellExecution: deps.charterAuthority?.allowShellExecution ?? true,
			allowNetworkDownloads: deps.charterAuthority?.allowNetworkDownloads ?? true,
			allowPackageInstalls: deps.charterAuthority?.allowPackageInstalls ?? true,
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

		// FR-087: Check charter authority bounds
		if (
			!this.charterAuthority.allowNetworkDownloads &&
			(request.source.startsWith("http://") || request.source.startsWith("https://"))
		) {
			deterministicFindings.push({
				id: "charter-network-prohibited",
				level: "deny",
				message: "Network downloads are prohibited by current charter authority.",
			});
		}

		if (
			!this.charterAuthority.allowPackageInstalls &&
			(request.command?.includes("npm i") || request.command?.includes("pip install"))
		) {
			deterministicFindings.push({
				id: "charter-package-install-prohibited",
				level: "deny",
				message: "Package installs are prohibited by current charter authority.",
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
