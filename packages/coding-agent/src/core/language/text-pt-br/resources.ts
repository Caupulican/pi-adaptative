/**
 * As palavras em português do Brasil dos comandos de recurso e da visão de recursos carregados: `/install-resources`,
 * `/curate`, as linhas do host para bash e compactação, os rótulos de escopo pelos quais uma listagem agrupa, os
 * diagnósticos que ela imprime e os títulos de seção da listagem de início. O escopo mantém o identificador (é ele que
 * decide em que grupo um item cai) e tira o rótulo daqui.
 */

import type { InterfaceText } from "../interface-text.ts";

export const RESOURCES = {
	install: {
		usage: "Uso: /install-resources <dir> [--force]",
		missingDir: (dir: string) => `A pasta de origem não existe: ${dir}`,
		trustTitle: "Confiar na origem externa para instalar?",
		trustDescription: (dir: string) =>
			`A pasta "${dir}" tem extensões e recursos para instalar. Extensões podem executar código arbitrário na sua máquina. Confiar nela?`,
		trustAccept: "Confiar nesta pasta e seguir com a instalação.",
		trustReject: "Não confiar nesta pasta. Cancelar a instalação.",
		aborted: "Instalação cancelada. A pasta de origem não foi considerada confiável.",
		complete: (installed: number, skipped: number) =>
			`Instalação concluída: ${installed} recursos instalados, ${skipped} ignorados.`,
	},
	curate: {
		archived: (name: string) => `Skill promovida '${name}' arquivada`,
		archiveFailed: (name: string) => `Não foi possível arquivar '${name}' (não é uma skill promovida?)`,
		restored: (name: string) => `Skill '${name}' restaurada`,
		restoreFailed: (name: string) => `Não foi possível restaurar '${name}'`,
		empty: "Curador: nenhuma skill promovida antiga ou sobreposta. Nada a propor.",
		header: "Propostas do curador de skills (nada é aplicado automaticamente):",
		archiveProposal: (name: string, reason: string) =>
			`  • arquivar '${name}': ${reason}  →  /curate archive ${name}`,
		mergeProposal: (first: string, second: string, overlapPercent: number) =>
			`  • considere juntar '${first}' + '${second}' (sobreposição de ${overlapPercent}%)`,
	},
	bash: {
		failed: (error: string) => `O comando bash falhou: ${error}`,
		unknownError: "Erro desconhecido",
	},
	compact: {
		nothing: "Nada para compactar (nenhuma mensagem ainda)",
	},
	scope: {
		user: "usuário",
		project: "projeto",
		path: "caminho",
		temp: "temporário",
	},
	diagnostics: {
		collision: (name: string) => `  conflito de "${name}":`,
		skipped: "(ignorado)",
	},
	loaded: {
		context: "Contexto",
		skills: "Skills",
		prompts: "Prompts",
		extensions: "Extensões",
		themes: "Temas",
		skillConflicts: "Conflitos de skill",
		promptConflicts: "Conflitos de prompt",
		extensionIssues: "Problemas de extensão",
		themeConflicts: "Conflitos de tema",
		commandConflictSkipped: (name: string) =>
			`O comando de extensão '/${name}' conflita com um comando interativo embutido. Ignorado no autocompletar.`,
		commandConflictAvailable: (name: string, invocationName: string) =>
			`O comando de extensão '/${name}' conflita com um comando interativo embutido. Disponível como '/${invocationName}'.`,
	},
} satisfies InterfaceText["resources"];
