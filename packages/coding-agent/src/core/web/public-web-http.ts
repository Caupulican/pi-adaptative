import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import * as HttpClient from "@effect/platform/HttpClient";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { PublicWebOperations } from "./public-web-client.ts";

/** A scoped Effect HTTP service: one pinned native connection on both Node and Bun. */
export const requestPublicWeb: PublicWebOperations["request"] = async ({ url, address, headers, signal }) => {
	signal.throwIfAborted();
	const scope = Effect.runSync(Scope.make());
	let body: ReadableStream<Uint8Array> | undefined;
	let closing: Promise<void> | undefined;
	const close = () => {
		closing ??= (async () => {
			signal.removeEventListener("abort", abort);
			// Abort the request and destroy its agents even if the consumer holds a reader lock.
			await Effect.runPromise(Scope.close(scope, Exit.void));
			await body?.cancel().catch(() => {});
		})();
		return closing;
	};
	const abort = () => void close().catch(() => {});
	signal.addEventListener("abort", abort, { once: true });
	try {
		const request = Effect.gen(function* () {
			const agent = yield* NodeHttpClient.makeAgent({
				keepAlive: false,
				maxSockets: 1,
				rejectUnauthorized: true,
				// Explicit agents never inherit environment proxy routing. Bun's native fetch does,
				// even with proxy:"" or an isolated worker env, so it cannot implement this port.
				proxyEnv: {},
				lookup: (_hostname, options, callback) => {
					if (options.all) callback(null, [address]);
					else callback(null, address.address, address.family);
				},
			});
			const client = yield* NodeHttpClient.make.pipe(Effect.provideService(NodeHttpClient.HttpAgent, agent));
			// No followRedirects combinator: PublicWebClient admits each hop before any I/O.
			return yield* HttpClient.withScope(client).get(url, {
				headers: { ...headers, Host: url.host, "Accept-Encoding": "gzip, deflate, br" },
			});
		}).pipe(Effect.provideService(Scope.Scope, scope));
		const result = await Effect.runPromise(Effect.either(request), { signal });
		if (result._tag === "Left") throw result.left.cause ?? result.left;
		signal.throwIfAborted();
		const response = result.right;
		let decoded: Stream.Stream<Uint8Array, unknown> = response.stream;
		// Decode in reverse application order. The authoritative byte limit is applied to the
		// resulting stream by PublicWebClient, including compressed expansion beyond that limit.
		const encodings = (response.headers["content-encoding"] ?? "").toLowerCase().split(",").reverse();
		for (const value of encodings) {
			const encoding = value.trim();
			if (!encoding || encoding === "identity") continue;
			const decompress =
				encoding === "gzip"
					? createGunzip
					: encoding === "deflate"
						? createInflate
						: encoding === "br"
							? createBrotliDecompress
							: undefined;
			if (!decompress) throw new Error(`Unsupported content encoding: ${encoding}`);
			decoded = NodeStream.pipeThroughDuplex(
				decoded,
				() => decompress(),
				(error) => error,
			);
		}
		body = Stream.toReadableStream(decoded);
		return { response: { status: response.status, headers: new Headers(response.headers), body }, close };
	} catch (error) {
		await close().catch(() => {});
		throw error;
	}
};
