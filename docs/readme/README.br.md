<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="../../packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="../../packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="../../packages/console/app/src/asset/logo-ornate-light.svg" alt="Logo do OpenCode">
    </picture>
  </a>
</p>
<p align="center">AI Coding Agent open source — branch SMARK aprimorada</p>
<p align="center">
  <a href="https://github.com/anomalyco/opencode/tree/dev"><img alt="Branch dev upstream" src="https://img.shields.io/badge/upstream-dev-6b7280?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="Versao npm upstream" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square&label=upstream%20npm" /></a>
  <a href="https://github.com/SMARK2022/opencode/tree/dev-smark"><img alt="Branch SMARK" src="https://img.shields.io/badge/SMARK%20branch-dev--smark-0969da?style=flat-square" /></a>
  <a href="https://github.com/SMARK2022/opencode/releases"><img alt="Versao SMARK atual" src="https://img.shields.io/badge/current-1.15.7-f97316?style=flat-square" /></a>
</p>

<p align="center">
  <a href="../../README.md">简体中文</a> |
  <a href="README.en.md">English</a> |
  <a href="README.zht.md">繁體中文</a> |
  <a href="README.ko.md">한국어</a> |
  <a href="README.de.md">Deutsch</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a> |
  <a href="README.it.md">Italiano</a> |
  <a href="README.da.md">Dansk</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.pl.md">Polski</a> |
  <a href="README.ru.md">Русский</a> |
  <a href="README.bs.md">Bosanski</a> |
  <a href="README.ar.md">العربية</a> |
  <a href="README.no.md">Norsk</a> |
  <a href="README.br.md">Português (Brasil)</a> |
  <a href="README.th.md">ไทย</a> |
  <a href="README.tr.md">Türkçe</a> |
  <a href="README.uk.md">Українська</a> |
  <a href="README.bn.md">বাংলা</a> |
  <a href="README.gr.md">Ελληνικά</a> |
  <a href="README.vi.md">Tiếng Việt</a>
</p>

