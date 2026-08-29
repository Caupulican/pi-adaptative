/**
 * Provider prefix-cache stability policy for the send-time passes that rewrite history.
 *
 * Every provider request re-sends the whole conversation, and the provider bills and prefills it
 * against the longest byte-identical prefix it has already seen. A pass that rewrites a message
 * IN PLACE — context GC packing a stale tool result into a stub, prompt enforcement stubbing an
 * evicted one — moves bytes at that message's position, so the provider must re-prefill everything
 * from there to the end of the request.
 *
 * Both passes decide what to rewrite from a boundary of the form `messages.length - preserveRecent`.
 * That boundary advances by one position per appended message, so on a naive reading exactly the
 * messages crossing it flip spelling EVERY turn, and the tail of the conversation is re-prefilled
 * every single request for the life of the session.
 *
 * The fix is to quantize the boundary onto a fixed grid so it advances in strides instead of
 * continuously: between two grid points no message changes its spelling, the prefix stays
 * byte-identical, and the rewrites land batched at one grid crossing instead of dribbling out one
 * per turn. The same total work happens; it just stops invalidating the cache on every request.
 */

/**
 * Floor `rawBoundary` onto a `stride`-sized grid anchored at the conversation start.
 *
 * Monotone in `rawBoundary` (a message never un-packs while history only grows) and never above it
 * (a quantized boundary preserves at least as much recent context as the raw one, never less).
 * `stride <= 1` returns the raw boundary, so a caller that has opted out — or whose window is too
 * small for a grid to mean anything — keeps continuous behavior.
 */
export function quantizeRecentBoundary(rawBoundary: number, stride: number): number {
	if (!Number.isFinite(rawBoundary) || rawBoundary <= 0) return Math.max(0, rawBoundary);
	if (!Number.isFinite(stride) || stride <= 1) return rawBoundary;
	const grid = Math.floor(stride);
	return Math.floor(rawBoundary / grid) * grid;
}

/**
 * The grid a `preserveRecent`-sized window advances on. Defaults to half the window, so the
 * boundary moves a few times per window instead of once per message, and a window too small for
 * halving to mean anything keeps continuous behavior.
 *
 * A `configured` stride is clamped to the window it quantizes. The grid is what the boundary LAGS
 * by, so a stride coarser than the window would more than double the effectively preserved
 * context — and settings objects are routinely spread and then partially overridden
 * (`{...getContextGcSettings(), preserveRecentMessages: 1}`), which would otherwise apply a stride
 * derived from the default window to a much smaller one. Clamping bounds the lag: quantization
 * never preserves more than twice the configured window.
 */
export function resolveRecentBoundaryStride(preserveRecent: number, configured?: number): number {
	if (!Number.isFinite(preserveRecent) || preserveRecent <= 0) return 1;
	const window = Math.floor(preserveRecent);
	const requested = Number.isFinite(configured) && configured !== undefined ? Math.floor(configured) : window / 2;
	return Math.min(Math.max(1, Math.floor(requested)), Math.max(1, window));
}
