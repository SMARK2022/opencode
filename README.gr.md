<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">Open source AI Coding Agent - ενισχυμένος κλάδος SMARK</p>
<p align="center">
  <a href="https://github.com/anomalyco/opencode/tree/dev"><img alt="Upstream dev branch" src="https://img.shields.io/badge/upstream-dev-6b7280?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/opencode-ai"><img alt="Upstream npm version" src="https://img.shields.io/npm/v/opencode-ai?style=flat-square&label=upstream%20npm" /></a>
  <a href="https://github.com/SMARK2022/opencode/tree/dev-smark"><img alt="SMARK branch" src="https://img.shields.io/badge/SMARK%20branch-dev--smark-0969da?style=flat-square" /></a>
  <a href="https://github.com/SMARK2022/opencode/releases"><img alt="Current SMARK version" src="https://img.shields.io/badge/current-1.15.6-f97316?style=flat-square" /></a>
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

> **Σχετικά με αυτόν τον κλάδο**: Αυτός είναι ο ενισχυμένος κλάδος `dev-smark` του OpenCode (τρέχουσα έκδοση `1.15.6`, CLI release tag `v1.15.6-smark`). Βασίζεται στον upstream κλάδο `dev` και εστιάζει στην αλληλεπίδραση TUI, στη διαχείριση συνεδριών, στα στατιστικά token, στη συμβατότητα Windows/PowerShell, στην ενσωμάτωση VS Code Notebook, στην υποστήριξη network proxy και στην εμπειρία εγκατάστασης.

---

## Γρήγορη Εγκατάσταση

Χρησιμοποιήστε τον installer από τη σελίδα releases του κλάδου SMARK. Από προεπιλογή εγκαθιστά το πιο πρόσφατο release και γράφει τον κατάλογο εγκατάστασης στα υπάρχοντα shell profiles.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Επαληθεύστε μετά την εγκατάσταση:

```bash
opencode --version
which opencode
```

Αν το τρέχον shell δεν έχει ανανεώσει το PATH, ανοίξτε ξανά το terminal ή κάντε source το profile που εμφανίζεται στο install log.

### Καθορισμός Καταλόγου Εγκατάστασης

Οι εγκαταστάσεις σε επίπεδο χρήστη συνιστώνται στο `~/.local/bin`. Η μεταβλητή περιβάλλοντος πρέπει να περαστεί στη διεργασία `bash` που εκτελεί τον installer, όχι μόνο στο `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

Για αντιμετώπιση προβλημάτων, κατεβάστε πρώτα το script και μετά εκτελέστε το:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Μην το γράφετε με αυτόν τον τρόπο:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Αυτό περνά το `OPENCODE_INSTALL_DIR` μόνο στο `curl`, όχι στη διεργασία `bash` που εκτελεί πραγματικά τον installer.

### Καθορισμός Έκδοσης

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.6-smark
```

Αυτή είναι η πλήρης μορφή: το `bash -s --` λέει στο `bash` να διαβάσει τον installer από stdin και να περάσει το `--version 1.15.6-smark` ως ορίσματα installer. Η έκδοση μπορεί να είναι `1.15.6-smark` ή η μορφή release tag `v1.15.6-smark`.

### Συμπεριφορά Installer

| Σενάριο | Συμπεριφορά |
| --- | --- |
| Προεπιλεγμένος κατάλογος εγκατάστασης | `$OPENCODE_INSTALL_DIR`, μετά `$XDG_BIN_DIR`, μετά `$HOME/.opencode/bin` |
| Ίδια έκδοση ήδη στη διαδρομή στόχο | Επανεγκατάσταση και αντικατάσταση, χρήσιμο για ανανέωση κατεστραμμένων ή παρωχημένων binaries |
| Ίδια έκδοση αλλού στο PATH | Εκτύπωση ειδοποίησης μόνο, χωρίς αποκλεισμό εγκατάστασης στον ζητούμενο κατάλογο |
| Εγγραφή PATH | Από προεπιλογή ενημέρωση όλων των υπαρχόντων υποστηριζόμενων profiles και αποφυγή διπλών εγγραφών |
| sudo | Άρνηση εκκίνησης με `sudo` από προεπιλογή. Οι εγκαταστάσεις συστήματος πρέπει να περάσουν ρητά `--allow-sudo` |
| macOS quarantine | Προσπάθεια αφαίρεσης του attribute `com.apple.quarantine` μετά την εγκατάσταση |
| checksum | Επαλήθευση downloaded assets όταν το release παρέχει `checksums.txt` |

### PATH Και Shell Profiles

