<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="../../packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="../../packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="../../packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">Open Source AI Coding Agent — erweiterter SMARK-Branch</p>
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

> **Über diesen Branch**: Dies ist OpenCodes erweiterter `dev-smark`-Branch (aktuelle Version `1.15.7`, CLI release tag `v1.15.7-smark`). Er basiert auf dem Upstream-Branch `dev` und konzentriert sich auf TUI-Interaktion, Sitzungsverwaltung, Token-Statistiken, Windows/PowerShell-Kompatibilität, VS Code Notebook-Integration, Netzwerkproxy-Unterstützung und Installationserlebnis.

---

## Schnellinstallation

Verwende den Installer von der Release-Seite des SMARK-Branch. Standardmäßig installiert er das neueste Release und schreibt das Installationsverzeichnis in vorhandene Shell-Profile.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Nach der Installation prüfen:

```bash
opencode --version
which opencode
```

Wenn die aktuelle Shell PATH noch nicht aktualisiert hat, öffne das Terminal neu oder source das im Installationslog angezeigte Profil.

### Installationsverzeichnis Angeben

Für Installationen auf Benutzerebene wird `~/.local/bin` empfohlen. Die Umgebungsvariable muss an den `bash`-Prozess übergeben werden, der den Installer ausführt, nicht nur an `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

Zum Troubleshooting lade zuerst das Skript herunter und führe es dann aus:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Schreibe es nicht so:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Das übergibt `OPENCODE_INSTALL_DIR` nur an `curl`, nicht an den `bash`-Prozess, der den Installer tatsächlich ausführt.

### Version Angeben

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

Dies ist die vollständige Form: `bash -s --` weist `bash` an, den Installer von stdin zu lesen und `--version 1.15.7-smark` als Installer-Argumente zu übergeben. Die Version kann `1.15.7-smark` oder in release tag-Form `v1.15.7-smark` lauten.

### Installer-Verhalten

| Szenario | Verhalten |
| --- | --- |
| Standard-Installationsverzeichnis | `$OPENCODE_INSTALL_DIR`, dann `$XDG_BIN_DIR`, dann `$HOME/.opencode/bin` |
| Gleiche Version bereits im Zielpfad | Neu installieren und überschreiben, nützlich zum Auffrischen beschädigter oder veralteter Binärdateien |
| Gleiche Version an anderer Stelle in PATH | Nur einen Hinweis ausgeben; Installation in das angeforderte Verzeichnis nicht blockieren |
| PATH-Schreiben | Standardmäßig alle vorhandenen unterstützten Profile aktualisieren und doppelte Einträge vermeiden |
| sudo | `sudo`-Start standardmäßig ablehnen; Systeminstallationen müssen explizit `--allow-sudo` übergeben |
| macOS quarantine | Nach der Installation versuchen, das Attribut `com.apple.quarantine` zu entfernen |
| checksum | Heruntergeladene Assets prüfen, wenn das Release `checksums.txt` bereitstellt |

### PATH Und Shell-Profile

Der Installer erkennt und aktualisiert vorhandene Profile: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*` und `~/.config/fish/config.fish`.

| Bedarf | Befehl |
| --- | --- |
| PATH nicht ändern | `bash /tmp/opencode-install --no-modify-path` |
| Nur ein Profil schreiben | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Profil interaktiv auswählen | `bash /tmp/opencode-install --interactive` |
| In Systemverzeichnis installieren | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

Wenn `~/.local/bin/opencode` Vorrang vor `/usr/local/bin/opencode` haben soll, stelle sicher, dass dein Profil PATH so sortiert:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Weitere Installationsmethoden

Diese Methoden verwenden das Upstream-Paketmanager-Ökosystem. Wenn du den SMARK-Branch-Build benötigst, bevorzuge den GitHub release installer oben.

| Plattform | Befehl | Hinweise |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | Du kannst auch `bun`, `pnpm` oder `yarn` verwenden |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Upstream tap, normalerweise schnell aktualisiert |
| macOS/Linux | `brew install opencode` | Offizielle Homebrew formula, kann hinterherhinken |
| Windows | `scoop install opencode` | Scoop-Paket |
| Windows | `choco install opencode` | Chocolatey-Paket |
| Arch Linux | `sudo pacman -S opencode` | Stabiles Paket |
| Arch Linux | `paru -S opencode-bin` | Neueste AUR-Binärpaketversion |
| Jedes System | `mise use -g opencode` | Tool-Versionen mit mise verwalten |
| Nix | `nix run nixpkgs#opencode` | Kann auch die Entwicklungsversion von GitHub ausführen |

