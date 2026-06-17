<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">AI Coding Agent med åpen kildekode — SMARK-forbedret gren</p>
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

> **Om denne grenen**: Dette er OpenCodes `dev-smark`-forbedrede gren (gjeldende versjon `1.15.7`, CLI release tag `v1.15.7-smark`). Den er basert på upstream `dev` og fokuserer på TUI-interaksjon, sesjonshåndtering, tokenstatistikk, Windows/PowerShell-kompatibilitet, VS Code Notebook-integrasjon, nettverksproxy-støtte og installasjonsopplevelse.

---

## Hurtiginstallasjon

Bruk installasjonsprogrammet fra utgivelsessiden til SMARK-grenen. Som standard installerer det nyeste release og skriver installasjonskatalogen til eksisterende shell-profiler.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Verifiser etter installasjon:

```bash
opencode --version
which opencode
```

Hvis gjeldende shell ikke har oppdatert PATH, åpne terminalen på nytt eller source profilen som vises i installasjonsloggen.

### Angi Installasjonskatalog

Installasjoner på brukernivå anbefales i `~/.local/bin`. Miljøvariabelen må sendes til `bash`-prosessen som kjører installasjonsprogrammet, ikke bare til `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

For feilsøking, last ned skriptet først og kjør det deretter:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Ikke skriv det slik:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Det sender bare `OPENCODE_INSTALL_DIR` til `curl`, ikke til `bash`-prosessen som faktisk kjører installasjonsprogrammet.

### Angi Versjon

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

Dette er den fullstendige formen: `bash -s --` forteller `bash` at den skal lese installasjonsprogrammet fra stdin og sende `--version 1.15.7-smark` som argumenter til installasjonsprogrammet. Versjonen kan være `1.15.7-smark` eller release tag-formen `v1.15.7-smark`.

### Installasjonsprogrammets Atferd

| Scenario | Atferd |
| --- | --- |
| Standard installasjonskatalog | `$OPENCODE_INSTALL_DIR`, deretter `$XDG_BIN_DIR`, deretter `$HOME/.opencode/bin` |
| Samme versjon finnes allerede på målstien | Installer på nytt og overskriv, nyttig for å friske opp skadede eller utdaterte binærer |
| Samme versjon finnes et annet sted i PATH | Skriv bare et varsel; ikke blokker installasjon til den forespurte katalogen |
| PATH-skriving | Oppdater som standard alle eksisterende støttede profiler og unngå dupliserte oppføringer |
| sudo | Avvis `sudo`-oppstart som standard; systeminstallasjoner må sende `--allow-sudo` eksplisitt |
| macOS quarantine | Prøv å fjerne attributtet `com.apple.quarantine` etter installasjon |
| checksum | Verifiser nedlastede ressurser når releasen inneholder `checksums.txt` |

### PATH Og Shell-Profiler

Installasjonsprogrammet oppdager og oppdaterer eksisterende profiler: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*` og `~/.config/fish/config.fish`.

| Behov | Kommando |
| --- | --- |
| Ikke endre PATH | `bash /tmp/opencode-install --no-modify-path` |
| Skriv bare en profil | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Velg profil interaktivt | `bash /tmp/opencode-install --interactive` |
| Installer til systemkatalog | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

Hvis du vil at `~/.local/bin/opencode` skal prioriteres over `/usr/local/bin/opencode`, må du passe på at profilen ordner PATH slik:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Andre Installasjonsmetoder

Disse metodene bruker upstream-pakkehåndtererøkosystemet. Hvis du trenger bygget fra SMARK-grenen, bør du foretrekke GitHub release-installasjonsprogrammet ovenfor.

