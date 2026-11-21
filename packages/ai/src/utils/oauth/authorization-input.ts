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

export function parseAuthorizationInput(input: string, expectedCallback?: string): AuthorizationInput {
	const value = input
		.trim()
		.replace(/^['"]+|['"]+$/g, "")
		.trim();
	if (!value) return {};

	function fromQuery(params: URLSearchParams): AuthorizationInput {
		if (
			expectedCallback &&
			(params.has("error") ||
				params.getAll("code").length !== 1 ||
				params.getAll("state").length !== 1 ||
				!params.get("state"))
		)
			return {};
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}

	try {
		const url = new URL(value);
		if (
			expectedCallback &&
			(url.origin + url.pathname !== expectedCallback || url.username || url.password || url.hash)
		)
			return {};
		return fromQuery(url.searchParams);
	} catch {
		// Manual input may be a compact code/state pair or query-string fragment.
	}

	if (expectedCallback && (value.startsWith("?") || /^(?:error|code|state)=/.test(value))) {
		return value.includes("#") ? {} : fromQuery(new URLSearchParams(value));
	}
	// A relative or malformed callback must not fall through to manual code parsing.
	if (expectedCallback && (value.startsWith("//") || /[?&\s]/.test(value))) return {};

	if (value.includes("#")) {
		const [code, state, extra] = value.split("#", 3);
		if (expectedCallback && (!state || extra !== undefined)) return {};
		return { code, state };
	}

	if (!expectedCallback && value.includes("code=")) return fromQuery(new URLSearchParams(value));

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
