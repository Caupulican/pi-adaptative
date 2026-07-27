const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Shared loopback classification for local execution, routing, and cache-warm decisions. */
export function isLoopbackModelEndpoint(baseUrl: string): boolean {
	try {
		return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
	} catch {
		return false;
	}
}
