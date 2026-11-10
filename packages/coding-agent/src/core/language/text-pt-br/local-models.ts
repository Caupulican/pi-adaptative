/**
 * As palavras em português do Brasil dos comandos de modelo local (`/models`, `/fitness`) e da configuração do model
 * router: as linhas de estado de cada etapa de instalação, remoção e sonda, os avisos que precedem uma exclusão, as
 * listagens, os rótulos dos seletores e as prévias de rota. As folhas que levam um valor, uma contagem ou um plural são
 * funções, para cada língua colocar o valor e concordar do seu jeito.
 */

import type { InterfaceText } from "../interface-text.ts";

export const LOCAL_MODELS = {
	models: {
		thinkingInheritLabel: "(herdar)",
		thinkingInheritDescription: "Usar o padrão da sessão atual neste nível.",
		stopStopped: (sidecars: number, prismServer: boolean) =>
			`Servidor de modelo local do pi parado${sidecars > 0 ? ` (${sidecars} sidecar(s) do Transformers)` : ""}${prismServer ? " (servidor prism llama.cpp)" : ""}; os modelos continuam instalados.`,
		stopNone: "Nenhum servidor do pi em execução (um servidor do sistema, se houver, não é do pi parar).",
		imported: (args: {
			sourceDir: string;
			targetDir: string;
			manifests: number;
			hardlinked: number;
			copied: number;
			skipped: number;
		}) =>
			`Modelos do Ollama importados de ${args.sourceDir} para o armazenamento do pi ${args.targetDir}: ${args.manifests} manifesto(s), ${args.hardlinked} blob(s) com hardlink, ${args.copied} blob(s) copiados, ${args.skipped} arquivo(s) já existentes ignorados.`,
		needleUsage: "Uso: /models needle <query> [tools-json]",
		needleToolsHint:
			"  tools-json usa por padrão o conjunto de ferramentas do teste rápido embutido (uma consulta de clima de uma cidade)",
		addUsage:
			"Uso: /models add <ollama-tag | hf.co/org/repo[:quant] | ref HF full-base curado | URL do huggingface | comando de instalação colado>",
		addSuggestHint: "Ou comece por uma sugestão validada: /models suggest",
		removalUsage: (action: string) => `Uso: /models ${action} <ref> confirm`,
		uninstallRuntimeUsage: "Uso: /models uninstall-runtime <prism> confirm",
		enableUsage: (action: string) => `Uso: /models ${action} <ollama | llamacpp | transformers>`,
		notAdded: (reason: string) => `Não adicionado: ${reason}`,
		apiModel: (ref: string) =>
			`${ref} é um modelo de API, não há nada para instalar. Configure a autenticação do provedor e depois sonde com /fitness ${ref}.`,
		descriptorMissing: (modelId: string) =>
			`${modelId} não tem descritor curado do prism llama.cpp, isto é um erro de ligação.`,
		runtimeEnabled: (runtime: string, enabled: boolean) =>
			`O runtime local ${runtime} agora está ${enabled ? "ativado" : "desativado"}.`,
		unknownStore: "armazenamento desconhecido (0 modelo(s))",
		store: (path: string, kind: string, count: number) => `${path} [${kind}, ${count} modelo(s)]`,
		serverAlreadyRunning: (serverUrl: string) =>
			`O Ollama já está em execução em ${serverUrl}; esta sessão não consegue verificar a posse nem o armazenamento dele. Pare o outro servidor antes de adicionar modelos.`,
		startingServer: (binarySource: string, ownedModelsDir: string) =>
			`Iniciando o servidor de modelo local (binário ${binarySource}, armazenamento próprio: ${ownedModelsDir})…`,
		startFailed: (reason: string) => `Não foi possível iniciar o servidor local: ${reason}`,
		listHeader: (activeStore: string, ownedModelsDir: string, count: number) =>
			`Modelos do Ollama (armazenamento ativo: ${activeStore}; armazenamento do pi: ${ownedModelsDir} com ${count} modelo(s)):`,
		listNone: "  (nenhum instalado: /models add <ref>, /models import ou /models suggest para uma lista validada)",
		listHeaderDown: "Modelos do Ollama:",
		listServerDown: (binarySource: string) =>
			`  servidor não está em execução (binário: ${binarySource}). /models add inicia sob demanda; /fitness sonda os modelos registrados.`,
		transformersHeader: "Modelos Transformers gerenciados pelo pi:",
		readinessRunning: "servidor em execução",
		readinessInstalled: "runtime instalado",
		readinessMissing: "runtime ausente",
		probed: (args: {
			at: string;
			digestSucceeded: string;
			digestTotal: string;
			toolSucceeded: number;
			toolTotal: number;
			tokensPerSecond?: number;
		}) =>
			`sondado em ${args.at}: digest ${args.digestSucceeded}/${args.digestTotal}, chamadas de ferramenta ${args.toolSucceeded}/${args.toolTotal}${args.tokensPerSecond ? `, ~${args.tokensPerSecond} tok/s` : ""}`,
		unprobed: (ref: string) => `sem sonda: rode /fitness ${ref}`,
		transformersRow: (modelId: string, readiness: string, cacheDir: string, probe: string) =>
			`  - ${modelId} (${readiness}, cache: ${cacheDir}) · ${probe}`,
		ollamaRow: (name: string, gigabytes: string, probe: string) => `  - ${name} (${gigabytes} GB) · ${probe}`,
		listCommands: "Comandos: /models import · /models add <ref> · /models remove <ref> confirm · /models stop",
		pulling: (ref: string) => `Baixando ${ref}… (os pesos vão para o armazenamento do Ollama do pi)`,
		progress: (stage: string, progress: string) => `  ${stage}: ${progress}`,
		indented: (progress: string) => `  ${progress}`,
		installFailed: (stage: string, reason: string) => `A instalação falhou na etapa ${stage}: ${reason}`,
		installedRegistered: (ref: string, modelRef: string) =>
			`${ref} instalado e registrado como ${modelRef}. Sondando o fitness…`,
		installingTransformers: (modelId: string, venvDir: string) =>
			`Instalando o runtime isolado do Transformers para ${modelId} em ${venvDir}…`,
		transformersInstallFailed: (error: string) => `A instalação do runtime do Transformers falhou: ${error}`,
		transformersUnavailable: (venvDir: string) => `O runtime do Transformers continua indisponível em ${venvDir}.`,
		downloadFailed: (error: string) => `O download do modelo falhou: ${error}`,
		downloadFailedLabel: "O download do modelo falhou",
		sidecarStartFailed: (reason: string) => `Não foi possível iniciar o sidecar do Transformers: ${reason}`,
		notAutoRegistered: (reason: string) => `Instalado, mas não registrado automaticamente: ${reason}`,
		addToModelsJson: (path: string, snippet: string) => `Adicione você mesmo em ${path}:\n${snippet}`,
		registeredAs: (what: string, modelRef: string) =>
			`${what} instalado e registrado como ${modelRef}. Sondando o fitness…`,
		installingPrism: (displayName: string, runtimeDir: string) =>
			`Instalando o runtime prism llama.cpp para ${displayName} em ${runtimeDir}…`,
		prismInstallFailed: (error: string) => `A instalação do runtime prism llama.cpp falhou: ${error}`,
		prismUnavailable: (runtimeDir: string) => `O runtime prism llama.cpp continua indisponível em ${runtimeDir}.`,
		visionDownloadFailed: "O download do projetor de visão falhou",
		llamaServerStartFailed: "Não foi possível iniciar o llama-server",
		servedNotRegistered: (reason: string) => `Em execução, mas não registrado automaticamente: ${reason}`,
		localServerDown: "O servidor local não está em execução; inicie-o (qualquer ação de /models) antes de remover.",
		notInstalled: (ref: string, installed: string) => `${ref} não está instalado. Instalados: ${installed}`,
		noneInstalled: "(nenhum)",
		systemStorage: "o armazenamento do servidor do sistema",
		removalTitle: (what: string) => `Remover ${what} vai excluir:`,
		removalWeights: (gigabytes: string, where: string) => `  - os pesos do modelo (${gigabytes} GB) em ${where}`,
		removalRegistration: (entry: string) => `  - a entrada ${entry} em models.json`,
		removalFitness: "  - o relatório de fitness em cache para este host",
		removalRun: (command: string) => `Rode: ${command}`,
		stoppedSidecarNote: "Isto para o sidecar do Transformers desta sessão, se estiver em execução.",
		weightsRemain: (cacheDir: string) => `Os pesos em cache continuam em ${cacheDir}.`,
		weightsAt: (gigabytes: string, dir: string) => `  - os pesos do modelo baixados (${gigabytes} GB) em ${dir}`,
		noWeights: (cacheDir: string) => `  - nenhum peso em cache encontrado em ${cacheDir}`,
		ggufRemain: (modelsDir: string) => `Os pesos GGUF baixados continuam em ${modelsDir}.`,
		ggufAt: (gigabytes: string, modelsDir: string) => `  - os pesos GGUF baixados (${gigabytes} GB) em ${modelsDir}`,
		prismServerNote: (port: number) =>
			`O llama-server dele será parado se esta sessão o iniciou; se foi iniciado por outro processo ou sessão do pi, ele continua atendendo em 127.0.0.1:${port} até ser parado à mão.`,
		removeFailed: (error: string) => `A remoção falhou: ${error}`,
		removed: (ref: string) => `${ref} removido: pesos excluídos, registro e relatório de fitness descartados.`,
		droppedWeightsRemain: (modelId: string, cacheDir: string) =>
			`O registro e o relatório de fitness de ${modelId} foram descartados; os pesos em cache continuam em ${cacheDir}.`,
		prismDropped: (modelId: string, modelsDir: string, stopped: boolean, port: number) =>
			`O registro e o relatório de fitness de ${modelId} foram descartados; os pesos baixados continuam em ${modelsDir}.${
				stopped
					? " O llama-server dele foi parado."
					: ` Nenhum llama-server é acompanhado por esta sessão; se um ainda está em execução (iniciado por outro processo ou sessão do pi), pare-o à mão na porta ${port}.`
			}`,
		uninstallTitle: (what: string) => `Desinstalar ${what} vai excluir:`,
		prismUninstallServerNote: "O llama-server dele será parado se esta sessão o iniciou.",
		deleteWeightsFailed: (error: string) => `Não foi possível excluir os pesos: ${error}`,
		uninstalled: (what: string, size: string) =>
			`${what} desinstalado: pesos excluídos (${size} GB), registro e fitness descartados.`,
		prismUninstalled: (what: string, size: string, stopped: boolean) =>
			`${what} desinstalado: pesos GGUF excluídos (${size} GB), registro e fitness descartados.${
				stopped ? " O llama-server dele foi parado." : ""
			}`,
		runtimeNotInstalled: (runtimeDir: string) => `O runtime prism llama.cpp não está instalado em ${runtimeDir}.`,
		runtimeUninstallTitle: "Desinstalar o runtime prism llama.cpp vai excluir:",
		runtimeUninstallBinaries: (runtimeDir: string) =>
			`  - os binários e o manifesto do runtime do pi em ${runtimeDir}`,
		runtimeDeleted: (runtimeDir: string) => `Binários do runtime prism llama.cpp excluídos de ${runtimeDir}.`,
		runtimeDeleteFailed: (error: string) => `Não foi possível excluir os binários do runtime: ${error}`,
		unknownRuntime: (runtime: string) => `Runtime desconhecido: ${runtime}. Suportado: prism`,
		installingNeedle: (runtimeDir: string) =>
			`Instalando o needle (bancada de teste de chamada de função) em ${runtimeDir}…`,
		needleInstallFailed: (error: string) => `A instalação do needle falhou: ${error}`,
		needleUnavailable: (runtimeDir: string) => `O needle continua indisponível em ${runtimeDir}.`,
		needleWeightsFailed: (error: string) => `O download dos pesos do needle falhou: ${error}`,
		needleSmokeRunning: "Rodando o teste rápido do needle (sonda de chamada de função)…",
		needleSmokeFailed: (error: string) => `O teste rápido do needle falhou: ${error}`,
		needleSmokeNoCall: "o teste rápido relatou sucesso mas não devolveu nenhuma chamada interpretada",
		needleVerified: (args: { called: string; argumentsJson: string; latencyMs: number }) =>
			`needle instalado e verificado: o teste rápido chamou ${args.called}(${args.argumentsJson}) em ${args.latencyMs}ms. Use /models needle <query> [tools-json] para testar mais; é uma bancada isolada, não uma lane de chat nem de executor.`,
		needleRemovalTitle: "Remover o needle vai excluir:",
		needleRuntimeLine: (runtimeDir: string) =>
			`  - o runtime do needle gerenciado pelo pi (clone + venv) em ${runtimeDir}`,
		needleCheckpointLine: (checkpointPath: string) => `  - o checkpoint baixado em ${checkpointPath}`,
		needleNoRegistration:
			"o needle não tem entrada em models.json nem relatório de fitness; é uma bancada isolada de teste de chamada de função, nunca registrada como modelo de chat ou de lane.",
		needleRemoved: (runtimeDir: string, modelsDir: string) =>
			`needle removido: ${runtimeDir} e ${modelsDir} excluídos.`,
		needleNotInstalled:
			"O needle não está instalado. Rode /models add hf.co/Cactus-Compute/needle primeiro (ou /models suggest).",
		needleCheckpointMissing:
			"O needle está instalado, mas o checkpoint ainda não foi baixado. Rode /models add hf.co/Cactus-Compute/needle para buscar e verificar.",
		needleRunning: (query: string) => `needle: rodando "${query}"…`,
		needleCallFailed: (latencyMs: number, error: string, rawOutput: string) =>
			`A chamada do needle falhou (${latencyMs}ms): ${error}\nsaída bruta:\n${rawOutput}`,
		needleCall: (latencyMs: number, called: string, argumentsJson: string) =>
			`needle (${latencyMs}ms): ${called}(${argumentsJson})`,
		suggestionUnknownPrism: (name: string, modelId: string) =>
			`A sugestão ${name} aponta para um modelo prism curado desconhecido "${modelId}"; é um erro de ligação.`,
		suggestionNotInstallable: (name: string, why: string) => `A sugestão ${name} não pode ser instalada: ${why}`,
		installGuide: {
			ollama: (distDir: string) => [
				"O Ollama não está instalado. O pi pode instalá-lo agora (pergunta antes, nunca curl|sh), ou siga estes passos manuais:",
				"  1. Baixe o arquivo da versão fixada para a sua plataforma:",
				"     https://github.com/ollama/ollama/releases (arquivo: ollama-linux-amd64.tar.zst ou o da sua plataforma)",
				`  2. Extraia em ${distDir}`,
				"  3. Rode de novo o seu comando /models: o pi detecta o binário automaticamente.",
				"Ou instale para o sistema todo a partir de https://ollama.com/download e o pi usa o servidor do sistema.",
			],
			transformers: (args: {
				venvDir: string;
				cacheDir: string;
				pythonPath: string;
				packages: string;
				torchArgs: string;
			}) => [
				"O runtime do Hugging Face Transformers não está instalado para este modelo.",
				`O pi pode instalá-lo na própria venv em ${args.venvDir} e guardar os pesos em cache em ${args.cacheDir}.`,
				"Equivalente manual:",
				`  python -m venv ${args.venvDir}`,
				`  ${args.pythonPath} -m pip install --upgrade pip`,
				`  ${args.pythonPath} -m pip install ${args.packages}`,
				`  ${args.pythonPath} ${args.torchArgs}`,
			],
		},
	},
	fitness: {
		probeRunning: (modelRef: string) =>
			`Sondando o fitness de ${modelRef}… (6 superfícies; modelos locais podem levar alguns minutos)`,
		allSurfacesFailed: (model: string) =>
			`${model} falhou na sonda de fitness em todas as superfícies; não configurado. Use /model para defini-lo à mão se aceitar o risco.`,
		toolProbeRunning: (model: string) => `Sonda real de execução de ferramenta em ${model}…`,
		toolProbeUnavailable: (model: string, error: string) =>
			`Sonda real de execução de ferramenta indisponível para ${model}: ${error}`,
		notAssignedTool: (model: string, role: string, failure: string) =>
			`${model} não atribuído como ${role}: a execução real de ferramenta ${failure}.`,
		scoutLaneFailed: (lane: string) =>
			`falhou na verificação de ${lane === "toolCall" ? "chamada de ferramenta" : lane}`,
		scoutNotProbed: "não foi sondado",
		scoutRefused: (model: string, reason: string) =>
			`${model} não atribuído como scout: ${reason} no exame de fitness de scout. Use a receita de Modelfile em docs/scout.md e rode /fitness de novo.`,
		roleNone: (modelRef: string) =>
			`Resultado de fitness de ${modelRef} salvo. Atribua um papel depois em /settings.`,
		roleCurator: (modelRef: string) => `Curadoria de contexto ativada com ${modelRef} como curador.`,
		roleExecutor: (modelRef: string, hint: string) =>
			`${modelRef} definido como executor do toolkit (acertos diretos de Nível 0 vão para ele).${hint}`,
		routerDisabledHint: " O model router está desativado; ative em /settings → Model Router.",
		roleScout: (modelRef: string) => `${modelRef} definido como scout do repositório e ativado.`,
		roleSet: (modelRef: string, role: string, hint: string) => `${modelRef} definido como modelo ${role}.${hint}`,
	},
	routerSetup: {
		calibrationEmpty: "Calibração do router: o pool de candidatos está vazio. Configure os modelos primeiro.",
		calibrateOneTitle: "Calibrar um modelo",
		calibrateOneDescription: (scope: string) =>
			`Roda o ${scope} (chamadas ao provedor) e depois oferece um papel de router.`,
		batchNothing: (title: string) => `${title}: nada para calibrar no pool atual.`,
		batchCostKnown: (total: string, models: number) =>
			`as últimas execuções de fitness custaram $${total} em ${models} modelo(s)`,
		batchCostUnknown: "custo desconhecido até a primeira execução (modelos por assinatura podem custar $0.00)",
		runOnModels: (models: number) => `Rodar a calibração em ${models} modelo(s)`,
		providerCalls: (scope: string, costNote: string) =>
			`Chamadas ao provedor: sim (${scope}, por modelo). ${costNote}.`,
		cancelLabel: "Cancelar",
		cancelDescription: "Não rodar nada.",
		covers: (scope: string) => `Cobre ${scope}. Os modelos rodam um por vez.`,
		calibrating: (args: { modelRef: string; index: number; total: number; surfaces: string }) =>
			`Calibrando ${args.modelRef} (${args.index}/${args.total}): ${args.surfaces}…`,
		calibrationSkipped: (modelRef: string, reason: string) => `Calibração ignorada para ${modelRef}: ${reason}`,
		toolProbeOn: (modelRef: string) => `Calibrando ${modelRef}: sonda real de execução de ferramenta…`,
		toolProbeUnavailable: (modelRef: string, error: string) =>
			`Sonda de ferramenta indisponível para ${modelRef}: ${error}`,
		failed: (modelRef: string, error: string) => `A calibração falhou para ${modelRef}: ${error}`,
		complete: "Calibração do router concluída:",
		poolFollowsModels: "O pool do router segue a seleção de Modelos; a Configuração do Router mostra o pool editado.",
		livePreviewRunning: "Prévia de rota ao vivo em execução (o juiz de roteamento e o H-MoE podem gastar)…",
		livePreviewFailed: (error: string) => `A prévia de rota ao vivo falhou: ${error}`,
		unknownAction: (action: string) => `Ação de configuração do router desconhecida: ${action}`,
		calibrateUnprobedTitle: "Calibrar modelos não sondados",
		calibrateAllTitle: "Recalibrar modelos selecionados",
		preview: {
			intent: (value: string) => `Intenção: ${value}`,
			baselineTier: (value: string) => `Nível base: ${value}`,
			risk: (value: string) => `Risco: ${value}`,
			reason: (value: string) => `Motivo: ${value}`,
			selectionMode: (value: string) => `Modo de seleção: ${value}`,
			manualPin: (value: string) => `Fixação manual: ${value}`,
			poolSelected: (count: number, source: string) => `Pool: ${count} selecionados (${source})`,
			poolFavorites: (count: number) => `Pool: ${count} favoritos`,
			poolPreference: (value: string) => `Preferência de pool: ${value}`,
			subscriptionCandidates: (count: number) => `Candidatos por assinatura: ${count}`,
			eligibleCandidates: (count: number) => `Candidatos elegíveis: ${count}`,
			wouldChoose: (value: string) => `Escolheria: ${value}`,
			source: (value: string) => `Origem: ${value}`,
			sourceManualPin: "fixação manual",
			none: "nenhum",
			noModel: "nenhum modelo (o turno fica no modelo da sessão)",
			excludedPin:
				"Fixação excluída: a fixação manual está fora do pool de candidatos; um favorito elegível é escolhido no lugar.",
			fitness: (value: string) => `Fitness: ${value}`,
			skipReason: (value: string) => `Motivo de dispensa: ${value}`,
			candidates: "Candidatos:",
			deterministic: "Prévia determinística: nenhuma chamada ao provedor foi feita e o modelo da sessão não mudou.",
			chosenTier: (value: string) => `Nível escolhido: ${value}`,
			chosenModel: (value: string) => `Modelo escolhido: ${value}`,
			preference: (value: string) => `Preferência: ${value}`,
			reasons: "Motivos:",
			live: "Prévia ao vivo: o juiz de roteamento e o H-MoE podem ter rodado; o modelo da sessão não mudou.",
		},
	},
} satisfies InterfaceText["localModels"];