Ο installer ανιχνεύει και ενημερώνει υπάρχοντα profiles: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*`, και `~/.config/fish/config.fish`.

| Ανάγκη | Εντολή |
| --- | --- |
| Να μην τροποποιηθεί το PATH | `bash /tmp/opencode-install --no-modify-path` |
| Εγγραφή μόνο σε ένα profile | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Διαδραστική επιλογή profile | `bash /tmp/opencode-install --interactive` |
| Εγκατάσταση σε κατάλογο συστήματος | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

Αν θέλετε το `~/.local/bin/opencode` να έχει προτεραιότητα έναντι του `/usr/local/bin/opencode`, βεβαιωθείτε ότι το profile ταξινομεί το PATH έτσι:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Άλλες Μέθοδοι Εγκατάστασης

Αυτές οι μέθοδοι χρησιμοποιούν το upstream οικοσύστημα package managers. Αν χρειάζεστε το build του κλάδου SMARK, προτιμήστε τον GitHub release installer παραπάνω.

| Πλατφόρμα | Εντολή | Σημειώσεις |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | Μπορείτε επίσης να χρησιμοποιήσετε `bun`, `pnpm`, ή `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Upstream tap, συνήθως ενημερώνεται γρήγορα |
| macOS/Linux | `brew install opencode` | Επίσημο Homebrew formula, μπορεί να καθυστερεί |
| Windows | `scoop install opencode` | Scoop package |
| Windows | `choco install opencode` | Chocolatey package |
| Arch Linux | `sudo pacman -S opencode` | Stable package |
| Arch Linux | `paru -S opencode-bin` | Τελευταίο AUR binary package |
| Any system | `mise use -g opencode` | Διαχείριση εκδόσεων εργαλείων με mise |
| Nix | `nix run nixpkgs#opencode` | Μπορεί επίσης να τρέξει την development έκδοση από GitHub |

---

## Γρήγορη Εκκίνηση

```bash
cd <your-project>
opencode
```

Μετά την εκκίνηση, περιγράψτε απευθείας μια εργασία, όπως "explain this module architecture", "fix this error", ή "add tests for this feature". Στο TUI, χρησιμοποιήστε `Tab` για εναλλαγή agents και χρησιμοποιήστε τα ενσωματωμένα εργαλεία για ανάγνωση/εγγραφή αρχείων, εκτέλεση εντολών, έλεγχο diffs και διαχείριση συνεδριών.

| Ενέργεια | Περιγραφή |
| --- | --- |
| `Tab` | Εναλλαγή μεταξύ διαθέσιμων agents |
| Session list | Προβολή ιστορικού και αναζήτηση τίτλων και περιεχομένου μηνυμάτων |
| Diff preview | Εμφάνιση αλλαγών τύπου git diff πριν και μετά από εγγραφές αρχείων |
| Manual compaction | Προληπτική συμπύκνωση context σε μεγάλες συνεδρίες για απελευθέρωση χώρου token |
| Shell tool | Υποστηρίζει ακύρωση, συμπίεση εξόδου και κανονικοποίηση εξόδου PowerShell |

---

## Desktop App

