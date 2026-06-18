<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="../../packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="../../packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="../../packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">Agente di coding AI open source — ramo potenziato SMARK</p>
<p align="center">
  <a href="https://github.com/anomalyco/opencode/tree/dev"><img alt="Upstream dev branch" src="https://img.shields.io/badge/upstream-dev-6b7280?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="Upstream npm version" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square&label=upstream%20npm" /></a>
  <a href="https://github.com/SMARK2022/opencode/tree/dev-smark"><img alt="SMARK branch" src="https://img.shields.io/badge/SMARK%20branch-dev--smark-0969da?style=flat-square" /></a>
  <a href="https://github.com/SMARK2022/opencode/releases"><img alt="Current SMARK version" src="https://img.shields.io/badge/current-1.15.7-f97316?style=flat-square" /></a>
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

> **Informazioni su questo ramo**: questo è il ramo potenziato `dev-smark` di OpenCode (versione corrente `1.15.7`, tag di release CLI `v1.15.7-smark`). È basato sul ramo upstream `dev` e si concentra su interazione TUI, gestione delle sessioni, statistiche sui token, compatibilità Windows/PowerShell, integrazione VS Code Notebook, supporto proxy di rete ed esperienza di installazione.

---

## Installazione Rapida

Usa l'installer dalla pagina delle release del ramo SMARK. Per impostazione predefinita installa l'ultima release e scrive la directory di installazione nei profili shell esistenti.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Verifica dopo l'installazione:

```bash
opencode --version
which opencode
```

Se la shell corrente non ha ancora aggiornato PATH, riapri il terminale o esegui il source del profilo indicato nel log di installazione.

### Specificare La Directory Di Installazione

Le installazioni a livello utente sono consigliate in `~/.local/bin`. La variabile di ambiente deve essere passata al processo `bash` che esegue l'installer, non solo a `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

Per la risoluzione dei problemi, scarica prima lo script e poi eseguilo:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Non scriverlo in questo modo:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Questo passa `OPENCODE_INSTALL_DIR` solo a `curl`, non al processo `bash` che esegue davvero l'installer.

### Specificare La Versione

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

Questa è la forma completa: `bash -s --` dice a `bash` di leggere l'installer da stdin e di passare `--version 1.15.7-smark` come argomenti dell'installer. La versione può essere `1.15.7-smark` oppure la forma del tag di release `v1.15.7-smark`.

### Comportamento Dell'Installer

| Scenario | Comportamento |
| --- | --- |
| Directory di installazione predefinita | `$OPENCODE_INSTALL_DIR`, poi `$XDG_BIN_DIR`, poi `$HOME/.opencode/bin` |
| Stessa versione già nel percorso di destinazione | Reinstalla e sovrascrive, utile per aggiornare binari danneggiati o obsoleti |
| Stessa versione altrove in PATH | Stampa solo un avviso; non blocca l'installazione nella directory richiesta |
| Scrittura PATH | Per impostazione predefinita aggiorna tutti i profili supportati esistenti ed evita voci duplicate |
| sudo | Rifiuta l'avvio con `sudo` per impostazione predefinita; le installazioni di sistema devono passare esplicitamente `--allow-sudo` |
| macOS quarantine | Prova a rimuovere l'attributo `com.apple.quarantine` dopo l'installazione |
| checksum | Verifica gli asset scaricati quando la release fornisce `checksums.txt` |

### PATH E Profili Shell

L'installer rileva e aggiorna i profili esistenti: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*` e `~/.config/fish/config.fish`.

| Esigenza | Comando |
| --- | --- |
| Non modificare PATH | `bash /tmp/opencode-install --no-modify-path` |
| Scrivere un solo profilo | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Scegliere il profilo in modo interattivo | `bash /tmp/opencode-install --interactive` |
| Installare in una directory di sistema | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

Se vuoi che `~/.local/bin/opencode` abbia priorità su `/usr/local/bin/opencode`, assicurati che il tuo profilo ordini PATH così:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Altri Metodi Di Installazione

