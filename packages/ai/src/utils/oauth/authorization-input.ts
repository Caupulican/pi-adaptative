export interface AuthorizationInput {
	code?: string;
	state?: string;
}

export interface AuthorizationRaceResult extends AuthorizationInput {
	source: "callback" | "manual";
}

export interface AuthorizationRaceOptions {
	manualInput: () => Promise<string>;
	waitForCallback: () => Promise<AuthorizationInput | null>;
	cancelWait: () => void;
	expectedState: string;
	stateMismatchMessage: string;
	normalizeState?: (state: string) => string;
}

/** Stop waiting for host input on cancellation without allowing a late result to resume login. */
export async function awaitAuthorizationInput<T>(input: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	let onAbort: (() => void) | undefined;
	try {
		const cancelled = new Promise<never>((_, reject) => {
			onAbort = () => reject(signal?.reason ?? new Error("OAuth login cancelled"));
			signal?.addEventListener("abort", onAbort, { once: true });
		});
		const result = await Promise.race([cancelled, input()]);
		signal?.throwIfAborted();
		return result;
	} finally {
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

export function parseAuthorizationInput(input: string): AuthorizationInput {
	const value = input
		.trim()
		.replace(/^['"]+|['"]+$/g, "")
		.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Manual input may be a compact code/state pair or query-string fragment.
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

/** Race one manual-input promise against a callback server without leaking either rejection path. */
export async function raceAuthorizationInput(
	options: AuthorizationRaceOptions,
): Promise<AuthorizationRaceResult | undefined> {
	let manualInput: string | undefined;
	let manualError: Error | undefined;
	const manualPromise = Promise.resolve()
		.then(options.manualInput)
		.then((input) => {
			manualInput = input;
			options.cancelWait();
		})
		.catch((error: unknown) => {
			manualError = error instanceof Error ? error : new Error(String(error));
			options.cancelWait();
		});

	const callback = await options.waitForCallback();
	if (manualError) throw manualError;
	if (callback?.code) {
		assertExpectedState(callback, options);
		return { source: "callback", ...callback };
	}

	await manualPromise;
	if (manualError) throw manualError;
	if (!manualInput) return undefined;
	const parsed = parseAuthorizationInput(manualInput);
	assertExpectedState(parsed, options);
	return parsed.code ? { source: "manual", ...parsed } : undefined;
}

function assertExpectedState(input: AuthorizationInput, options: AuthorizationRaceOptions): void {
	if (!input.state) return;
	const state = options.normalizeState ? options.normalizeState(input.state) : input.state;
	if (state !== options.expectedState) throw new Error(options.stateMismatchMessage);
}