| Plattform | Kommando | Merknader |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | Du kan også bruke `bun`, `pnpm` eller `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Upstream tap, vanligvis raskt oppdatert |
| macOS/Linux | `brew install opencode` | Offisiell Homebrew-formel, kan henge etter |
| Windows | `scoop install opencode` | Scoop-pakke |
| Windows | `choco install opencode` | Chocolatey-pakke |
| Arch Linux | `sudo pacman -S opencode` | Stabil pakke |
| Arch Linux | `paru -S opencode-bin` | Nyeste AUR-binærpakke |
| Ethvert system | `mise use -g opencode` | Håndter verktøyversjoner med mise |
| Nix | `nix run nixpkgs#opencode` | Kan også kjøre utviklingsversjonen fra GitHub |

---

## Hurtigstart

```bash
cd <your-project>
opencode
```

Etter oppstart kan du beskrive en oppgave direkte, som "forklar denne modularkitekturen", "fiks denne feilen" eller "legg til tester for denne funksjonen". I TUI bruker du `Tab` for å bytte agenter og innebygde verktøy for å lese/skrive filer, kjøre kommandoer, inspisere differ og håndtere sesjoner.

| Handling | Beskrivelse |
| --- | --- |
| `Tab` | Bytt mellom tilgjengelige agenter |
| Sesjonsliste | Se historikk og søk i titler og meldingsinnhold |
| Diff-forhåndsvisning | Vis endringer i git diff-stil før og etter filskriving |
| Manuell komprimering | Komprimer kontekst proaktivt i lange sesjoner for å frigjøre tokenplass |
| Shell-verktøy | Støtter kansellering, utgangskomprimering og PowerShell-normalisering av utdata |

---

## Skrivebordsapp

