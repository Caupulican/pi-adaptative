const MIN_CHARS_PER_TOKEN = 2.2;
const MAX_CHARS_PER_TOKEN = 6;
const DEFAULT_CHARS_PER_TOKEN = 4;

export class TokenBudget {
	private _ratio = DEFAULT_CHARS_PER_TOKEN;
	private _anchorTokens = 0;
	private _hasAnchor = false;
	private _recentAbsError = 0;
	private _sampleCount = 0;

	get ratio(): number {
		return this._ratio;
	}

	anchor(inputTokens: number, coveredChars: number): void {
		if (!Number.isFinite(inputTokens) || !Number.isFinite(coveredChars) || inputTokens <= 0 || coveredChars <= 0) {
			return;
		}

		const observedRatio = clampRatio(coveredChars / inputTokens);
		if (this._hasAnchor) {
			const previousEstimate = this.estimateDelta(coveredChars);
			const absError = Math.abs(previousEstimate - inputTokens);
			this._recentAbsError = this._sampleCount === 0 ? absError : this._recentAbsError * 0.5 + absError * 0.5;
			this._ratio = clampRatio(this._ratio + (observedRatio - this._ratio) * 0.5);
			this._sampleCount += 1;
		} else {
			this._ratio = observedRatio;
			this._recentAbsError = 0;
			this._sampleCount = 1;
			this._hasAnchor = true;
		}

		this._anchorTokens = Math.ceil(inputTokens);
	}

	estimateDelta(chars: number): number {
		if (!Number.isFinite(chars) || chars <= 0) {
			return 0;
		}
		return Math.ceil(chars / this._ratio);
	}

	current(deltaChars: number, window: number): number {
		const delta = this.estimateDelta(deltaChars);
		if (!this._hasAnchor) {
			return delta;
		}

		const marginByWindow = Number.isFinite(window) && window > 0 ? Math.ceil(0.02 * window) : 0;
		const marginByError = Math.ceil(2 * this._recentAbsError);
		return this._anchorTokens + delta + Math.max(marginByWindow, marginByError);
	}
}

function clampRatio(ratio: number): number {
	return Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, ratio));
}
