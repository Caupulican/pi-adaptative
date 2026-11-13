/**
 * The Brazilian Portuguese words of the slash command controller and the start-up checks: the reload notice and its
 * refusals, the owner-facing refusals and notices of the commands it routes, and the update and trust notices the
 * terminal shows when the session begins. Command names and their arguments stay exactly as the commands take them.
 */

import type { InterfaceText } from "../interface-text.ts";

export const COMMAND_CONTROLLER = {
	commands: {
		secretsNeedsTerminal: "/secrets precisa de um terminal interativo controlado pelo dono.",
		reloadWaitingForResponse: "Espere a resposta atual terminar antes de recarregar.",
		reloadWaitingForCompaction: "Espere a compactação terminar antes de recarregar.",
		reloading: "Recarregando atalhos, extensões, skills, prompts e temas...",
		reloaded: "Atalhos, extensões, skills, prompts e temas recarregados",
		modelsJsonError: (error: string) => `Erro no models.json: ${error}`,
		reloadFailed: (error: string) => `A recarga falhou: ${error}`,
		extensionRefreshFailed: (error: string) => `A atualização das extensões falhou: ${error}`,
		goalContinueUsage: "Uso: /goal-continue [maxTurns 0=unbounded] [maxStallTurns 0-100] [maxMinutes 0-1440]",
		editGoalObjective: "Editar o objetivo",
		selfCompactionRefused: (reason: string) => `Autocompactação: ${reason}.`,
		selfCompactionResumed: (chars: string) => `Autocompactação: compactando com a nota salva (${chars} caracteres).`,
		selfCompactionAsked: "Autocompactação: o agente foi instruído a escrever a nota e compactar.",
		selfCompactionFailed: (error: string) => `A autocompactação falhou: ${error}`,
		newSessionNamed: (name: string) => `✓ Nova sessão iniciada: ${name}`,
		newSession: "✓ Nova sessão iniciada",
		createSessionFailed: "Falha ao criar a sessão",
	},
	startup: {
		selfUpdated: (version: string) =>
			`Atualizado para ${version}. Esta sessão continua na versão anterior até você iniciar o Pi de novo.`,
		updated: (version: string, command: string) =>
			`Atualizado para a v${version}. Use ${command} para ver o changelog completo.`,
		trustWarning:
			"Esta pasta de projeto não é confiável. As instruções do projeto (AGENTS.md/CLAUDE.md/GEMINI.md), os recursos de .pi e os pacotes do projeto são ignorados. Use /trust para confiar nela.",
		updateAvailable: "Atualização disponível",
		newVersion: (name: string, version: string) => `A versão ${version} está disponível. Rode ${name} update`,
		changelogLabel: "Changelog: ",
		openChangelog: "abrir o changelog",
		packageUpdatesAvailable: "Atualizações de pacotes disponíveis",
		packageUpdates: (name: string) => `Há atualizações de pacotes. Rode ${name} update`,
		packagesLabel: "Pacotes:",
		tmuxExtendedKeys:
			"O extended-keys do tmux está desligado. Teclas Enter modificadas podem não funcionar. Adicione `set -g extended-keys on` em ~/.tmux.conf e reinicie o tmux.",
		tmuxExtendedKeysFormat:
			"O extended-keys-format do tmux está em xterm. O Pi funciona melhor com csi-u. Adicione `set -g extended-keys-format csi-u` em ~/.tmux.conf e reinicie o tmux.",
	},
} satisfies InterfaceText["commandController"];