---

## Schnellstart

```bash
cd <your-project>
opencode
```

Beschreibe nach dem Start direkt eine Aufgabe, zum Beispiel "erkläre die Architektur dieses Moduls", "behebe diesen Fehler" oder "füge Tests für diese Funktion hinzu". In der TUI wechselst du mit `Tab` zwischen Agents und nutzt eingebaute Tools zum Lesen/Schreiben von Dateien, Ausführen von Befehlen, Prüfen von Diffs und Verwalten von Sitzungen.

| Aktion | Beschreibung |
| --- | --- |
| `Tab` | Zwischen verfügbaren Agents wechseln |
| Sitzungsliste | Verlauf anzeigen und Titel sowie Nachrichteninhalt durchsuchen |
| Diff-Vorschau | Änderungen im git diff-Stil vor und nach Dateischreibvorgängen anzeigen |
| Manuelle Komprimierung | Kontext in langen Sitzungen aktiv komprimieren, um Token-Platz freizugeben |
| Shell-Tool | Unterstützt Abbruch, Ausgabekomprimierung und PowerShell-Ausgabenormalisierung |

---

## Desktop-App

Der SMARK `dev-smark`-Branch veröffentlicht derzeit nur CLI-Releases, keine Installer für die Desktop-App. Für die Desktop-App (BETA) gelten [opencode.ai/download](https://opencode.ai/download) und Upstream-Release-Hinweise als Quelle der Wahrheit; behandle die SMARK-CLI-Release-Seite nicht als Quelle für Desktop-Installer.

---

## Kernfunktionen

Dieser Branch ist nicht nur eine Ansammlung von Funktionen; er macht häufige Entwicklungsschmerzpunkte zu beobachtbaren, wiederherstellbaren, plattformübergreifenden Workflows.

| Bereich | Gelöstes Problem | Was Du Sehen Wirst |
| --- | --- | --- |
| TUI-Interaktion | Lange Ausgaben, Streaming-Nachrichten, schwer lesbare Diffs | Live-Rendering, einklappbares Reasoning, Diff-Vorschau, sofortige Statusaktualisierungen |
| Sitzungsverwaltung | Lange Sitzungen verlieren Kontext und sind teuer wiederherzustellen | Sitzungssuche, Pfadfilter, manuelle Komprimierung, Interrupt-Wiederherstellung, Session Warping |
| Token-Statistiken | Schwer zu erkennen, was Kontext verbraucht | Input-/Output-Token, Tool-Ergebnisse, Anhänge, Aufschlüsselungen des Request-Overheads |
| Tool-System | Datei- und Shell-Ausgaben können Kontext verschmutzen | Strukturierte Read-Ausgabe, Shell-Ausgabekomprimierung, Write-Auto-Diff |
| Provider | Multi-Account-, Endpoint- und Modell-Setup ist komplex | Provider-Aliasse, Client-Version-Override, ClaudeCode provider |
| VSCode | Notebook-Szenarien können von CLI-Agents nicht zuverlässig bedient werden | Cell-Zusammenfassung, Lesen, Bearbeiten, Ausführen, Ausgabe lesen, Kernel-Verwaltung |
| Windows | PowerShell, Encoding, Pfade und CRLF sind fehleranfällig | CLIXML-Decoding, UTF-8-Fixes, Pfadnormalisierung, CRLF-Erhaltung |
| Netzwerkproxy | Provider-, Plugin- und fetch-Proxylogik ist verstreut | NetworkProxy behandelt HTTP_PROXY, HTTPS_PROXY, NO_PROXY konsistent |
| Daemon | Multi-Instanzen, Locks, Health Checks und Clients sind komplex | Server Lock, Health Checks, HttpApi, PTY WebSocket-Tickets |

### TUI Und Interaktionserlebnis

| Fähigkeit | Details |
| --- | --- |
| Streaming-Ausgabe | Assistentennachrichten und Reasoning-Chunks werden inkrementell gerendert, während des Streamings wird die verstrichene Zeit angezeigt |
| Reasoning-Anzeige | Langes Reasoning kann eingeklappt werden, um Bildschirmfläche zu sparen |
| Diff-Vorschau | Dateiüberschreibungen erzeugen automatisch eine Ansicht im git diff-Stil mit Anzahl hinzugefügter/gelöschter Zeilen |
| Sitzungsliste | Zeigt Zusammenfassungen neuerer Nachrichten und unterstützt Suche nach Titel und Nachrichteninhalt |
| Layout-Stabilität | Zuverlässigere Scrollbars, Terminalbreitenbehandlung und CJK-Zeichenbreitenbehandlung |
| Shell-Modus | Bietet Abbrechen-Button, eigenes Icon, Beispiel-Platzhalter und Live-Abschlussstatus |

### Sitzungs- Und Kontextverwaltung

| Fähigkeit | Details |
| --- | --- |
| Sitzungswiederherstellung | Versteckte Nachrichten, Undo-Operationen, Pending-Message-Prüfungen und Fehlerwiederherstellung sind robuster |
| Interrupt-Steuerung | Zeichnet Interrupt-Zähler und Bestätigungszeit auf; Interrupts der übergeordneten Sitzung werden an Subtasks weitergegeben |
| Pfadkompatibilität | Globale Windows-Sitzungspfade werden normalisiert; Sitzungsspeicher verwendet relative Pfade |
| Manuelle Komprimierung | Benutzer können Komprimierung auslösen; die Komprimierungsauswahl ist asynchron und meldet Fehler |
| Git-Kontext | Injiziert automatisch aktuellen Branch, Status, letzte Commits und verwandte Daten mit einem Config-Schalter |

### Token- Und Kostensichtbarkeit

| Einstieg | Nutzung | Anzeige |
| --- | --- | --- |
| TUI Context usage | In einer Sitzung `/context` ausführen oder `Context usage` aus der Command Palette wählen | Zeigt aktuelles Kontextfenster, Modell, verwendete/verfügbare Token und Prompt/Conversation/Window-Kategorieraster |
| Context usage footer | Unten im TUI-Panel | Mit Sitzungsnutzung werden `Input`, `Output`, `Reason`, `Cache W/R`, `Cost` angezeigt; ohne kumulative Nutzung `Used`, `Free`, `Usable`, `Buffer` |
| Kostenspalte der Sitzungsliste | `opencode session list --cost` oder `opencode session list -c` | Fügt der session list die Spalten `Cost` und `Tokens` hinzu, um Kosten-Hotspots schnell zu finden |
| Einzelsitzungsdetails | `opencode session info -s <Session_ID>` | Zeigt `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` nach provider/model |
| Globale Statistiken | `opencode stats --models` | Fasst Gesamtkosten, tägliche Durchschnittskosten, durchschnittliche Token, Tool-Nutzung und Modellnutzung zusammen |

Interne Statistiken bevorzugen request usage-Daten und fallen für ältere Sitzungen auf Nachrichtenmetadaten zurück. TUI Context usage schätzt außerdem instruction, skills, tool definitions, Anhänge, Tool-Ergebnisse und compaction summary-Nutzung im Kontextfenster.

### Tool-System

| Tool | Verbesserung |
| --- | --- |
| Read | Metadaten, stub, Standard-Lesezeilenzahl, Byte-Limits, Schutz vor Gerätedateien |
| Grep/Ripgrep | Begrenzt maximale Datei- und Ergebniszahlen, mit klaren Fehlern bei zu breiten Suchen |
| Shell | bash, PowerShell und cmd verwenden jeweils shell-bewusste Prompts |
| Write | Erzeugt beim Überschreiben von Dateien automatisch einen Diff, damit Benutzer die tatsächliche Änderung bestätigen können |
| Permission | Parent-agent permissions werden vor Weitergabe an Subtasks gefiltert; Tool-Verfügbarkeitsprüfungen sind strenger |

### Provider Und Modelle

| Fähigkeit | Beschreibung |
| --- | --- |
| Provider-Aliasse | Mehrere Konten oder Endpunkte für denselben zugrunde liegenden provider konfigurieren |
| Client-Version-Override | Custom provider, Kompatibilitätsproxys und spezielle API-Endpunkte anpassen |
| ClaudeCode provider | Unterstützt API Key, Base URL und dynamische Authentifizierungsmodi |
| Cloudflare AI Gateway | Routing-Fixes; tool streaming ist für Nicht-Anthropic-Modelle standardmäßig deaktiviert |

### VS Code Notebook-Integration

Installiere vor der Nutzung von Notebook-Tools die VS Code-Erweiterung [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). Die Erweiterungsversion bleibt `1.15.5` und kann weiterhin mit SMARK CLI `1.15.7` arbeiten; für dieses CLI-README-Update ist kein Upgrade erforderlich. Die Erweiterung erstellt eine lokale authentifizierte Bridge zwischen VS Code/Jupyter Notebook und der OpenCode CLI; ohne installierte oder verbundene Erweiterung kann die CLI Notebook-Zellen nicht zuverlässig lesen, bearbeiten oder ausführen.

Nach dem Start öffnet die Erweiterung eine lokale Bridge auf `127.0.0.1:<random port>` und schreibt ein Heartbeat-Manifest nach `~/.local/state/opencode/ide/<uuid>.json`. OpenCode wählt automatisch die passende VS Code bridge anhand von Workspace und Notebook-Pfad aus. In Remote-SSH-, WSL- oder Container-Setups muss die CLI auf derselben Seite laufen, die auf die Bridge zugreifen kann.

| Tool | Zweck |
| --- | --- |
| `vscode_notebook_summary` | Stabile `#VSC-*` IDs, Anzeigeindex, Typ, Sprache, Ausführungszustand, Ausgabezusammenfassung, dirty state und Runtime-Info für Notebook-Zellen abrufen |
| `vscode_notebook_source` | Notebook-Quellcode mit 1-based global virtual line numbers lesen; zurückgegebener Inhalt ist standardmäßig auf 16KB begrenzt |
| `vscode_notebook_edit` | Zellen einfügen, bearbeiten oder löschen; unterstützt exakte `oldCode/newCode`-Stringersetzung und code/markdown-Typwechsel |
| `vscode_notebook_run` | Eine Code-Zelle oder einen Stable-ID-Bereich über VS Code/Jupyter ausführen; Bereichsausführung stoppt bei Fehler oder Timeout |
| `vscode_notebook_output` | Text, Bilder, HTML, JSON und andere Ausgaben lesen; große Ausgaben werden nach `.opencode/cache/notebook-outputs/` geschrieben und als Artifact-Pfade zurückgegeben |
| `vscode_notebook_env` | Kernel/Runtime inspizieren, Kernel-Auswahl auslösen, Kernel neu starten oder ein Notebook speichern, wenn der Benutzer dies ausdrücklich verlangt |

Empfohlener Ablauf: Nutze `vscode_notebook_summary`, um die aktuelle Cell-ID zu erhalten, `vscode_notebook_source`, um die Zielzelle zu lesen, `vscode_notebook_run`, um nach der Bearbeitung zu validieren, und `vscode_notebook_output`, um Ergebnisse zu prüfen. Behandle den Anzeigeindex `cN` nicht als langfristig stabile Referenz; verwende nach Einfügungen, Löschungen oder Typwechseln die vom Tool zurückgegebene neue `#VSC-*` ID oder führe summary erneut aus.

### Plattformübergreifende Unterstützung

| Plattformproblem | Behandlung |
| --- | --- |
| Windows encoding | UTF-8/UTF-16LE automatisch erkennen und Pipe-Mojibake reparieren |
| PowerShell | CLIXML-Decoding, stderr-Normalisierung, UTF-8-Ausgabereparatur |
| Pfadunterschiede | Groß-/Kleinschreibung, Separatoren und globale Sitzungspfade normalisieren |
| Zeilenenden | Ursprünglichen CRLF/LF-Stil beim Anwenden von Patches erhalten |
| WSL | Migrations- und plattformübergreifende Build-Guides pflegen |

---

## Agents

OpenCode enthält mehrere eingebaute primary agents, zwischen denen mit `Tab` gewechselt werden kann. Der Standard-agent kann mit `default_agent` überschrieben werden; subagents werden hauptsächlich durch Task-Dispatch oder `@agent` aufgerufen.

| Agent | Typ | Berechtigungsmodell | Am Besten Für |
| --- | --- | --- | --- |
| `build` | primary | Standard-Entwicklungsmodus; führt Tools gemäß konfigurierten Berechtigungen aus, erlaubt Fragenbestätigung und Wechsel in plan | Funktionen implementieren, Bugs beheben, Tests ausführen, End-to-End-Lieferung |
| `interactive` | primary | Konservativerer interaktiver Modus; `bash`, Notebook-Ausführung und Notebook-Umgebungsoperationen fragen standardmäßig nach | Aufgaben, die Bestätigung für wichtige Befehle oder geringeres Risiko versehentlicher Aktionen benötigen |
| `auto` | primary | Nur bei expliziter Auswahl aktiviert; `bash`, `edit` und Shell-Zugriff auf externe Verzeichnisse gehen in auto permission review | Shell-/Edit-Risiko automatisch prüfen, ohne versehentlich das Standard-build-Verhalten zu ändern |
| `decide` | primary | Deaktiviert Tools und trifft eine einmalige Entscheidung aus begrenztem aktuellem Kontext | Kostengünstigere Einmalentscheidungen, Tradeoffs und nächste Schritte mit einem leistungsstarken Modell |
| `plan` | primary | Verbietet Edit-Tools und Notebook-Änderungen; erlaubt Schreiben von Plan-Dateien und Verlassen von plan | Codeanalyse, Planung, Risikoprüfung, Entwurf vor Ausführung |
| `general` | subagent | Allgemeiner subagent; verbietet `todowrite`, folgt sonst der zusammengeführten Berechtigungskonfiguration | Komplexe Suche, mehrstufige Recherche, parallelisierbare Unterstützungsaufgaben |
| `explore` | subagent | Erlaubt nur Suche, Lesen, Auflisten, Web-Abfragen und ähnliche Explorationstools | Dateien, Symbole, Aufrufketten, Config und Docs schnell lokalisieren |
| `scout` | subagent, experimental | Zielt auf externe Docs und Dependency-Quellcode; erlaubt verwaltete Repo-Cache-Lesezugriffe | Third-party library implementation prüfen, Dependency-Quellcode klonen, externes API-Verhalten recherchieren |

`title`, `summary` und `compaction` sind versteckte System-Agents für Titelgenerierung, Zusammenfassungen und Komprimierungsflows, keine Ziele für den täglichen manuellen Wechsel. Mehr dazu unter [Agents](https://opencode.ai/docs/agents).

---

## Dokumentation

| Ressource | Link |
| --- | --- |
| Offizielle Docs | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Beitragsleitfaden | [CONTRIBUTING.md](../../CONTRIBUTING.md) |

---

## FAQ

### Worin unterscheidet sich das von Claude Code?

Das Ziel bei den Fähigkeiten ist ähnlich, aber OpenCode konzentriert sich auf Open Source, terminal-first-Nutzung, Provider-Unabhängigkeit, Client/Server-Architektur und ein erweiterbares Tool-System. Der SMARK-Branch stärkt zusätzlich Windows/PowerShell, VS Code Notebook, Token-Sichtbarkeit, Netzwerkproxy-Unterstützung und Installationserlebnis.

### Für wen ist dieser Branch gedacht?

Wenn du häufig im Terminal entwickelst, auditierbares Agent-Verhalten benötigst oder AI Coding Agents in Windows/PowerShell- oder VS Code Notebook-Szenarien nutzt, bietet dieser Branch eine vollständigere Erfahrung als Upstream-Standards.

### Warum nutzt der Installer nicht standardmäßig sudo?

Installation auf Benutzerebene ist sicherer und einfacher zu verwalten. Der Installer schreibt standardmäßig in ein Benutzerverzeichnis und lehnt implizites sudo ab. Nutze `sudo env ... --allow-sudo` nur, wenn du ausdrücklich in ein Systemverzeichnis wie `/usr/local/bin` installierst; erwäge außerdem `--no-modify-path`, damit root keine Benutzerprofile verändert.

### Was, wenn bereits ein altes opencode auf dem System existiert?

Der Installer vertraut nur dem Ziel-Installationspfad. Selbst wenn `/usr/local/bin/opencode` bereits dieselbe Version hat, installiert `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` weiterhin nach `~/.local/bin/opencode` und wird nicht durch eine alte Binärdatei in PATH blockiert.

---

## Beitragen

Lies den [Beitragsleitfaden](../../CONTRIBUTING.md), bevor du einen PR einreichst. Wenn dein eigenes Projekt `opencode` im Namen verwendet, vermerke in seiner README, dass es kein offizielles Projekt des OpenCode-Teams ist und nicht mit dem OpenCode-Team verbunden ist.

---

## Community

**Tritt unserer Community bei** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
