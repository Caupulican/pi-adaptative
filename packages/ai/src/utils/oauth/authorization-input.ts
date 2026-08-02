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
}

export function parseAuthorizationInput(input: string): AuthorizationInput {
	const value = input.trim();
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
		assertExpectedState(callback, options.expectedState, options.stateMismatchMessage);
		return { source: "callback", ...callback };
	}

	await manualPromise;
	if (manualError) throw manualError;
	if (!manualInput) return undefined;
	const parsed = parseAuthorizationInput(manualInput);
	assertExpectedState(parsed, options.expectedState, options.stateMismatchMessage);
	return parsed.code ? { source: "manual", ...parsed } : undefined;
}

function assertExpectedState(input: AuthorizationInput, expectedState: string, message: string): void {
	if (input.state && input.state !== expectedState) throw new Error(message);
}