Questi metodi usano l'ecosistema upstream dei package manager. Se ti serve la build del ramo SMARK, preferisci l'installer GitHub release qui sopra.

| Piattaforma | Comando | Note |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | Puoi usare anche `bun`, `pnpm` o `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Tap upstream, di solito aggiornato rapidamente |
| macOS/Linux | `brew install opencode` | Formula Homebrew ufficiale, può essere in ritardo |
| Windows | `scoop install opencode` | Pacchetto Scoop |
| Windows | `choco install opencode` | Pacchetto Chocolatey |
| Arch Linux | `sudo pacman -S opencode` | Pacchetto stabile |
| Arch Linux | `paru -S opencode-bin` | Ultimo pacchetto binario AUR |
| Qualsiasi sistema | `mise use -g opencode` | Gestisci versioni degli strumenti con mise |
| Nix | `nix run nixpkgs#opencode` | Può anche eseguire la versione di sviluppo da GitHub |

---

## Avvio Rapido

```bash
cd <your-project>
opencode
```

Dopo l'avvio, descrivi direttamente un'attività, per esempio "spiega l'architettura di questo modulo", "correggi questo errore" o "aggiungi test per questa funzionalità". Nella TUI, usa `Tab` per passare da un agente all'altro e usa gli strumenti integrati per leggere/scrivere file, eseguire comandi, ispezionare diff e gestire sessioni.

| Azione | Descrizione |
| --- | --- |
| `Tab` | Passa tra gli agenti disponibili |
| Elenco sessioni | Visualizza cronologia e cerca nei titoli e nel contenuto dei messaggi |
| Anteprima diff | Mostra modifiche in stile git diff prima e dopo le scritture dei file |
| Compattazione manuale | Compatta proattivamente il contesto nelle sessioni lunghe per liberare spazio token |
| Strumento Shell | Supporta annullamento, compressione dell'output e normalizzazione dell'output PowerShell |

---

## App Desktop

