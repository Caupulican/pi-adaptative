declare module "highlight.js/lib/core.js" {
	interface HighlightResult {
		value: string;
	}

	interface HighlightOptions {
		language: string;
		ignoreIllegals?: boolean;
	}

	type LanguageFn = (hljs: HighlightJs) => unknown;

	interface HighlightJs {
		highlight(code: string, options: HighlightOptions): HighlightResult;
		highlightAuto(code: string, languageSubset?: string[]): HighlightResult;
		getLanguage(name: string): unknown;
		registerLanguage(name: string, language: LanguageFn): void;
	}

	const hljs: HighlightJs;
	export default hljs;
}

declare module "highlight.js/lib/languages/*" {
	type LanguageFn = (hljs: unknown) => unknown;
	const language: LanguageFn;
	export default language;
}
