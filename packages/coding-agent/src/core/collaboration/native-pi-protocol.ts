/** Presentation metadata is visible only while Herdr selects this exact native hook source. */
export const NATIVE_PI_SOURCE_PREFIX = "pi:collaboration:";
export const NATIVE_PI_SOURCE_PATTERN = new RegExp(
	`^${NATIVE_PI_SOURCE_PREFIX}[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$`,
);