SMARK `dev-smark`-grenen publiserer foreløpig bare CLI-releaser, ikke installasjonsprogrammer for skrivebordsappen. For skrivebordsappen (BETA), bruk [opencode.ai/download](https://opencode.ai/download) og upstream release notes som sannhetskilde; ikke behandle SMARK CLI-utgivelsessiden som kilde for skrivebordsinstallasjon.

---

## Kjernefunksjoner

Denne grenen er ikke bare en haug med funksjoner; den gjør vanlige utviklingssmerter om til observerbare, gjenopprettbare, tverrplattform-arbeidsflyter.

| Område | Problem Løst | Det Du Vil Se |
| --- | --- | --- |
| TUI-interaksjon | Lang utdata, strømmede meldinger, vanskelige differ | Live-rendering, sammenleggbar resonnering, diff-forhåndsvisning, umiddelbare statusoppdateringer |
| Sesjonshåndtering | Lange sesjoner mister kontekst og er kostbare å gjenopprette | Sesjonssøk, stifiltre, manuell komprimering, avbruddsgjenoppretting, Session Warping |
| Tokenstatistikk | Vanskelig å vite hva som bruker kontekst | Inndata-/utdata-tokens, verktøyresultater, vedlegg, oppdeling av forespørselsoverhead |
| Verktøysystem | Fil- og shell-utdata kan forurense kontekst | Strukturert Read-utdata, Shell-utdatakomprimering, Write automatisk diff |
| Provider | Oppsett av flere kontoer, endepunkter og modeller er komplekst | Provider-aliaser, klientversjonsoverstyring, ClaudeCode provider |
| VSCode | Notebook-scenarioer kan ikke betjenes pålitelig av CLI-agenter | Celleoversikt, lesing, redigering, kjøring, lesing av utdata, kjernehåndtering |
| Windows | PowerShell, koding, stier og CRLF er feilutsatt | CLIXML-dekoding, UTF-8-rettinger, stinormalisering, CRLF-bevaring |
| Nettverksproxy | Proxylogikk for provider, plugin og fetch er spredt | NetworkProxy håndterer HTTP_PROXY, HTTPS_PROXY, NO_PROXY konsekvent |
| Daemon | Flere instanser, låser, helsesjekker og klienter er komplekse | Server Lock, helsesjekker, HttpApi, PTY WebSocket-tickets |

### TUI Og Interaksjonsopplevelse

| Kapabilitet | Detaljer |
| --- | --- |
| Strømmende utdata | Assistentmeldinger og resonneringsdeler rendres inkrementelt, med medgått tid vist under strømming |
| Resonneringsvisning | Lang resonnering kan legges sammen for å redusere skjermbruk |
| Diff-forhåndsvisning | Filoverskrivinger genererer automatisk en visning i git diff-stil med antall tillagte/slettede linjer |
| Sesjonsliste | Viser sammendrag av nylige meldinger og støtter søk etter tittel og meldingsinnhold |
| Layoutstabilitet | Mer pålitelige rullefelt, terminalbreddehåndtering og håndtering av CJK-tegnbredde |
| Shell-modus | Gir kanselleringsknapp, tilpasset ikon, eksempelplassholder og live fullføringsstatus |

### Sesjons- Og Konteksthåndtering

| Kapabilitet | Detaljer |
| --- | --- |
| Sesjonsgjenoppretting | Skjulte meldinger, angreoperasjoner, ventende meldingssjekker og feilgjenoppretting er mer robuste |
| Avbruddskontroll | Registrerer avbruddstall og bekreftelsestid; avbrudd i overordnet sesjon forplanter seg til underoppgaver |
| Stikompatibilitet | Globale Windows-sesjonsstier normaliseres; sesjonslagring bruker relative stier |
| Manuell komprimering | Brukere kan utløse komprimering; valg av komprimering er asynkront og rapporterer feil |
| Git-kontekst | Injiserer automatisk gjeldende gren, status, nylige commits og relaterte data med en config switch |

### Token- Og Kostnadssynlighet

| Oppføring | Bruk | Visning |
| --- | --- | --- |
| TUI Context usage | Kjør `/context` i en sesjon eller velg `Context usage` fra kommandopaletten | Viser gjeldende kontekstvindu, modell, brukte/tilgjengelige tokens og Prompt/Conversation/Window-kategorirutenett |
| Context usage footer | Nederst i TUI-panelet | Med sesjonsbruk vises `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`; uten kumulativ bruk vises `Used`, `Free`, `Usable`, `Buffer` |
| Kostnadskolonne i sesjonsliste | `opencode session list --cost` eller `opencode session list -c` | Legger til kolonnene `Cost` og `Tokens` i sesjonslisten for raskt å finne kostnadstopper |
| Detaljer for en enkelt sesjon | `opencode session info -s <Session_ID>` | Viser `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` etter provider/model |
| Global statistikk | `opencode stats --models` | Oppsummerer totalkostnad, daglig gjennomsnittskostnad, gjennomsnittlige tokens, verktøybruk og modellbruk |

Intern statistikk foretrekker data om forespørselsbruk og faller tilbake til meldingsmetadata for eldre sesjoner. TUI Context usage estimerer også bruk av instruction, skills, tool definitions, vedlegg, verktøyresultater og compaction summary i kontekstvinduet.

### Verktøysystem

| Verktøy | Forbedring |
| --- | --- |
| Read | Metadata, stub, standard antall leselinjer, bytegrenser, beskyttelse mot enhetsfiler |
| Grep/Ripgrep | Begrenser maksimalt antall filer og resultater, med tydelige feil ved for brede søk |
| Shell | bash, PowerShell og cmd bruker shell-bevisste prompter separat |
| Write | Genererer automatisk en diff ved overskriving av filer, slik at brukere kan bekrefte den faktiske endringen |
| Permission | Tillatelser fra overordnet agent filtreres før de sendes til underoppgaver; tilgjengelighetssjekker for verktøy er strengere |

### Provider Og Modeller

| Kapabilitet | Beskrivelse |
| --- | --- |
| Provider-aliaser | Konfigurer flere kontoer eller endepunkter for samme underliggende provider |
| Klientversjonsoverstyring | Tilpass egendefinerte providere, kompatibilitetsproxyer og spesielle API-endepunkter |
| ClaudeCode provider | Støtter API Key, Base URL og dynamiske autentiseringsmoduser |
| Cloudflare AI Gateway | Rutingsrettinger; tool streaming er deaktivert som standard for ikke-Anthropic-modeller |

### VS Code Notebook-Integrasjon

Før du bruker Notebook-verktøy, installer VS Code-utvidelsen [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). Utvidelsesversjonen forblir `1.15.5` og kan fortsatt fungere med SMARK CLI `1.15.7`; den trenger ingen oppgradering for denne CLI README-oppdateringen. Utvidelsen oppretter en lokal autentisert bridge mellom VS Code/Jupyter Notebook og OpenCode CLI; uten at den er installert eller tilkoblet, kan CLI ikke lese, redigere eller kjøre notebook-celler pålitelig.

Etter oppstart åpner utvidelsen en lokal bridge på `127.0.0.1:<random port>` og skriver et heartbeat-manifest til `~/.local/state/opencode/ide/<uuid>.json`. OpenCode velger automatisk matchende VS Code-bridge etter workspace og notebook-sti. I remote SSH-, WSL- eller containeroppsett må CLI kjøre på samme side som har tilgang til bridgen.

| Verktøy | Formål |
| --- | --- |
| `vscode_notebook_summary` | Hent stabile `#VSC-*`-ID-er, visningsindeks, type, språk, kjøringstilstand, utdatasammendrag, dirty-tilstand og runtime-info for notebook-celler |
| `vscode_notebook_source` | Les notebook-kilde med 1-based globale virtuelle linjenumre; returnert innhold er som standard begrenset til 16KB |
| `vscode_notebook_edit` | Sett inn, rediger eller slett celler; støtter eksakt `oldCode/newCode`-strengerstatning og bytte mellom code/markdown-type |
| `vscode_notebook_run` | Kjør en kodecelle eller et stabil-ID-område gjennom VS Code/Jupyter; områdekjøring stopper ved feil eller timeout |
| `vscode_notebook_output` | Les tekst, bilde, HTML, JSON og andre utdata; store utdata skrives til `.opencode/cache/notebook-outputs/` og returneres som artifact-stier |
| `vscode_notebook_env` | Inspiser kernel/runtime, utløs valg av kernel, start kernel på nytt, eller lagre en notebook når brukeren eksplisitt ber om det |

Anbefalt flyt: bruk `vscode_notebook_summary` for å hente gjeldende celle-ID, `vscode_notebook_source` for å lese målcellen, `vscode_notebook_run` for å validere etter redigering og `vscode_notebook_output` for å inspisere resultater. Ikke behandle visningsindeks `cN` som en stabil langsiktig referanse; etter innsettinger, slettinger eller typebytter bruker du den nye `#VSC-*`-ID-en som returneres av verktøyet, eller kjører summary på nytt.

### Tverrplattformstøtte

| Plattformproblem | Håndtering |
| --- | --- |
| Windows-koding | Auto-detekter UTF-8/UTF-16LE og reparer pipe-mojibake |
| PowerShell | CLIXML-dekoding, stderr-normalisering, UTF-8-utdatareparasjon |
| Stiforskjeller | Normaliser casing, separatorer og globale sesjonsstier |
| Linjeavslutninger | Bevar opprinnelig CRLF/LF-stil når patcher brukes |
| WSL | Vedlikehold migrerings- og tverrplattform-byggveiledninger |

---

## Agenter

OpenCode inkluderer flere innebygde primary agents som kan byttes med `Tab`. Standardagenten kan overstyres med `default_agent`; subagents kalles hovedsakelig via oppgaveutsending eller `@agent`.

| Agent | Type | Tillatelsesmodell | Passer best for |
| --- | --- | --- | --- |
| `build` | primary | Standard utviklingsmodus; kjører verktøy i henhold til konfigurerte tillatelser, tillater spørsmålsbekreftelse og å gå inn i plan | Implementere funksjoner, fikse bugs, kjøre tester, ende-til-ende-levering |
| `interactive` | primary | Mer konservativ interaktiv modus; `bash`, notebook-kjøring og notebook-miljøoperasjoner spør som standard | Oppgaver som trenger bekreftelse for nøkkelkommandoer eller lavere risiko for utilsiktede operasjoner |
| `auto` | primary | Aktivert bare når den velges eksplisitt; `bash`, `edit` og shell-tilgang til eksterne kataloger går inn i auto permission review | Automatisk gjennomgang av shell-/redigeringsrisiko uten å endre standard build-atferd ved et uhell |
| `decide` | primary | Deaktiverer verktøy og gjør en engangsvurdering fra begrenset nylig kontekst | Rimeligere engangsbeslutninger, avveininger og neste-steg-valg med en høyytelsesmodell |
| `plan` | primary | Tillater ikke redigeringsverktøy og notebook-endringer; tillater skriving av planfiler og å avslutte plan | Kodeanalyse, planlegging, risikovurdering, design før kjøring |
| `general` | subagent | Generell subagent; forbyr `todowrite`, ellers følger sammenslått tillatelseskonfigurasjon | Komplekst søk, flertrinns research, paralleliserbare støtteoppgaver |
| `explore` | subagent | Tillater bare søk, lesing, listing, webspørring og lignende utforskningsverktøy | Rask lokalisering av filer, symboler, kallkjeder, config og dokumentasjon |
| `scout` | subagent, experimental | Retter seg mot eksterne dokumenter og kildekode for avhengigheter; tillater lesing fra managed repo cache | Inspisere tredjepartsbibliotekimplementering, klone kildekode for avhengigheter, undersøke ekstern API-atferd |

`title`, `summary` og `compaction` er skjulte systemagenter for tittelgenerering, sammendrag og komprimeringsflyter, ikke mål for daglig manuell bytting. Lær mer om [Agents](https://opencode.ai/docs/agents).

---

## Dokumentasjon

| Ressurs | Lenke |
| --- | --- |
| Offisiell dokumentasjon | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Bidragsveiledning | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## FAQ

### Hvordan er dette annerledes enn Claude Code?

Målet for kapabilitet er lignende, men OpenCode fokuserer på åpen kildekode, terminal-først-bruk, provider-uavhengighet, klient/server-arkitektur og et utvidbart verktøysystem. SMARK-grenen styrker i tillegg Windows/PowerShell, VS Code Notebook, tokensynlighet, nettverksproxy-støtte og installasjonsopplevelsen.

### Hvem er denne grenen for?

Hvis du ofte utvikler i terminalen, trenger etterprøvbar agentatferd, eller bruker AI coding agents i Windows/PowerShell- eller VS Code Notebook-scenarioer, gir denne grenen en mer komplett opplevelse enn upstream-standardene.

### Hvorfor bruker installasjonsprogrammet ikke sudo som standard?

Installasjon på brukernivå er tryggere og enklere å håndtere. Installasjonsprogrammet skriver som standard til en brukerkatalog og avviser implisitt sudo. Bruk bare `sudo env ... --allow-sudo` når du eksplisitt installerer i en systemkatalog som `/usr/local/bin`; vurder også `--no-modify-path` for å unngå at root endrer brukerprofiler.

### Hva om en gammel opencode allerede finnes pa systemet?

Installasjonsprogrammet stoler bare på målinstallasjonsstien. Selv om `/usr/local/bin/opencode` allerede har samme versjon, installerer `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` fortsatt til `~/.local/bin/opencode` og blokkeres ikke av en gammel binær i PATH.

---

## Bidra

Les [bidragsveiledningen](./CONTRIBUTING.md) før du sender en PR. Hvis ditt eget prosjektnavn bruker `opencode`, oppgi i README-en at det ikke er et offisielt OpenCode-teamprosjekt og ikke er tilknyttet OpenCode-teamet.

---

## Fellesskap

**Bli med i fellesskapet vårt** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
