/**
 * The Brazilian Portuguese words the terminal library draws itself: the same entries in the same order as the English
 * file the interface is typed by. A settings list, a select list, the loader, an alert title and an image's fallback line
 * are the library's own words, so they are set on the library when the language changes.
 */

import type { InterfaceText } from "../interface-text.ts";

export const LIBRARY = {
	noSettingsAvailable: "Nenhuma configuração disponível",
	noMatchingSettings: "Nenhuma configuração encontrada",
	noMatchingCommands: "Nenhum comando encontrado",
	settingsHint: (searchable: boolean) =>
		searchable
			? "Digite para buscar · Enter/Espaço para alterar · Esc para cancelar"
			: "Enter/Espaço para alterar · Esc para cancelar",
	loading: "Carregando...",
	scrollBorder: (direction: "↑" | "↓", hiddenLines: number) => `─── ${direction} mais ${hiddenLines} `,
	alert: {
		note: "Nota",
		tip: "Dica",
		important: "Importante",
		warning: "Aviso",
		caution: "Cuidado",
	},
	imageFallback: (details: string) => `[Imagem: ${details}]`,
} satisfies InterfaceText["library"];
