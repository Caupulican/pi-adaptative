import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import * as Effect from "effect/Effect";
import ipaddr from "ipaddr.js";
import { Agent, fetch } from "undici";

export const MAX_WEB_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_WEB_TIMEOUT_SECONDS = 120;
const MAX_REDIRECTS = 5;
const BROWSER_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const PI_USER_AGENT = "Pi-Adaptative-WebFetch";

export interface WebResponse {
	status: number;
	headers: { get(name: string): string | null };
	body: ReadableStream<Uint8Array> | null;
}

export interface PublicWebOperations {
	lookup(hostname: string): Promise<readonly { address: string; family: number }[]>;
	/** Connect only to address, preserving the URL hostname for Host and TLS verification. */
	request(input: {
		url: URL;
		address: { address: string; family: number };
		headers: Record<string, string>;
		signal: AbortSignal;
	}): Promise<{ response: WebResponse; close(): Promise<void> }>;
}

const nativeOperations: PublicWebOperations = {
	lookup: (hostname) => lookup(hostname, { all: true }),
	async request({ url, address, headers, signal }) {
		// A dedicated dispatcher prevents environment proxies or a second DNS lookup from bypassing
		// the public-address decision. Provider traffic keeps its independent proxy configuration.
		const dispatcher = new Agent({
			connections: 1,
			connect: {
				autoSelectFamily: false,
				lookup: (_hostname, options, callback) => {
					if (options.all) callback(null, [address]);
					else callback(null, address.address, address.family);
				},
			},
		});
		try {
			const response = await fetch(url, { dispatcher, headers, signal, redirect: "manual", credentials: "omit" });
			return { response, close: () => dispatcher.destroy() };
		} catch (error) {
			await dispatcher.destroy();
			throw error;
		}
	},
};

function publicUrl(input: string): URL {
	if (input.length > 8192) throw new Error("URL exceeds 8192 characters");
	const url = new URL(input);
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("URL must use HTTP or HTTPS");
	if (url.username || url.password) throw new Error("URL credentials are not permitted");
	url.hash = "";
	return url;
}

function assertPublicAddress(address: string): void {
	const parsed = isIP(address) ? ipaddr.process(address) : undefined;
	// ipaddr's default "unicast" also includes unallocated IPv6 space. Restrict IPv6 to
	// the global-unicast allocation in addition to excluding its special-purpose subranges.
	if (
		!parsed ||
		parsed.range() !== "unicast" ||
		(parsed.kind() === "ipv6" && (parsed.toByteArray()[0] & 0xe0) !== 0x20)
	) {
		throw new Error("WebFetch permits public Internet addresses only");
	}
}

/** DNS cannot be canceled on every platform. Detach promptly, consuming late settlement safely. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

async function collectResponse(response: WebResponse, signal: AbortSignal): Promise<Uint8Array> {
	const declared = response.headers.get("content-length");
	if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_WEB_RESPONSE_BYTES) {
		throw new Error("Response too large (5 MiB maximum)");
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	let body = Buffer.allocUnsafe(64 * 1024);
	let length = 0;
	try {
		while (true) {
			const chunk = await untilAborted(reader.read(), signal);
			if (chunk.done) return body.subarray(0, length);
			const next = length + chunk.value.byteLength;
			if (next > MAX_WEB_RESPONSE_BYTES) throw new Error("Response too large (5 MiB maximum)");
			if (next > body.byteLength) {
				const grown = Buffer.allocUnsafe(Math.min(MAX_WEB_RESPONSE_BYTES, Math.max(next, body.byteLength * 2)));
				body.copy(grown, 0, 0, length);
				body = grown;
			}
			body.set(chunk.value, length);
			length = next;
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export interface FetchedWebContent {
	url: string;
	contentType: string;
	text: string;
	bytes: number;
}

/** One deadline, public-address admission and streamed byte bound across the entire redirect chain. */
export class PublicWebClient {
	private readonly operations: PublicWebOperations;
	constructor(operations: PublicWebOperations = nativeOperations) {
		this.operations = operations;
	}