Ο κλάδος SMARK `dev-smark` δημοσιεύει προς το παρόν μόνο CLI releases, όχι desktop app installers. Για το desktop app (BETA), χρησιμοποιήστε το [opencode.ai/download](https://opencode.ai/download) και τις upstream release notes ως πηγή αλήθειας. Μην αντιμετωπίζετε τη σελίδα SMARK CLI release ως πηγή desktop installer.

---

## Βασικές Δυνατότητες

Αυτός ο κλάδος δεν είναι απλώς μια στοίβα λειτουργιών. Μετατρέπει συνηθισμένα προβλήματα ανάπτυξης σε παρατηρήσιμα, ανακτήσιμα, cross-platform workflows.

| Περιοχή | Πρόβλημα Που Λύνει | Τι Θα Δείτε |
| --- | --- | --- |
| TUI interaction | Μεγάλη έξοδος, streaming μηνύματα, δυσανάγνωστα diffs | Ζωντανή απόδοση, πτυσσόμενη συλλογιστική, diff preview, άμεσες ενημερώσεις κατάστασης |
| Session management | Οι μεγάλες συνεδρίες χάνουν context και είναι δαπανηρή η ανάκτησή τους | Session search, path filters, manual compaction, interrupt recovery, Session Warping |
| Token statistics | Δύσκολο να γνωρίζετε τι καταναλώνει context | Input/output tokens, tool results, attachments, request overhead breakdowns |
| Tool system | Η έξοδος αρχείων και shell μπορεί να μολύνει το context | Structured Read output, Shell output compression, Write auto diff |
| Provider | Η ρύθμιση πολλών λογαριασμών, endpoints και μοντέλων είναι σύνθετη | Provider aliases, client version override, ClaudeCode provider |
| VSCode | Τα Notebook scenarios δεν μπορούν να λειτουργήσουν αξιόπιστα από CLI agents | Cell summary, read, edit, run, output read, kernel management |
| Windows | PowerShell, encoding, paths και CRLF είναι επιρρεπή σε σφάλματα | CLIXML decoding, UTF-8 fixes, path normalization, CRLF preservation |
| Network proxy | Η λογική proxy για provider, plugin και fetch είναι διάσπαρτη | NetworkProxy χειρίζεται HTTP_PROXY, HTTPS_PROXY, NO_PROXY με συνέπεια |
| Daemon | Multi-instance, locks, health checks και clients είναι σύνθετα | Server Lock, health checks, HttpApi, PTY WebSocket tickets |

### TUI Και Εμπειρία Αλληλεπίδρασης

| Δυνατότητα | Λεπτομέρειες |
| --- | --- |
| Streaming output | Τα assistant messages και reasoning chunks αποδίδονται σταδιακά, με εμφάνιση elapsed time κατά το streaming |
| Reasoning display | Η μεγάλη συλλογιστική μπορεί να συμπτυχθεί για μείωση χρήσης οθόνης |
| Diff preview | Οι αντικαταστάσεις αρχείων δημιουργούν αυτόματα προβολή τύπου git diff με πλήθος προστιθέμενων/διαγραμμένων γραμμών |
| Session list | Εμφανίζει πρόσφατες περιλήψεις μηνυμάτων και υποστηρίζει αναζήτηση κατά τίτλο και περιεχόμενο μηνύματος |
| Layout stability | Πιο αξιόπιστα scrollbars, χειρισμός πλάτους terminal και χειρισμός πλάτους CJK χαρακτήρων |
| Shell mode | Παρέχει κουμπί ακύρωσης, custom icon, example placeholder και ζωντανή κατάσταση ολοκλήρωσης |

### Διαχείριση Συνεδριών Και Context

| Δυνατότητα | Λεπτομέρειες |
| --- | --- |
| Session recovery | Hidden messages, undo operations, pending-message checks και error recovery είναι πιο ανθεκτικά |
| Interrupt control | Καταγράφει interrupt counts και confirmation time. Τα parent session interrupts μεταδίδονται σε subtasks |
| Path compatibility | Τα Windows global session paths κανονικοποιούνται. Το session storage χρησιμοποιεί relative paths |
| Manual compaction | Οι χρήστες μπορούν να ενεργοποιήσουν compaction. Η compaction selection είναι asynchronous και αναφέρει σφάλματα |
| Git context | Εισάγει αυτόματα current branch, status, recent commits και related data με config switch |

### Ορατότητα Token Και Κόστους

| Καταχώρηση | Χρήση | Εμφάνιση |
| --- | --- | --- |
| TUI Context usage | Εκτελέστε `/context` σε μια συνεδρία ή επιλέξτε `Context usage` από την command palette | Εμφανίζει current context window, model, used/available tokens και Prompt/Conversation/Window category grid |
| Context usage footer | Κάτω μέρος του TUI panel | Με session usage, εμφανίζει `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`. Χωρίς cumulative usage, εμφανίζει `Used`, `Free`, `Usable`, `Buffer` |
| Session list cost column | `opencode session list --cost` ή `opencode session list -c` | Προσθέτει στήλες `Cost` και `Tokens` στη session list για γρήγορο εντοπισμό cost hotspots |
| Single-session details | `opencode session info -s <Session_ID>` | Εμφανίζει `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` ανά provider/model |
| Global stats | `opencode stats --models` | Συνοψίζει total cost, daily average cost, average tokens, tool usage και model usage |

Τα εσωτερικά stats προτιμούν request usage data και πέφτουν πίσω σε message metadata για παλαιότερες συνεδρίες. Το TUI Context usage εκτιμά επίσης instruction, skills, tool definitions, attachments, tool results και compaction summary usage μέσα στο context window.

### Σύστημα Εργαλείων

| Tool | Enhancement |
| --- | --- |
| Read | Metadata, stub, default read line count, byte limits, device-file protection |
| Grep/Ripgrep | Όρια μέγιστων αρχείων και result counts, με καθαρά σφάλματα για υπερβολικά ευρείες αναζητήσεις |
| Shell | bash, PowerShell και cmd χρησιμοποιούν shell-aware prompts ξεχωριστά |
| Write | Δημιουργεί αυτόματα diff όταν αντικαθιστά αρχεία ώστε οι χρήστες να επιβεβαιώνουν την πραγματική αλλαγή |
| Permission | Τα parent-agent permissions φιλτράρονται πριν περάσουν σε subtasks. Οι tool availability checks είναι αυστηρότεροι |

### Provider Και Models

| Δυνατότητα | Περιγραφή |
| --- | --- |
| Provider aliases | Ρύθμιση πολλών λογαριασμών ή endpoints για τον ίδιο underlying provider |
| Client version override | Προσαρμογή custom providers, compatibility proxies και ειδικών API endpoints |
| ClaudeCode provider | Υποστηρίζει API Key, Base URL και dynamic authentication modes |
| Cloudflare AI Gateway | Διορθώσεις routing. Το tool streaming είναι απενεργοποιημένο από προεπιλογή για non-Anthropic models |

### Ενσωμάτωση VS Code Notebook

Πριν χρησιμοποιήσετε Notebook tools, εγκαταστήστε το VS Code extension [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). Η έκδοση του extension παραμένει `1.15.5` και μπορεί να συνεχίσει να λειτουργεί με SMARK CLI `1.15.6`. Δεν χρειάζεται αναβάθμιση για αυτήν την ενημέρωση CLI README. Το extension δημιουργεί ένα τοπικό authenticated bridge μεταξύ VS Code/Jupyter Notebook και OpenCode CLI. Χωρίς να είναι εγκατεστημένο ή συνδεδεμένο, το CLI δεν μπορεί να διαβάσει, να επεξεργαστεί ή να εκτελέσει notebook cells αξιόπιστα.

Μετά την εκκίνηση, το extension ανοίγει ένα local bridge στο `127.0.0.1:<random port>` και γράφει ένα heartbeat manifest στο `~/.local/state/opencode/ide/<uuid>.json`. Το OpenCode επιλέγει αυτόματα το αντίστοιχο VS Code bridge με βάση workspace και notebook path. Σε remote SSH, WSL ή container setups, το CLI πρέπει να τρέχει στην ίδια πλευρά που μπορεί να προσπελάσει το bridge.

| Tool | Purpose |
| --- | --- |
| `vscode_notebook_summary` | Λήψη stable `#VSC-*` IDs, display index, type, language, execution state, output summary, dirty state και runtime info για notebook cells |
| `vscode_notebook_source` | Ανάγνωση notebook source με 1-based global virtual line numbers. Το returned content περιορίζεται σε 16KB από προεπιλογή |
| `vscode_notebook_edit` | Insert, edit ή delete cells. Υποστηρίζει ακριβή αντικατάσταση string `oldCode/newCode` και code/markdown type switching |
| `vscode_notebook_run` | Εκτέλεση ενός code cell ή stable-ID range μέσω VS Code/Jupyter. Το range execution σταματά σε failure ή timeout |
| `vscode_notebook_output` | Ανάγνωση text, image, HTML, JSON και άλλων outputs. Τα μεγάλα outputs γράφονται στο `.opencode/cache/notebook-outputs/` και επιστρέφονται ως artifact paths |
| `vscode_notebook_env` | Έλεγχος kernel/runtime, trigger kernel selection, restart kernel ή save notebook όταν ζητηθεί ρητά από τον χρήστη |

Συνιστώμενη ροή: χρησιμοποιήστε `vscode_notebook_summary` για να πάρετε το τρέχον cell ID, `vscode_notebook_source` για να διαβάσετε το target cell, `vscode_notebook_run` για validation μετά την επεξεργασία και `vscode_notebook_output` για έλεγχο αποτελεσμάτων. Μην αντιμετωπίζετε το display index `cN` ως stable long-term reference. Μετά από inserts, deletes ή type switches, χρησιμοποιήστε το νέο `#VSC-*` ID που επιστρέφει το tool ή εκτελέστε ξανά summary.

### Cross-Platform Υποστήριξη

| Platform Issue | Handling |
| --- | --- |
| Windows encoding | Auto-detect UTF-8/UTF-16LE και επιδιόρθωση pipe mojibake |
| PowerShell | CLIXML decoding, stderr normalization, UTF-8 output repair |
| Path differences | Κανονικοποίηση casing, separators και global session paths |
| Line endings | Διατήρηση αρχικού CRLF/LF style κατά την εφαρμογή patches |
| WSL | Συντήρηση migration και cross-platform build guides |

---

## Agents

Το OpenCode περιλαμβάνει πολλούς ενσωματωμένους primary agents που μπορούν να εναλλάσσονται με `Tab`. Ο default agent μπορεί να αντικατασταθεί με `default_agent`. Οι subagents καλούνται κυρίως μέσω task dispatch ή `@agent`.

| Agent | Type | Permission Model | Best For |
| --- | --- | --- | --- |
| `build` | primary | Default development mode. Εκτελεί tools σύμφωνα με configured permissions, επιτρέπει question confirmation και είσοδο σε plan | Υλοποίηση features, διόρθωση bugs, εκτέλεση tests, end-to-end delivery |
| `interactive` | primary | Πιο συντηρητικό interactive mode. `bash`, notebook execution και notebook environment operations ρωτούν από προεπιλογή | Εργασίες που χρειάζονται επιβεβαίωση για key commands ή χαμηλότερο κίνδυνο accidental operations |
| `auto` | primary | Ενεργοποιείται μόνο όταν επιλεγεί ρητά. `bash`, `edit` και shell external directory access μπαίνουν σε auto permission review | Αυτόματη ανασκόπηση shell/edit risk χωρίς να αλλάζει κατά λάθος η default build behavior |
| `decide` | primary | Απενεργοποιεί tools και κάνει one-shot judgment από περιορισμένο πρόσφατο context | Lower-cost one-off decisions, tradeoffs και next-step choices με high-performance model |
| `plan` | primary | Δεν επιτρέπει edit tools και notebook changes. Επιτρέπει writing plan files και exiting plan | Code analysis, planning, risk review, pre-execution design |
| `general` | subagent | General subagent. Απαγορεύει `todowrite`, αλλιώς ακολουθεί merged permission config | Complex search, multi-step research, parallelizable support tasks |
| `explore` | subagent | Επιτρέπει μόνο search, read, list, web query και παρόμοια exploration tools | Γρήγορος εντοπισμός files, symbols, call chains, config και docs |
| `scout` | subagent, experimental | Στοχεύει external docs και dependency source. Επιτρέπει managed repo cache reads | Έλεγχος third-party library implementation, cloning dependency source, research external API behavior |

Τα `title`, `summary`, και `compaction` είναι hidden system agents για title generation, summaries και compaction flows, όχι καθημερινοί manual switching targets. Μάθετε περισσότερα για τους [Agents](https://opencode.ai/docs/agents).

---

## Τεκμηρίωση

| Resource | Link |
| --- | --- |
| Official docs | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Contributing guide | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## FAQ

### Πώς διαφέρει από το Claude Code;

Ο στόχος δυνατοτήτων είναι παρόμοιος, αλλά το OpenCode εστιάζει στο open source, στη terminal-first χρήση, στην ανεξαρτησία provider, στην client/server architecture και σε ένα extensible tool system. Ο κλάδος SMARK ενισχύει περαιτέρω Windows/PowerShell, VS Code Notebook, token visibility, network proxy support και installation experience.

### Για ποιον είναι αυτός ο κλάδος;

Αν αναπτύσσετε συχνά στο terminal, χρειάζεστε auditable agent behavior ή χρησιμοποιείτε AI coding agents σε Windows/PowerShell ή VS Code Notebook scenarios, αυτός ο κλάδος παρέχει πιο πλήρη εμπειρία από τα upstream defaults.

### Γιατί ο installer δεν χρησιμοποιεί sudo από προεπιλογή;

Η εγκατάσταση σε επίπεδο χρήστη είναι ασφαλέστερη και ευκολότερη στη διαχείριση. Ο installer γράφει σε user directory από προεπιλογή και αρνείται implicit sudo. Χρησιμοποιήστε `sudo env ... --allow-sudo` μόνο όταν εγκαθιστάτε ρητά σε system directory όπως `/usr/local/bin`. Επίσης εξετάστε το `--no-modify-path` για να αποφύγετε την τροποποίηση user profiles από root.

### Τι γίνεται αν υπάρχει ήδη παλιό opencode στο σύστημα;

Ο installer εμπιστεύεται μόνο το target install path. Ακόμα και αν το `/usr/local/bin/opencode` έχει ήδη την ίδια έκδοση, ο καθορισμός `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` εξακολουθεί να εγκαθιστά στο `~/.local/bin/opencode` και δεν θα αποκλειστεί από παλιό binary στο PATH.

---

## Συνεισφορά

Διαβάστε τον [contributing guide](./CONTRIBUTING.md) πριν υποβάλετε PR. Αν το όνομα του δικού σας project χρησιμοποιεί `opencode`, δηλώστε στο README του ότι δεν είναι επίσημο project της ομάδας OpenCode και δεν συνδέεται με την ομάδα OpenCode.

---

## Κοινότητα

**Γίνετε μέλος της κοινότητάς μας** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