[![OpenCode Terminal UI](../../packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

> **Sobre este branch**: este e o branch aprimorado `dev-smark` do OpenCode (versao atual `1.15.7`, CLI release tag `v1.15.7-smark`). Ele e baseado no `dev` upstream e foca em interacao TUI, gerenciamento de sessoes, estatisticas de token, compatibilidade com Windows/PowerShell, integracao com VS Code Notebook, suporte a proxy de rede e experiencia de instalacao.

---

## Instalacao Rapida

Use o instalador da pagina de releases do branch SMARK. Por padrao, ele instala a release mais recente e grava o diretorio de instalacao nos shell profiles existentes.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Verifique depois da instalacao:

```bash
opencode --version
which opencode
```

Se o shell atual ainda nao recarregou o PATH, reabra o terminal ou faca source do profile mostrado no log de instalacao.

### Especificar Diretorio De Instalacao

Instalacoes no nivel do usuario sao recomendadas em `~/.local/bin`. A variavel de ambiente deve ser passada ao processo `bash` que executa o instalador, nao apenas ao `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

Para troubleshooting, baixe o script primeiro e depois execute-o:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Nao escreva desta forma:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Isso passa `OPENCODE_INSTALL_DIR` apenas para o `curl`, nao para o processo `bash` que realmente executa o instalador.

### Especificar Versao

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

Esta e a forma completa: `bash -s --` diz ao `bash` para ler o instalador de stdin e passar `--version 1.15.7-smark` como argumentos do instalador. A versao pode ser `1.15.7-smark` ou a forma de release tag `v1.15.7-smark`.

### Comportamento Do Instalador

| Cenario | Comportamento |
| --- | --- |
| Diretorio de instalacao padrao | `$OPENCODE_INSTALL_DIR`, depois `$XDG_BIN_DIR`, depois `$HOME/.opencode/bin` |
| Mesma versao ja existe no caminho de destino | Reinstala e sobrescreve, util para atualizar binarios danificados ou obsoletos |
| Mesma versao em outro lugar no PATH | Imprime apenas um aviso; nao bloqueia a instalacao no diretorio solicitado |
| Escrita de PATH | Por padrao atualiza todos os profiles suportados existentes e evita entradas duplicadas |
| sudo | Recusa inicializacao com `sudo` por padrao; instalacoes de sistema devem passar `--allow-sudo` explicitamente |
| macOS quarantine | Tenta remover o atributo `com.apple.quarantine` depois da instalacao |
| checksum | Verifica os assets baixados quando a release fornece `checksums.txt` |

### PATH E Shell Profiles

O instalador detecta e atualiza profiles existentes: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*` e `~/.config/fish/config.fish`.

| Necessidade | Comando |
| --- | --- |
| Nao modificar PATH | `bash /tmp/opencode-install --no-modify-path` |
| Escrever apenas um profile | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Escolher profile interativamente | `bash /tmp/opencode-install --interactive` |
| Instalar em diretorio de sistema | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

Se voce quiser que `~/.local/bin/opencode` tenha prioridade sobre `/usr/local/bin/opencode`, garanta que seu profile ordene o PATH assim:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Outros Metodos De Instalacao

Estes metodos usam o ecossistema upstream de gerenciadores de pacotes. Se voce precisa do build do branch SMARK, prefira o instalador de GitHub release acima.

| Plataforma | Comando | Observacoes |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | Voce tambem pode usar `bun`, `pnpm` ou `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Tap upstream, geralmente atualizado rapidamente |
| macOS/Linux | `brew install opencode` | Formula oficial do Homebrew, pode atrasar |
| Windows | `scoop install opencode` | Pacote Scoop |
| Windows | `choco install opencode` | Pacote Chocolatey |
| Arch Linux | `sudo pacman -S opencode` | Pacote estavel |
| Arch Linux | `paru -S opencode-bin` | Pacote binario AUR mais recente |
| Qualquer sistema | `mise use -g opencode` | Gerencie versoes de ferramentas com mise |
| Nix | `nix run nixpkgs#opencode` | Tambem pode executar a versao de desenvolvimento do GitHub |

---

## Inicio Rapido

```bash
cd <your-project>
opencode
```

Depois da inicializacao, descreva uma tarefa diretamente, como "explain this module architecture", "fix this error" ou "add tests for this feature". Na TUI, use `Tab` para alternar agents e use as ferramentas integradas para ler/escrever arquivos, executar comandos, inspecionar diffs e gerenciar sessoes.

| Acao | Descricao |
| --- | --- |
| `Tab` | Alternar entre os agents disponiveis |
| Lista de sessoes | Ver historico e pesquisar titulos e conteudo de mensagens |
| Previa de diff | Mostrar alteracoes no estilo git diff antes e depois de escritas de arquivos |
| Compactacao manual | Compactar contexto proativamente em sessoes longas para liberar espaco de tokens |
| Ferramenta Shell | Suporta cancelamento, compressao de saida e normalizacao de saida do PowerShell |

---

## Aplicativo Desktop

O branch SMARK `dev-smark` atualmente publica apenas releases de CLI, nao instaladores do aplicativo desktop. Para o aplicativo desktop (BETA), use [opencode.ai/download](https://opencode.ai/download) e as notas de release upstream como fonte da verdade; nao trate a pagina de releases da CLI SMARK como fonte de instaladores desktop.

---

## Recursos Principais

Este branch nao e apenas uma pilha de recursos; ele transforma pontos comuns de dor no desenvolvimento em fluxos de trabalho observaveis, recuperaveis e multiplataforma.

| Area | Problema Resolvido | O Que Voce Vera |
| --- | --- | --- |
| Interacao TUI | Saida longa, mensagens em streaming, diffs dificeis de ler | Renderizacao ao vivo, raciocinio recolhivel, previa de diff, atualizacoes instantaneas de status |
| Gerenciamento de sessoes | Sessoes longas perdem contexto e sao caras de recuperar | Pesquisa de sessoes, filtros de caminho, compactacao manual, recuperacao de interrupcao, Session Warping |
| Estatisticas de token | Dificil saber o que consome contexto | Tokens de entrada/saida, resultados de ferramentas, anexos, detalhamento de overhead da requisicao |
| Sistema de ferramentas | Saida de arquivos e shell pode poluir o contexto | Saida estruturada de Read, compressao de saida do Shell, diff automatico do Write |
| Provider | Configuracao de multiplas contas, endpoints e modelos e complexa | Aliases de provider, override de versao de cliente, ClaudeCode provider |
| VSCode | Cenarios de Notebook nao podem ser operados de forma confiavel por agents CLI | Resumo, leitura, edicao, execucao, leitura de saida e gerenciamento de kernel de celulas |
| Windows | PowerShell, codificacao, caminhos e CRLF sao propensos a erro | Decodificacao CLIXML, correcoes de UTF-8, normalizacao de caminhos, preservacao de CRLF |
| Proxy de rede | Logica de proxy de provider, plugin e fetch fica espalhada | NetworkProxy trata HTTP_PROXY, HTTPS_PROXY, NO_PROXY de forma consistente |
| Daemon | Multi-instancia, locks, health checks e clientes sao complexos | Server Lock, health checks, HttpApi, tickets PTY WebSocket |

### TUI E Experiencia De Interacao

| Capacidade | Detalhes |
| --- | --- |
| Saida em streaming | Mensagens do assistant e trechos de raciocinio renderizam incrementalmente, com tempo decorrido mostrado durante o streaming |
| Exibicao de raciocinio | Raciocinios longos podem ser recolhidos para reduzir o uso da tela |
| Previa de diff | Sobrescritas de arquivo geram automaticamente uma visualizacao no estilo git diff com contagem de linhas adicionadas/removidas |
| Lista de sessoes | Mostra resumos de mensagens recentes e suporta pesquisa por titulo e conteudo de mensagens |
| Estabilidade de layout | Barras de rolagem, tratamento de largura do terminal e largura de caracteres CJK mais confiaveis |
| Modo Shell | Fornece botao de cancelamento, icone personalizado, placeholder de exemplo e status de conclusao ao vivo |

### Gerenciamento De Sessao E Contexto

| Capacidade | Detalhes |
| --- | --- |
| Recuperacao de sessao | Mensagens ocultas, operacoes de undo, verificacoes de mensagens pendentes e recuperacao de erros sao mais robustas |
| Controle de interrupcao | Registra contagens de interrupcao e horario de confirmacao; interrupcoes da sessao pai se propagam para subtarefas |
| Compatibilidade de caminhos | Caminhos globais de sessao no Windows sao normalizados; armazenamento de sessao usa caminhos relativos |
| Compactacao manual | Usuarios podem acionar compactacao; a selecao de compactacao e assincrona e relata erros |
| Contexto Git | Injeta automaticamente branch atual, status, commits recentes e dados relacionados com uma chave de configuracao |

### Visibilidade De Tokens E Custos

| Entrada | Uso | Exibicao |
| --- | --- | --- |
| TUI Context usage | Execute `/context` em uma sessao ou escolha `Context usage` na paleta de comandos | Mostra janela de contexto atual, modelo, tokens usados/disponiveis e grade de categorias Prompt/Conversation/Window |
| Rodape Context usage | Parte inferior do painel da TUI | Com uso da sessao, mostra `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`; sem uso cumulativo, mostra `Used`, `Free`, `Usable`, `Buffer` |
| Coluna de custo da lista de sessoes | `opencode session list --cost` ou `opencode session list -c` | Adiciona colunas `Cost` e `Tokens` a session list para encontrar hotspots de custo rapidamente |
| Detalhes de uma sessao | `opencode session info -s <Session_ID>` | Mostra `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` por provider/model |
| Estatisticas globais | `opencode stats --models` | Resume custo total, custo medio diario, tokens medios, uso de ferramentas e uso de modelos |

As estatisticas internas preferem dados de request usage e recorrem a metadados de mensagens para sessoes antigas. O TUI Context usage tambem estima instruction, skills, tool definitions, anexos, resultados de ferramentas e uso de compaction summary na janela de contexto.

### Sistema De Ferramentas

| Ferramenta | Aprimoramento |
| --- | --- |
| Read | Metadados, stub, contagem padrao de linhas lidas, limites de bytes, protecao contra arquivos de dispositivo |
| Grep/Ripgrep | Limita maximo de arquivos e contagens de resultado, com erros claros para buscas amplas demais |
| Shell | bash, PowerShell e cmd usam prompts conscientes do shell separadamente |
| Write | Gera automaticamente um diff ao sobrescrever arquivos para que usuarios possam confirmar a alteracao real |
| Permission | Permissoes do agent pai sao filtradas antes de passar a subtarefas; verificacoes de disponibilidade de ferramentas sao mais estritas |

### Provider E Modelos

| Capacidade | Descricao |
| --- | --- |
| Aliases de provider | Configure multiplas contas ou endpoints para o mesmo provider subjacente |
| Override de versao de cliente | Adapte providers personalizados, proxies de compatibilidade e endpoints especiais de API |
| ClaudeCode provider | Suporta API Key, Base URL e modos de autenticacao dinamicos |
| Cloudflare AI Gateway | Correcoes de roteamento; tool streaming e desativado por padrao para modelos nao Anthropic |

### Integracao Com VS Code Notebook

Antes de usar ferramentas de Notebook, instale a extensao do VS Code [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). A versao da extensao permanece `1.15.5` e pode continuar funcionando com a CLI SMARK `1.15.7`; ela nao precisa de upgrade para esta atualizacao do README da CLI. A extensao cria uma bridge local autenticada entre VS Code/Jupyter Notebook e a CLI OpenCode; sem ela instalada ou conectada, a CLI nao consegue ler, editar ou executar celulas de notebook de forma confiavel.

Depois da inicializacao, a extensao abre uma bridge local em `127.0.0.1:<random port>` e grava um manifest de heartbeat em `~/.local/state/opencode/ide/<uuid>.json`. O OpenCode seleciona automaticamente a bridge VS Code correspondente por workspace e caminho do notebook. Em configuracoes remotas SSH, WSL ou container, a CLI deve executar no mesmo lado que consegue acessar a bridge.

| Ferramenta | Finalidade |
| --- | --- |
| `vscode_notebook_summary` | Obter IDs estaveis `#VSC-*`, indice de exibicao, tipo, linguagem, estado de execucao, resumo de saida, estado dirty e runtime info para celulas de notebook |
| `vscode_notebook_source` | Ler fonte do notebook com numeros de linha virtuais globais baseados em 1; o conteudo retornado e limitado a 16KB por padrao |
| `vscode_notebook_edit` | Inserir, editar ou excluir celulas; suporta substituicao exata por string `oldCode/newCode` e alternancia de tipo code/markdown |
| `vscode_notebook_run` | Executar uma celula de codigo ou um intervalo de IDs estaveis pelo VS Code/Jupyter; a execucao de intervalo para em falha ou timeout |
| `vscode_notebook_output` | Ler texto, imagem, HTML, JSON e outras saidas; saidas grandes sao gravadas em `.opencode/cache/notebook-outputs/` e retornadas como caminhos de artifact |
| `vscode_notebook_env` | Inspecionar kernel/runtime, acionar selecao de kernel, reiniciar kernel ou salvar um notebook quando explicitamente solicitado pelo usuario |

Fluxo recomendado: use `vscode_notebook_summary` para obter o ID atual da celula, `vscode_notebook_source` para ler a celula alvo, `vscode_notebook_run` para validar depois da edicao e `vscode_notebook_output` para inspecionar resultados. Nao trate o indice de exibicao `cN` como referencia estavel de longo prazo; depois de insercoes, exclusoes ou trocas de tipo, use o novo ID `#VSC-*` retornado pela ferramenta ou execute summary novamente.

### Suporte Multiplataforma

| Problema De Plataforma | Tratamento |
| --- | --- |
| Codificacao no Windows | Detecta automaticamente UTF-8/UTF-16LE e corrige mojibake de pipe |
| PowerShell | Decodificacao CLIXML, normalizacao de stderr, reparo de saida UTF-8 |
| Diferencas de caminho | Normaliza capitalizacao, separadores e caminhos globais de sessao |
| Finais de linha | Preserva o estilo original CRLF/LF ao aplicar patches |
| WSL | Mantem guias de migracao e build multiplataforma |

---

## Agents

O OpenCode inclui varios primary agents integrados que podem ser alternados com `Tab`. O agent padrao pode ser sobrescrito com `default_agent`; subagents sao invocados principalmente por despacho de tarefas ou `@agent`.

| Agent | Tipo | Modelo De Permissao | Melhor Para |
| --- | --- | --- | --- |
| `build` | primary | Modo de desenvolvimento padrao; executa ferramentas conforme as permissoes configuradas, permite confirmacao por pergunta e entrada em plan | Implementar recursos, corrigir bugs, executar testes, entrega ponta a ponta |
| `interactive` | primary | Modo interativo mais conservador; `bash`, execucao de notebook e operacoes de ambiente de notebook perguntam por padrao | Tarefas que precisam de confirmacao para comandos importantes ou menor risco de operacoes acidentais |
| `auto` | primary | Ativado apenas quando selecionado explicitamente; `bash`, `edit` e acesso de shell a diretorio externo entram em auto permission review | Revisar automaticamente risco de shell/edicao sem alterar acidentalmente o comportamento padrao do build |
| `decide` | primary | Desativa ferramentas e faz um julgamento unico a partir de contexto recente limitado | Decisoes pontuais de menor custo, tradeoffs e escolhas de proximos passos com um modelo de alta performance |
| `plan` | primary | Nao permite ferramentas de edicao nem alteracoes de notebook; permite escrever arquivos de plan e sair de plan | Analise de codigo, planejamento, revisao de riscos, desenho antes da execucao |
| `general` | subagent | Subagent geral; proibe `todowrite`, caso contrario segue a configuracao de permissao mesclada | Busca complexa, pesquisa em varias etapas, tarefas de suporte paralelizaveis |
| `explore` | subagent | Permite apenas busca, leitura, listagem, consulta web e ferramentas similares de exploracao | Localizar rapidamente arquivos, simbolos, cadeias de chamada, config e docs |
| `scout` | subagent, experimental | Mira docs externas e source de dependencias; permite leituras de cache gerenciado de repo | Inspecionar implementacao de bibliotecas de terceiros, clonar source de dependencias, pesquisar comportamento de APIs externas |

`title`, `summary` e `compaction` sao agents de sistema ocultos para geracao de titulo, resumos e fluxos de compactacao, nao alvos de alternancia manual diaria. Saiba mais sobre [Agents](https://opencode.ai/docs/agents).

---

## Documentacao

| Recurso | Link |
| --- | --- |
| Docs oficiais | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Guia de contribuicao | [CONTRIBUTING.md](../../CONTRIBUTING.md) |

---

## FAQ

### Como isso e diferente do Claude Code?

O alvo de capacidade e parecido, mas o OpenCode foca em open source, uso terminal-first, independencia de provider, arquitetura cliente/servidor e um sistema de ferramentas extensivel. O branch SMARK fortalece ainda mais Windows/PowerShell, VS Code Notebook, visibilidade de tokens, suporte a proxy de rede e experiencia de instalacao.

### Para quem e este branch?

Se voce costuma desenvolver no terminal, precisa de comportamento auditavel de agent ou usa AI coding agents em cenarios de Windows/PowerShell ou VS Code Notebook, este branch oferece uma experiencia mais completa que os padroes upstream.

### Por que o instalador nao usa sudo por padrao?

A instalacao no nivel do usuario e mais segura e mais facil de gerenciar. O instalador grava em um diretorio de usuario por padrao e recusa sudo implicito. Use `sudo env ... --allow-sudo` apenas quando voce instalar explicitamente em um diretorio de sistema como `/usr/local/bin`; considere tambem `--no-modify-path` para evitar que root modifique profiles de usuario.

### E se um opencode antigo ja existir no sistema?

O instalador confia apenas no caminho de instalacao de destino. Mesmo se `/usr/local/bin/opencode` ja tiver a mesma versao, especificar `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` ainda instala em `~/.local/bin/opencode` e nao sera bloqueado por um binario antigo no PATH.

---

## Contribuindo

Leia o [guia de contribuicao](../../CONTRIBUTING.md) antes de enviar um PR. Se o nome do seu proprio projeto usar `opencode`, declare no README dele que nao e um projeto oficial da equipe OpenCode e nao e afiliado a equipe OpenCode.

---

## Comunidade

**Junte-se a nossa comunidade** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