	async get(input: string, accept: string, timeout = 30, parentSignal?: AbortSignal): Promise<FetchedWebContent> {
		if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_WEB_TIMEOUT_SECONDS) {
			throw new Error(`Timeout must be greater than 0 and at most ${MAX_WEB_TIMEOUT_SECONDS} seconds`);
		}
		parentSignal?.throwIfAborted();
		const operation = Effect.acquireUseRelease(
			Effect.sync(() => {
				const controller = new AbortController();
				return { controller, result: this.fetchChain(input, accept, controller.signal) };
			}),
			({ result }) => Effect.tryPromise({ try: () => result, catch: (error) => error }),
			({ controller, result }) =>
				Effect.promise(async () => {
					controller.abort();
					// Interruption is not complete until the HTTP adapter and reader have released.
					await result.catch(() => {});
				}),
		).pipe(
			Effect.timeoutFail({ duration: timeout * 1000, onTimeout: () => new Error("WebFetch request timed out") }),
		);
		const result = await Effect.runPromise(Effect.either(operation), { signal: parentSignal });
		if (result._tag === "Left") throw result.left;
		return result.right;
	}

	private async fetchChain(input: string, accept: string, signal: AbortSignal): Promise<FetchedWebContent> {
		let url = publicUrl(input);
		const visited = new Set<string>();
		let redirects = 0;
		let challengeRetried = false;
		let retryingCurrentUrl = false;
		while (true) {
			signal.throwIfAborted();
			if (redirects > MAX_REDIRECTS || (!retryingCurrentUrl && visited.has(url.href)))
				throw new Error("Redirect limit or loop detected");
			retryingCurrentUrl = false;
			visited.add(url.href);
			const hostname = url.hostname.replace(/^\[|\]$/g, "");
			const family = isIP(hostname);
			const addresses = family
				? [{ address: hostname, family }]
				: await untilAborted(this.operations.lookup(hostname), signal);
			if (addresses.length === 0) throw new Error("DNS returned no addresses");
			for (const address of addresses) assertPublicAddress(address.address);
			signal.throwIfAborted();
			const { response, close } = await this.operations.request({
				url,
				address: addresses[0],
				signal,
				headers: {
					"User-Agent": challengeRetried ? PI_USER_AGENT : BROWSER_USER_AGENT,
					Accept: accept,
					"Accept-Language": "en-US,en;q=0.9",
				},
			});
			try {
				if (!challengeRetried && response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
					challengeRetried = true;
					retryingCurrentUrl = true;
					continue;
				}
				if ([301, 302, 303, 307, 308].includes(response.status)) {
					const location = response.headers.get("location");
					if (!location) throw new Error("Redirect has no Location header");
					const next = publicUrl(new URL(location, url).href);
					if (url.protocol === "https:" && next.protocol !== "https:")
						throw new Error("HTTPS downgrade redirect denied");
					url = next;
					redirects++;
					continue;
				}
				if (response.status < 200 || response.status >= 300)
					throw new Error(`HTTP ${response.status} fetching ${url.href}`);
				const contentType = response.headers.get("content-type") ?? "";
				const mime = contentType.split(";", 1)[0].trim().toLowerCase();
				if (
					mime &&
					!mime.startsWith("text/") &&
					!/^application\/(json|xml|javascript|x-javascript|[\w.+-]+\+(json|xml))$/.test(mime)
				) {
					throw new Error(`Unsupported fetched content type: ${mime}`);
				}
				const bytes = await collectResponse(response, signal);
				signal.throwIfAborted();
				const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(contentType)?.[1] ?? "utf-8";
				return {
					url: url.href,
					contentType: mime,
					text: new TextDecoder(charset).decode(bytes),
					bytes: bytes.byteLength,
				};
			} finally {
				await response.body?.cancel().catch(() => {});
				await close();
			}
		}
	}
}
