<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">Open source AI Coding Agent — SMARK-forbedret branch</p>
<p align="center">
  <a href="https://github.com/anomalyco/opencode/tree/dev"><img alt="Upstream dev branch" src="https://img.shields.io/badge/upstream-dev-6b7280?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="Upstream npm version" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square&label=upstream%20npm" /></a>
  <a href="https://github.com/SMARK2022/opencode/tree/dev-smark"><img alt="SMARK branch" src="https://img.shields.io/badge/SMARK%20branch-dev--smark-0969da?style=flat-square" /></a>
  <a href="https://github.com/SMARK2022/opencode/releases"><img alt="Current SMARK version" src="https://img.shields.io/badge/current-1.15.7-f97316?style=flat-square" /></a>
</p>

<p align="center">
  <a href="README.md">简体中文</a> |
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

[![OpenCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

---

> **Om denne branch**: Dette er OpenCode `dev-smark` enhanced branch (aktuel version `1.15.7`, CLI release tag `v1.15.7-smark`). Den bygger på upstream `dev` branch og fokuserer på forbedringer af TUI-interaktion, sessionshåndtering, Token-statistik, Windows/PowerShell-kompatibilitet, VSCode Notebook-integration, netværksproxy og installationsoplevelse.

---

## Hurtig installation

Brug helst installationsscriptet fra SMARK-branchens release-side. Det installerer som standard den nyeste release og skriver installationsmappen til eksisterende shell-profiler.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Bekræft efter installation:

```bash
opencode --version
which opencode
```

Hvis den aktuelle shell endnu ikke har opdateret PATH, så åbn terminalen igen eller source den profile, som installationsloggen angiver.

### Angiv installationsmappe

Til brugerinstallation anbefales `~/.local/bin`. Bemærk, at miljøvariablen skal sendes til den `bash`, der kører installer, ikke kun til `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

En bedre form til fejlsøgning er først at hente scriptet og derefter køre det:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Skriv ikke sådan:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Denne form sender kun `OPENCODE_INSTALL_DIR` til `curl`, ikke til den `bash`, der faktisk kører installationsscriptet.

### Angiv version

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

Dette er den komplette form: `bash -s --` får `bash` til at læse installer fra stdin og sende `--version 1.15.7-smark` videre som installer-argument. Versionsargumentet kan være `1.15.7-smark` eller release tag-formen `v1.15.7-smark`.

### Installationsscriptets adfærd

| Scenarie | Adfærd |
| --- | --- |
| Standard installationsmappe | `$OPENCODE_INSTALL_DIR`, derefter `$XDG_BIN_DIR`, til sidst `$HOME/.opencode/bin` |
| Samme version findes allerede på målstien | Installerer igen oveni for at opdatere en beskadiget eller forældet binary |
| Samme version findes et andet sted i PATH | Udskriver kun en besked og blokerer ikke installation til den valgte mappe |
| PATH-skrivning | Opdaterer som standard alle eksisterende understøttede profiler og skriver ikke dubletter |
| sudo | Afviser som standard start med `sudo`; systeminstallation kræver eksplicit `--allow-sudo` |
| macOS quarantine | Forsøger automatisk at fjerne attributten `com.apple.quarantine` efter installation |
| checksum | Validerer downloadede assets, hvis releasen indeholder `checksums.txt` |

### PATH og shell profile

Installationsscriptet finder og opdaterer disse eksisterende profiler: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*`, `~/.config/fish/config.fish`.

| Behov | Kommando |
| --- | --- |
| Ændr ikke PATH | `bash /tmp/opencode-install --no-modify-path` |
| Skriv kun til en bestemt profile | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Vælg profile interaktivt | `bash /tmp/opencode-install --interactive` |
| Installer i systemmappe | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

Hvis `~/.local/bin/opencode` skal prioriteres over `/usr/local/bin/opencode`, skal PATH-rækkefølgen i din profile ligne dette:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Andre installationsmåder

Disse metoder passer til upstream package manager-økosystemet. Hvis du vil have SMARK-branchens version, skal du bruge GitHub release installer ovenfor.

| Platform | Kommando | Bemærkning |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | Kan også bruge `bun`, `pnpm`, `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Upstream tap, normalt hurtigt opdateret |
| macOS/Linux | `brew install opencode` | Officiel Homebrew formula, kan halte bagefter |
| Windows | `scoop install opencode` | Scoop-pakke |
| Windows | `choco install opencode` | Chocolatey-pakke |
| Arch Linux | `sudo pacman -S opencode` | Stabil pakke |
| Arch Linux | `paru -S opencode-bin` | Nyeste AUR binary-pakke |
| Alle systemer | `mise use -g opencode` | Administrer værktøjsversioner med mise |
| Nix | `nix run nixpkgs#opencode` | Kan også køre udviklingsversion fra GitHub-kilde |

---

## Hurtig start

```bash
cd <your-project>
opencode
```

Efter start kan du beskrive opgaver direkte, f.eks. “forklar arkitekturen i dette modul”, “ret denne fejl” eller “tilføj tests for denne funktion”. I TUI bruger du `Tab` til at skifte Agent og de indbyggede værktøjer til at læse/skrive filer, køre kommandoer, se diff og styre sessions.

| Handling | Beskrivelse |
| --- | --- |
| `Tab` | Skift mellem tilgængelige Agent |
| Sessionsliste | Se historiske sessions og søg i titler og beskedindhold |
| Diff-preview | Viser git diff-lignende ændringer før og efter filskrivning |
| Manuel komprimering | Komprimer kontekst aktivt i lange sessions for at frigøre token-plads |
| Shell-værktøj | Understøtter annullering, output-komprimering og PowerShell-outputnormalisering |

---

## Desktop-applikation

SMARK `dev-smark` branch udgiver i øjeblikket kun CLI, ikke desktop-installationspakker. Hvis du har brug for desktop-versionen (BETA), skal du følge [opencode.ai/download](https://opencode.ai/download) og upstream release-noter; brug ikke SMARK CLI release-siden som kilde til desktop-installation.

---

## Kernefunktioner

Denne branch handler ikke om blot at stable funktioner, men om at gøre hyppige udviklingsproblemer observerbare, gendannelige og tværplatformsvenlige.

| Område | Problem der løses | Synlig ændring |
| --- | --- | --- |
| TUI-interaktion | Lang output, streaming-beskeder og svære diffs | Realtime rendering, foldbar reasoning, diff-preview, øjeblikkelig status |
| Sessionshåndtering | Lange sessions mister let kontekst og er dyre at gendanne | Sessionssøgning, stifiltrering, manuel komprimering, interrupt recovery, Session Warping |
| Token-statistik | Uklart hvad der bruger kontekst | Input/output token, værktøjsresultater, attachments og request-overhead opdelt |
| Værktøjssystem | Fil-I/O og shell-output kan forurene kontekst | Struktureret Read-output, komprimeret Shell-output, automatisk Write-diff |
| Provider | Flere konti, endpoints og modeller er komplekse | Provider aliases, klientversionsoverride, ClaudeCode provider |
| VSCode | Notebook-scenarier kan ikke håndteres pålideligt af CLI Agent | Cell summary, læsning, redigering, kørsel, output-læsning, kernel management |
| Windows | PowerShell, encoding, paths og CRLF fejler let | CLIXML-dekodning, UTF-8-fix, path-normalisering, CRLF-bevaring |
| Netværksproxy | Proxylogik for provider, plugins og fetch er spredt | NetworkProxy samler HTTP_PROXY, HTTPS_PROXY, NO_PROXY |
| Daemon | Flere instanser, locks, health checks og klientforbindelser er komplekse | Server Lock, health checks, HttpApi, PTY WebSocket tickets |

### TUI og interaktionsoplevelse

| Evne | Detaljer |
| --- | --- |
| Streaming-output | Assistant-beskeder og reasoning-fragmenter renderes inkrementelt med varighed under streaming |
| Reasoning-visning | Lang reasoning kan foldes sammen for at spare skærmplads |
| Diff-preview | Ved filoverskrivning oprettes automatisk git diff-lignende visning med statistik for tilføjede/slettede linjer |
| Sessionsliste | Viser resumé af seneste beskeder og understøtter søgning efter titel og beskedindhold |
| Layoutstabilitet | Scrollbars, terminalbredde og CJK-tegnbredde håndteres mere pålideligt |
| Shell-tilstand | Har annulleringsknap, egne ikoner, eksempel-placeholder og realtime completion-status |

### Sessions- og konteksthåndtering

| Evne | Detaljer |
| --- | --- |
| Session recovery | Skjulte beskeder, undo, pending message-checks og error recovery er mere stabile |
| Interrupt-kontrol | Registrerer antal interrupts og bekræftelsestid; parent session-interrupts spredes til subtasks |
| Path-kompatibilitet | Windows global session path-normalisering; session storage bruger relative paths |
| Manuel komprimering | Brugeren kan udløse komprimering; valg behandles asynkront med fejl提示 |
| Git-kontekst | Injicerer automatisk aktuel branch, status og seneste commits; kan konfigureres |

### Token- og omkostningssynlighed

| Indgang | Brug | Viser |
| --- | --- | --- |
| TUI Context usage | Kør `/context` i en session eller vælg `Context usage` fra command palette | Aktuelt context window, model, brugte/tilgængelige token og Prompt/Conversation/Window grid |
| Context usage footer | Nederst i TUI-panelet | Med session usage vises `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`; uden akkumuleret usage vises `Used`, `Free`, `Usable`, `Buffer` |
| Sessionslistens cost-kolonne | `opencode session list --cost` eller `opencode session list -c` | Tilføjer `Cost` og `Tokens` til session list for hurtigt at finde cost-hotspots |
| Enkelt session-detail | `opencode session info -s <Session_ID>` | Viser `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` pr. provider/model |
| Global statistik | `opencode stats --models` | Samler total cost, daglig gennemsnitscost, gennemsnitlige token, tool usage og model usage |

Intern statistik læser request usage først; for ældre sessions uden request usage falder den tilbage til message metadata. TUI Context usage estimerer også instruktioner, skills, tool definitions, attachments, tool results og compaction summary i context window.

### Værktøjssystem

| Værktøj | Forbedring |
| --- | --- |
| Read | Metadata, stub, standardlinjer, bytegrænser og beskyttelse mod device files |
| Grep/Ripgrep | Grænser for maks. filantal og resultater samt tydelige fejl ved for brede søgninger |
| Shell | bash, PowerShell og cmd bruger shell-aware prompts |
| Write | Genererer automatisk diff ved overskrivning, så brugeren kan bekræfte faktiske ændringer |
| Tilladelser | Parent agent-tilladelser filtreres til subtasks, og tool availability-checks er strengere |

### Provider og modeller

| Evne | Beskrivelse |
| --- | --- |
| Provider aliases | Samme underliggende provider kan konfigureres med flere konti eller endpoints |
| Klientversionsoverride | Tilpasser custom providers, kompatibilitetsproxyer og særlige API-endpoints |
| ClaudeCode provider | Understøtter API Key, Base URL og dynamiske auth-tilstande |
| Cloudflare AI Gateway | Routing-fix; ikke-Anthropic modeller har tool streaming slået fra som standard |

### VS Code Notebook-integration

Før du bruger Notebook-værktøjerne, skal du installere VS Code extension [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). Den aktuelle extension-version forbliver `1.15.5` og kan fortsat bruges med SMARK CLI `1.15.7`; den behøver ikke opgraderes for denne CLI README-opdatering. Extension etablerer en lokal auth bridge mellem VS Code/Jupyter Notebook og OpenCode CLI; uden installation eller forbindelse kan CLI ikke pålideligt læse, redigere eller køre notebook cells.

Når extension starter, åbner den en lokal bridge på `127.0.0.1:<random port>` og skriver et heartbeat-manifest til `~/.local/state/opencode/ide/<uuid>.json`. OpenCode vælger automatisk den matchende VS Code bridge efter workspace og notebook path; ved remote SSH, WSL eller container skal CLI køre på den side, der kan nå bridgen.

| Værktøj | Formål |
| --- | --- |
| `vscode_notebook_summary` | Henter stabile `#VSC-*` ID'er, display index, type, language, execution state, output summary, dirty state og runtime info for notebook cells |
| `vscode_notebook_source` | Læser notebook source pagineret med 1-based globale virtuelle linjenumre; output er som standard begrænset til 16KB |
| `vscode_notebook_edit` | Indsætter, ændrer eller sletter cells; understøtter præcis `oldCode/newCode` string replacement og code/markdown type-skift |
| `vscode_notebook_run` | Kører en enkelt code cell eller et stabilt ID-range via VS Code/Jupyter; range stopper ved fejl eller timeout |
| `vscode_notebook_output` | Læser text, images, HTML, JSON og andre outputs; store outputs skrives til `.opencode/cache/notebook-outputs/` og returnerer artifact path |
| `vscode_notebook_env` | Viser kernel/runtime, udløser kernel selection, genstarter kernel eller gemmer notebook når brugeren udtrykkeligt beder om det |

Anbefalet workflow: brug først `vscode_notebook_summary` til at finde aktuel cell ID, derefter `vscode_notebook_source` til at læse target cell, valider efter redigering med `vscode_notebook_run`, og brug til sidst `vscode_notebook_output` til at se resultatet. Brug ikke display index `cN` som langtidsholdbar reference; efter insert, delete eller type-skift skal du bruge det nye `#VSC-*` ID fra værktøjet eller køre summary igen.

### Tværplatformssupport

| Platformproblem | Håndtering |
| --- | --- |
| Windows encoding | Detekterer automatisk UTF-8/UTF-16LE og reparerer mojibake i pipelines |
| PowerShell | CLIXML-dekodning, stderr-normalisering og UTF-8-outputfix |
| Path-forskelle | Ensartet normalisering af case, separators og globale session paths |
| Line endings | Bevarer oprindelig CRLF/LF-stil ved patch-apply |
| WSL | Vedligeholder migration og cross-platform build guides |

---

## Agents

OpenCode har flere indbyggede primary agent, som hurtigt kan vælges med `Tab`. Standardagenten kan overskrives med `default_agent`; subagent bruges primært via task delegation eller `@agent`.

| Agent | Type | Tilladelsesmodel | Passer til |
| --- | --- | --- | --- |
| `build` | primary | Standard dev mode, kører værktøjer efter konfigurerede tilladelser, tillader spørgsmål og plan mode | Implementere features, rette bugs, køre tests, levere end-to-end |
| `interactive` | primary | Mere konservativ interaktiv mode; `bash`, notebook execution og notebook env operations spørger som standard | Opgaver der kræver brugerbekræftelse af kritiske kommandoer og lavere risiko |
| `auto` | primary | Aktiveres kun ved eksplicit valg; `bash`, `edit` og shell external directory access går i auto permission review | Automatisk review af shell/edit-risiko uden at ændre standard `build`-adfærd |
| `decide` | primary | Deaktiverer værktøjer og giver én vurdering baseret på begrænset nylig kontekst | Lavprisbeslutninger med stærk model: tradeoffs, næste skridt, valg |
| `plan` | primary | Forbyder edit tools og notebook-ændringer, men må skrive plan files og afslutte plan | Kodeanalyse, planlægning, risikovurdering før udførelse |
| `general` | subagent | Generel subagent, forbyder `todowrite`, ellers efter merged permission config | Komplekse søgninger, flertrinsresearch og parallelle hjælpetasks |
| `explore` | subagent | Tillader kun search, read, list, web queries og lignende exploration tools | Finde filer, symboler, call chains, config og docs hurtigt |
| `scout` | subagent, eksperimentel | Rettet mod ekstern dokumentation og dependency source; må læse managed repo cache | Undersøge tredjepartsbiblioteker, klone dependency source, studere ekstern API-adfærd |

`title`, `summary` og `compaction` er skjulte system agent til titelgenerering, opsummering og komprimering; de er ikke daglige manuelle valg. Læs mere om [Agents](https://opencode.ai/docs/agents).

---

## Dokumentation

| Ressource | Link |
| --- | --- |
| Officiel dokumentation | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Bidragsguide | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## FAQ

### Hvordan adskiller dette sig fra Claude Code?

Funktionelt ligger det tæt på, men OpenCode fokuserer på open source, terminal-first, provider-uafhængighed, client/server-arkitektur og et udvideligt værktøjssystem. SMARK-branchen styrker derudover Windows/PowerShell, VSCode Notebook, Token-synlighed, netværksproxy og installationsoplevelse.

### Hvem passer denne branch til?

Hvis du ofte udvikler i terminalen, har brug for auditerbar Agent-adfærd eller vil bruge en AI coding agent i Windows/PowerShell- eller VSCode Notebook-scenarier, giver denne branch en mere komplet oplevelse end upstream-standard.

### Hvorfor bruger installationsscriptet ikke sudo som standard?

Brugerinstallation er sikrere og nemmere at administrere. Scriptet skriver som standard til brugermappen og afviser implicit sudo. Kun når du eksplicit vil installere i en systemmappe som `/usr/local/bin`, skal du bruge `sudo env ... --allow-sudo`, helst sammen med `--no-modify-path` for at undgå at root ændrer brugerens profile.

### Hvad sker der, hvis systemet allerede har en gammel opencode?

Installationsscriptet bruger kun target install path som autoritet. Selv hvis `/usr/local/bin/opencode` allerede har samme version, installerer scriptet stadig til `~/.local/bin/opencode`, når du angiver `OPENCODE_INSTALL_DIR="$HOME/.local/bin"`; det bliver ikke blokeret af en gammel binary i PATH.

---

## Bidrag

Læs [bidragsguiden](./CONTRIBUTING.md), før du sender en PR. Hvis du bruger `opencode` i dit eget projektnavn, skal README tydeligt angive, at projektet ikke er et officielt OpenCode-teamprojekt og ikke er tilknyttet OpenCode-teamet.

---

## Community

**Bliv en del af vores community** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
