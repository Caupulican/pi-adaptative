import type { InteractiveAuthRecoveryHandler } from "@caupulican/pi-ai";
import { stripAnsi } from "../utils/ansi.ts";
import { type ExecResult, execCommand } from "./exec.ts";
import { isWorkerSession } from "./session-role.ts";

const LOGIN_TIMEOUT_MS = 15 * 60_000;
const LOGIN_OUTPUT_LIMIT = 32 * 1024;
const ERROR_DETAIL_LIMIT = 512;
const activeLogins = new Map<string, Promise<void>>();

type ExecuteCommand = typeof execCommand;

export interface BedrockSsoLoginOptions {
	signal?: AbortSignal;
	execute?: ExecuteCommand;
	isWorker?: () => boolean;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
}

function validateProfile(profile: string): string {
	const normalized = profile.trim();
	if (!normalized) throw new Error("AWS profile name is required");
	if (normalized.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)) {
		throw new Error("AWS profile name contains unsupported characters");
	}
	return normalized;
}

function compactOutputDetail(result: ExecResult): string | undefined {
	const raw = result.stderr.trim() || result.stdout.trim();
	if (!raw) return undefined;
	const withoutAnsi = stripAnsi(raw);
	const lines = withoutAnsi
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const detail = lines.at(-1);
	if (!detail) return undefined;
	return detail.length <= ERROR_DETAIL_LIMIT ? detail : `${detail.slice(0, ERROR_DETAIL_LIMIT - 1)}…`;
}

async function executeLogin(profile: string, options: BedrockSsoLoginOptions): Promise<void> {
	const execute = options.execute ?? execCommand;
	const result = await execute("aws", ["sso", "login", "--profile", profile], options.cwd ?? process.cwd(), {
		signal: options.signal,
		timeout: LOGIN_TIMEOUT_MS,
		env: options.env ?? process.env,
		maxBuffer: LOGIN_OUTPUT_LIMIT,
	});
	if (result.errorMessage) {
		const detail = result.errorMessage.slice(0, ERROR_DETAIL_LIMIT);
		throw new Error(`AWS CLI v2 is required for managed SSO login: ${detail}`);
	}
	if (result.killed) {
		throw new Error(options.signal?.aborted ? "AWS SSO login was cancelled" : "AWS SSO login timed out");
	}
	if (result.code !== 0) {
		const detail = compactOutputDetail(result) ?? `aws exited with code ${result.code}`;
		throw new Error(`AWS SSO login failed for profile "${profile}": ${detail}`);
	}
}

function waitForSharedLogin(login: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) return login;
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (settle: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			settle();
		};
		const onAbort = () => finish(() => reject(new Error("AWS SSO login was cancelled")));
		signal.addEventListener("abort", onAbort, { once: true });
		void login.then(
			() => finish(resolve),
			(error: unknown) => finish(() => reject(error)),
		);
		if (signal.aborted) onAbort();
	});
}

/** Run one foreground AWS SSO login per profile; concurrent callers share its terminal result. */
export async function loginBedrockSsoProfile(profile: string, options: BedrockSsoLoginOptions = {}): Promise<void> {
	const normalized = validateProfile(profile);
	if ((options.isWorker ?? isWorkerSession)()) {
		throw new Error(
			`AWS SSO authentication for profile "${normalized}" requires a user session; run /login amazon-bedrock in the owning user session.`,
		);
	}
	if (options.signal?.aborted) throw new Error("AWS SSO login was cancelled");

	const existing = activeLogins.get(normalized);
	if (existing) return waitForSharedLogin(existing, options.signal);
	const login = executeLogin(normalized, options);
	activeLogins.set(normalized, login);
	try {
		await login;
	} finally {
		if (activeLogins.get(normalized) === login) activeLogins.delete(normalized);
	}
}

/** Restore one request-owned Bedrock SSO session after the provider identifies explicit expiry. */
export const recoverBedrockSsoAuthentication: InteractiveAuthRecoveryHandler = async (request) => {
	await loginBedrockSsoProfile(request.profile, {
		...(request.signal ? { signal: request.signal } : {}),
	});
	return true;
};
