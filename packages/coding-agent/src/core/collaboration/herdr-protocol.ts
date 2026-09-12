/** Exact supported Herdr collaboration protocol versions. */
export const HERDR_SUPPORTED_PROTOCOL_VERSIONS = [20, 22] as const;

export type HerdrSupportedProtocolVersion = (typeof HERDR_SUPPORTED_PROTOCOL_VERSIONS)[number];

/** Verifies that a Herdr server ping response exposes a supported protocol version (20 or 22). */
export function isSupportedHerdrProtocol(reply: unknown): boolean {
	if (typeof reply !== "object" || reply === null || !("protocol" in reply)) {
		return false;
	}
	const protocol = (reply as { protocol: unknown }).protocol;
	return (
		typeof protocol === "number" &&
		HERDR_SUPPORTED_PROTOCOL_VERSIONS.includes(protocol as HerdrSupportedProtocolVersion)
	);
}