Il ramo SMARK `dev-smark` attualmente pubblica solo release CLI, non installer per l'app desktop. Per l'app desktop (BETA), usa [opencode.ai/download](https://opencode.ai/download) e le note di release upstream come fonte di verità; non trattare la pagina delle release CLI SMARK come fonte di installer desktop.

---

## Funzionalità Principali

Questo ramo non è solo un insieme di funzionalità; trasforma punti dolenti comuni dello sviluppo in workflow osservabili, recuperabili e multipiattaforma.

| Area | Problema Risolto | Cosa Vedrai |
| --- | --- | --- |
| Interazione TUI | Output lunghi, messaggi in streaming, diff difficili da leggere | Rendering live, ragionamento comprimibile, anteprima diff, aggiornamenti di stato immediati |
| Gestione sessioni | Le sessioni lunghe perdono contesto e sono costose da recuperare | Ricerca sessioni, filtri per percorso, compattazione manuale, recupero da interruzione, Session Warping |
| Statistiche token | Difficile sapere cosa consuma il contesto | Token input/output, risultati degli strumenti, allegati, suddivisioni dell'overhead della richiesta |
| Sistema strumenti | Output di file e shell possono inquinare il contesto | Output Read strutturato, compressione output Shell, diff automatico Write |
| Provider | Configurare più account, endpoint e modelli è complesso | Alias provider, override versione client, ClaudeCode provider |
| VSCode | Gli scenari Notebook non possono essere gestiti in modo affidabile dagli agenti CLI | Riepilogo, lettura, modifica, esecuzione, lettura output e gestione kernel delle celle |
| Windows | PowerShell, encoding, percorsi e CRLF sono soggetti a errori | Decodifica CLIXML, correzioni UTF-8, normalizzazione percorsi, preservazione CRLF |
| Proxy di rete | La logica proxy di provider, plugin e fetch è dispersa | NetworkProxy gestisce HTTP_PROXY, HTTPS_PROXY, NO_PROXY in modo coerente |
| Daemon | Multi-istanza, lock, health check e client sono complessi | Server Lock, health check, HttpApi, ticket PTY WebSocket |

### Esperienza TUI E Interazione

| Capacità | Dettagli |
| --- | --- |
| Output in streaming | I messaggi dell'assistente e i frammenti di ragionamento vengono renderizzati progressivamente, con tempo trascorso mostrato durante lo streaming |
| Visualizzazione del ragionamento | Il ragionamento lungo può essere compresso per ridurre l'uso dello schermo |
| Anteprima diff | Le sovrascritture dei file generano automaticamente una vista in stile git diff con conteggi di righe aggiunte/eliminate |
| Elenco sessioni | Mostra riepiloghi dei messaggi recenti e supporta la ricerca per titolo e contenuto messaggio |
| Stabilità layout | Gestione più affidabile di barre di scorrimento, larghezza terminale e larghezza dei caratteri CJK |
| Modalità Shell | Fornisce pulsante di annullamento, icona personalizzata, placeholder di esempio e stato di completamento live |

### Gestione Sessioni E Contesto

| Capacità | Dettagli |
| --- | --- |
| Recupero sessione | Messaggi nascosti, operazioni undo, controlli sui messaggi pendenti e recupero errori sono più robusti |
| Controllo interruzioni | Registra conteggi delle interruzioni e ora di conferma; le interruzioni della sessione padre si propagano ai sotto-task |
| Compatibilità percorsi | I percorsi globali delle sessioni Windows sono normalizzati; l'archiviazione delle sessioni usa percorsi relativi |
| Compattazione manuale | Gli utenti possono attivare la compattazione; la selezione della compattazione è asincrona e segnala errori |
| Contesto Git | Inietta automaticamente ramo corrente, stato, commit recenti e dati correlati con uno switch di configurazione |

### Visibilità Token E Costi

| Voce | Uso | Visualizzazione |
| --- | --- | --- |
| TUI Context usage | Esegui `/context` in una sessione o scegli `Context usage` dalla palette dei comandi | Mostra finestra di contesto corrente, modello, token usati/disponibili e griglia delle categorie Prompt/Conversation/Window |
| Context usage footer | Parte inferiore del pannello TUI | Con uso sessione mostra `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`; senza uso cumulativo mostra `Used`, `Free`, `Usable`, `Buffer` |
| Colonna costo elenco sessioni | `opencode session list --cost` o `opencode session list -c` | Aggiunge colonne `Cost` e `Tokens` all'elenco sessioni per trovare rapidamente hotspot di costo |
| Dettagli singola sessione | `opencode session info -s <Session_ID>` | Mostra `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` per provider/model |
| Statistiche globali | `opencode stats --models` | Riassume costo totale, costo medio giornaliero, token medi, uso strumenti e uso modelli |

Le statistiche interne preferiscono i dati di request usage e ripiegano sui metadati dei messaggi per le sessioni più vecchie. TUI Context usage stima anche l'uso nella finestra di contesto di instruction, skills, tool definitions, allegati, risultati strumenti e compaction summary.

### Sistema Strumenti

| Strumento | Miglioramento |
| --- | --- |
| Read | Metadati, stub, conteggio righe di lettura predefinito, limiti byte, protezione file dispositivo |
| Grep/Ripgrep | Limita file massimi e conteggi risultati, con errori chiari per ricerche troppo ampie |
| Shell | bash, PowerShell e cmd usano prompt shell-aware separati |
| Write | Genera automaticamente un diff quando sovrascrive file, così gli utenti possono confermare la modifica effettiva |
| Permission | I permessi dell'agente padre vengono filtrati prima di passarli ai sotto-task; i controlli di disponibilità strumenti sono più severi |

### Provider E Modelli

| Capacità | Descrizione |
| --- | --- |
| Alias provider | Configura più account o endpoint per lo stesso provider sottostante |
| Override versione client | Adatta provider personalizzati, proxy di compatibilità ed endpoint API speciali |
| ClaudeCode provider | Supporta API Key, Base URL e modalità di autenticazione dinamiche |
| Cloudflare AI Gateway | Correzioni di routing; lo streaming degli strumenti è disattivato per impostazione predefinita per i modelli non Anthropic |

### Integrazione VS Code Notebook

Prima di usare gli strumenti Notebook, installa l'estensione VS Code [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). La versione dell'estensione resta `1.15.5` e può continuare a funzionare con SMARK CLI `1.15.7`; non richiede un upgrade per questo aggiornamento del README CLI. L'estensione crea un bridge locale autenticato tra VS Code/Jupyter Notebook e OpenCode CLI; senza installazione o connessione, la CLI non può leggere, modificare o eseguire celle notebook in modo affidabile.

Dopo l'avvio, l'estensione apre un bridge locale su `127.0.0.1:<random port>` e scrive un manifest heartbeat in `~/.local/state/opencode/ide/<uuid>.json`. OpenCode seleziona automaticamente il bridge VS Code corrispondente per workspace e percorso notebook. In configurazioni remote SSH, WSL o container, la CLI deve essere eseguita dallo stesso lato che può accedere al bridge.

| Strumento | Scopo |
| --- | --- |
| `vscode_notebook_summary` | Ottiene ID stabili `#VSC-*`, indice visualizzato, tipo, linguaggio, stato di esecuzione, riepilogo output, stato dirty e informazioni runtime per le celle notebook |
| `vscode_notebook_source` | Legge il sorgente notebook con numeri di riga virtuali globali 1-based; il contenuto restituito è limitato a 16KB per impostazione predefinita |
| `vscode_notebook_edit` | Inserisce, modifica o elimina celle; supporta sostituzione stringa esatta `oldCode/newCode` e cambio tipo code/markdown |
| `vscode_notebook_run` | Esegue una cella codice o un intervallo con ID stabile tramite VS Code/Jupyter; l'esecuzione dell'intervallo si ferma in caso di errore o timeout |
| `vscode_notebook_output` | Legge testo, immagini, HTML, JSON e altri output; gli output grandi vengono scritti in `.opencode/cache/notebook-outputs/` e restituiti come percorsi artifact |
| `vscode_notebook_env` | Ispeziona kernel/runtime, attiva la selezione kernel, riavvia il kernel o salva un notebook quando richiesto esplicitamente dall'utente |

Flusso consigliato: usa `vscode_notebook_summary` per ottenere l'ID cella corrente, `vscode_notebook_source` per leggere la cella target, `vscode_notebook_run` per validare dopo la modifica e `vscode_notebook_output` per ispezionare i risultati. Non trattare l'indice visualizzato `cN` come riferimento stabile a lungo termine; dopo inserimenti, eliminazioni o cambi di tipo, usa il nuovo ID `#VSC-*` restituito dallo strumento o esegui di nuovo summary.

### Supporto Multipiattaforma

| Problema Piattaforma | Gestione |
| --- | --- |
| Encoding Windows | Rileva automaticamente UTF-8/UTF-16LE e ripara mojibake da pipe |
| PowerShell | Decodifica CLIXML, normalizzazione stderr, riparazione output UTF-8 |
| Differenze percorsi | Normalizza maiuscole/minuscole, separatori e percorsi globali delle sessioni |
| Terminatori di riga | Preserva lo stile originale CRLF/LF quando applica patch |
| WSL | Mantiene guide di migrazione e build multipiattaforma |

---

## Agents

OpenCode include più agenti primari integrati che possono essere cambiati con `Tab`. L'agente predefinito può essere sovrascritto con `default_agent`; i subagent vengono invocati principalmente tramite dispatch delle attività o `@agent`.

| Agent | Tipo | Modello Di Permessi | Ideale Per |
| --- | --- | --- | --- |
| `build` | primary | Modalità di sviluppo predefinita; esegue strumenti secondo i permessi configurati, permette conferma tramite domande ed entrata in plan | Implementare funzionalità, correggere bug, eseguire test, consegna end-to-end |
| `interactive` | primary | Modalità interattiva più conservativa; `bash`, esecuzione notebook e operazioni ambiente notebook chiedono conferma per impostazione predefinita | Attività che richiedono conferma per comandi chiave o minor rischio di operazioni accidentali |
| `auto` | primary | Abilitato solo quando selezionato esplicitamente; `bash`, `edit` e accesso shell a directory esterne entrano in auto permission review | Revisione automatica del rischio shell/edit senza modificare accidentalmente il comportamento build predefinito |
| `decide` | primary | Disabilita gli strumenti e produce un giudizio una tantum da contesto recente limitato | Decisioni una tantum a costo inferiore, tradeoff e scelte del prossimo passo con un modello ad alte prestazioni |
| `plan` | primary | Non permette strumenti di modifica e cambi notebook; permette di scrivere file plan e uscire da plan | Analisi codice, pianificazione, revisione rischi, progettazione prima dell'esecuzione |
| `general` | subagent | Subagent generale; vieta `todowrite`, per il resto segue la configurazione permessi unificata | Ricerca complessa, studio multi-step, attività di supporto parallelizzabili |
| `explore` | subagent | Permette solo ricerca, lettura, elenco, query web e strumenti di esplorazione simili | Localizzare rapidamente file, simboli, catene di chiamate, configurazione e documentazione |
| `scout` | subagent, experimental | Mira a documentazione esterna e sorgente delle dipendenze; permette letture della cache repo gestita | Ispezionare implementazioni di librerie terze, clonare sorgente dipendenze, studiare comportamento API esterne |

`title`, `summary` e `compaction` sono agenti di sistema nascosti per generazione titoli, riepiloghi e flussi di compattazione, non target quotidiani per cambio manuale. Scopri di più sugli [Agents](https://opencode.ai/docs/agents).

---

## Documentazione

| Risorsa | Link |
| --- | --- |
| Documentazione ufficiale | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Guida alla contribuzione | [CONTRIBUTING.md](../../CONTRIBUTING.md) |

---

## FAQ

### In cosa è diverso da Claude Code?

L'obiettivo di capacità è simile, ma OpenCode si concentra su open source, uso terminal-first, indipendenza dai provider, architettura client/server e un sistema di strumenti estensibile. Il ramo SMARK rafforza ulteriormente Windows/PowerShell, VS Code Notebook, visibilità token, supporto proxy di rete ed esperienza di installazione.

### Per chi è questo ramo?

Se sviluppi spesso nel terminale, hai bisogno di comportamento dell'agente verificabile o usi agenti di coding AI in scenari Windows/PowerShell o VS Code Notebook, questo ramo offre un'esperienza più completa rispetto ai default upstream.

### Perché l'installer non usa sudo per impostazione predefinita?

L'installazione a livello utente è più sicura e più facile da gestire. L'installer scrive in una directory utente per impostazione predefinita e rifiuta sudo implicito. Usa `sudo env ... --allow-sudo` solo quando installi esplicitamente in una directory di sistema come `/usr/local/bin`; considera anche `--no-modify-path` per evitare che root modifichi profili utente.

### Cosa succede se nel sistema esiste già un vecchio opencode?

L'installer considera affidabile solo il percorso di installazione target. Anche se `/usr/local/bin/opencode` ha già la stessa versione, specificare `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` installa comunque in `~/.local/bin/opencode` e non viene bloccato da un vecchio binario in PATH.

---

## Contribuire

Leggi la [guida alla contribuzione](../../CONTRIBUTING.md) prima di inviare una PR. Se il nome del tuo progetto usa `opencode`, dichiara nel suo README che non è un progetto ufficiale del team OpenCode e non è affiliato al team OpenCode.

---

## Community

**Unisciti alla nostra community** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
