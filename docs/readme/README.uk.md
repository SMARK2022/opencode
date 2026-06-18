<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="../../packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="../../packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="../../packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">AI Coding Agent з відкритим кодом — розширена гілка SMARK</p>
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

> **Про цю гілку**: Це розширена гілка OpenCode `dev-smark` (поточна версія `1.15.7`, CLI release tag `v1.15.7-smark`). Вона базується на upstream `dev` і зосереджена на взаємодії TUI, керуванні сесіями, статистиці token, сумісності з Windows/PowerShell, інтеграції VS Code Notebook, підтримці мережевого proxy та досвіді встановлення.

---

## Швидке встановлення

Використовуйте installer зі сторінки releases гілки SMARK. За замовчуванням він встановлює найновіший release і записує каталог встановлення в наявні shell profiles.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Перевірте після встановлення:

```bash
opencode --version
which opencode
```

Якщо поточний shell ще не оновив PATH, відкрийте термінал знову або виконайте source для profile, показаного в install log.

### Вказати каталог встановлення

Для встановлення на рівні користувача рекомендовано `~/.local/bin`. Змінну середовища потрібно передати процесу `bash`, який запускає installer, а не лише `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

Для діагностики спочатку завантажте script, а потім запустіть його:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Не пишіть це так:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Це передає `OPENCODE_INSTALL_DIR` лише до `curl`, а не до процесу `bash`, який фактично запускає installer.

### Вказати версію

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

Це повна форма: `bash -s --` каже `bash` читати installer зі stdin і передати `--version 1.15.7-smark` як аргументи installer. Версію можна вказувати як `1.15.7-smark` або у формі release tag `v1.15.7-smark`.

### Поведінка installer

| Сценарій | Поведінка |
| --- | --- |
| Каталог встановлення за замовчуванням | `$OPENCODE_INSTALL_DIR`, потім `$XDG_BIN_DIR`, потім `$HOME/.opencode/bin` |
| Та сама версія вже є за target path | Повторно встановити й overwrite, корисно для оновлення пошкоджених або застарілих binaries |
| Та сама версія в іншому місці PATH | Лише надрукувати notice; не блокувати встановлення в запитаний каталог |
| Запис PATH | За замовчуванням оновлювати всі наявні supported profiles і уникати duplicate entries |
| sudo | За замовчуванням відмовлятися від запуску через `sudo`; system installs мають явно передати `--allow-sudo` |
| macOS quarantine | Після встановлення спробувати прибрати attribute `com.apple.quarantine` |
| checksum | Перевіряти downloaded assets, коли release надає `checksums.txt` |

### PATH і shell profiles

Installer знаходить і оновлює наявні profiles: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*` і `~/.config/fish/config.fish`.

| Потреба | Команда |
| --- | --- |
| Не змінювати PATH | `bash /tmp/opencode-install --no-modify-path` |
| Записати лише один profile | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Вибрати profile інтерактивно | `bash /tmp/opencode-install --interactive` |
| Встановити в system directory | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

Якщо ви хочете, щоб `~/.local/bin/opencode` мав пріоритет над `/usr/local/bin/opencode`, переконайтеся, що ваш profile впорядковує PATH так:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Інші способи встановлення

Ці способи використовують upstream екосистему package-manager. Якщо вам потрібен build гілки SMARK, надавайте перевагу GitHub release installer вище.

| Платформа | Команда | Примітки |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | Також можна використовувати `bun`, `pnpm` або `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Upstream tap, зазвичай оновлюється швидко |
| macOS/Linux | `brew install opencode` | Official Homebrew formula, може відставати |
| Windows | `scoop install opencode` | Scoop package |
| Windows | `choco install opencode` | Chocolatey package |
| Arch Linux | `sudo pacman -S opencode` | Stable package |
| Arch Linux | `paru -S opencode-bin` | Найновіший AUR binary package |
| Будь-яка система | `mise use -g opencode` | Керуйте versions tools через mise |
| Nix | `nix run nixpkgs#opencode` | Також можна запускати development version з GitHub |

---

## Швидкий старт

```bash
cd <your-project>
opencode
```

Після запуску прямо опишіть task, наприклад "explain this module architecture", "fix this error" або "add tests for this feature". У TUI використовуйте `Tab` для перемикання agents і built-in tools для читання/запису файлів, запуску commands, перегляду diffs і керування sessions.

| Дія | Опис |
| --- | --- |
| `Tab` | Перемикання між доступними agents |
| Session list | Перегляд history і пошук titles та message content |
| Diff preview | Показ git diff style changes до і після file writes |
| Manual compaction | Проактивне compact context у довгих sessions, щоб звільнити token space |
| Shell tool | Підтримує cancellation, output compression і PowerShell output normalization |

---

## Desktop App

Гілка SMARK `dev-smark` наразі публікує лише CLI releases, а не installers desktop app. Для desktop app (BETA) використовуйте [opencode.ai/download](https://opencode.ai/download) і upstream release notes як джерело істини; не вважайте сторінку SMARK CLI release джерелом desktop installer.

---

## Основні можливості

Ця гілка не просто набір features; вона перетворює типові pain points розробки на observable, recoverable, cross-platform workflows.

| Напрям | Проблема, яку вирішено | Що ви побачите |
| --- | --- | --- |
| TUI interaction | Long output, streaming messages, diffs, які важко читати | Live rendering, collapsible reasoning, diff preview, instant status updates |
| Session management | Long sessions втрачають context і дорогі у відновленні | Session search, path filters, manual compaction, interrupt recovery, Session Warping |
| Token statistics | Важко зрозуміти, що споживає context | Input/output tokens, tool results, attachments, request overhead breakdowns |
| Tool system | File і shell output можуть забруднювати context | Structured Read output, Shell output compression, Write auto diff |
| Provider | Multi-account, endpoint і model setup є складними | Provider aliases, client version override, ClaudeCode provider |
| VSCode | Notebook scenarios не можуть надійно керуватися CLI agents | Cell summary, read, edit, run, output read, kernel management |
| Windows | PowerShell, encoding, paths і CRLF часто спричиняють помилки | CLIXML decoding, UTF-8 fixes, path normalization, CRLF preservation |
| Network proxy | Provider, plugin і fetch proxy logic розкидані | NetworkProxy узгоджено обробляє HTTP_PROXY, HTTPS_PROXY, NO_PROXY |
| Daemon | Multi-instance, locks, health checks і clients є складними | Server Lock, health checks, HttpApi, PTY WebSocket tickets |

### TUI і досвід взаємодії

| Можливість | Деталі |
| --- | --- |
| Streaming output | Assistant messages і reasoning chunks рендеряться поступово, із показом elapsed time під час streaming |
| Reasoning display | Long reasoning можна collapsed, щоб зменшити використання екрана |
| Diff preview | File overwrites автоматично генерують git diff style view з added/deleted line counts |
| Session list | Показує recent message summaries і підтримує пошук за title та message content |
| Layout stability | Надійніша обробка scrollbars, terminal width і CJK character width |
| Shell mode | Надає cancel button, custom icon, example placeholder і live completion status |

### Sessions і керування context

| Можливість | Деталі |
| --- | --- |
| Session recovery | Hidden messages, undo operations, pending-message checks і error recovery стали надійнішими |
| Interrupt control | Записує interrupt counts і confirmation time; interrupts parent session поширюються на subtasks |
| Path compatibility | Windows global session paths нормалізуються; session storage використовує relative paths |
| Manual compaction | Users можуть запускати compaction; compaction selection є asynchronous і повідомляє errors |
| Git context | Автоматично injects current branch, status, recent commits і related data з config switch |

### Видимість token і cost

| Вхід | Використання | Відображення |
| --- | --- | --- |
| TUI Context usage | Запустіть `/context` у session або виберіть `Context usage` з command palette | Показує current context window, model, used/available tokens і Prompt/Conversation/Window category grid |
| Context usage footer | Нижня частина TUI panel | За наявності session usage показує `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`; без cumulative usage показує `Used`, `Free`, `Usable`, `Buffer` |
| Session list cost column | `opencode session list --cost` або `opencode session list -c` | Додає columns `Cost` і `Tokens` до session list, щоб швидко знаходити cost hotspots |
| Single-session details | `opencode session info -s <Session_ID>` | Показує `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` за provider/model |
| Global stats | `opencode stats --models` | Summarizes total cost, daily average cost, average tokens, tool usage і model usage |

Internal stats надають перевагу request usage data і fallback до message metadata для старіших sessions. TUI Context usage також estimates instruction, skills, tool definitions, attachments, tool results і compaction summary usage у context window.

### Tool System

| Tool | Enhancement |
| --- | --- |
| Read | Metadata, stub, default read line count, byte limits, device-file protection |
| Grep/Ripgrep | Limits maximum files і result counts, з clear errors для overly broad searches |
| Shell | bash, PowerShell і cmd використовують окремі shell-aware prompts |
| Write | Автоматично generates diff під час overwriting files, щоб users могли confirm actual change |
| Permission | Parent-agent permissions filtered перед передаванням до subtasks; tool availability checks суворіші |

### Provider і Models

| Можливість | Опис |
| --- | --- |
| Provider aliases | Configure multiple accounts або endpoints для same underlying provider |
| Client version override | Adapt custom providers, compatibility proxies і special API endpoints |
| ClaudeCode provider | Підтримує API Key, Base URL і dynamic authentication modes |
| Cloudflare AI Gateway | Routing fixes; tool streaming вимкнено за замовчуванням для non-Anthropic models |

### Інтеграція VS Code Notebook

Перед використанням Notebook tools встановіть VS Code extension [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). Версія extension залишається `1.15.5` і може продовжувати працювати з SMARK CLI `1.15.7`; її не потрібно upgrade для цього CLI README update. Extension створює local authenticated bridge між VS Code/Jupyter Notebook і OpenCode CLI; без installed або connected extension CLI не може надійно read, edit або run notebook cells.

Після startup extension відкриває local bridge на `127.0.0.1:<random port>` і записує heartbeat manifest у `~/.local/state/opencode/ide/<uuid>.json`. OpenCode автоматично вибирає matching VS Code bridge за workspace і notebook path. У remote SSH, WSL або container setups CLI має запускатися на тому самому боці, який може access bridge.

| Tool | Purpose |
| --- | --- |
| `vscode_notebook_summary` | Get stable `#VSC-*` IDs, display index, type, language, execution state, output summary, dirty state і runtime info для notebook cells |
| `vscode_notebook_source` | Read notebook source з 1-based global virtual line numbers; returned content за замовчуванням limited to 16KB |
| `vscode_notebook_edit` | Insert, edit або delete cells; підтримує exact `oldCode/newCode` string replacement і code/markdown type switching |
| `vscode_notebook_run` | Run one code cell або stable-ID range через VS Code/Jupyter; range execution stops on failure або timeout |
| `vscode_notebook_output` | Read text, image, HTML, JSON та інші outputs; large outputs записуються в `.opencode/cache/notebook-outputs/` і returned as artifact paths |
| `vscode_notebook_env` | Inspect kernel/runtime, trigger kernel selection, restart kernel або save notebook, коли user explicitly requested |

Recommended flow: використайте `vscode_notebook_summary`, щоб отримати current cell ID, `vscode_notebook_source`, щоб read target cell, `vscode_notebook_run`, щоб validate після editing, і `vscode_notebook_output`, щоб inspect results. Не вважайте display index `cN` stable long-term reference; після inserts, deletes або type switches використовуйте new `#VSC-*` ID, returned by the tool, або run summary again.

### Cross-Platform Support

| Platform Issue | Handling |
| --- | --- |
| Windows encoding | Auto-detect UTF-8/UTF-16LE і repair pipe mojibake |
| PowerShell | CLIXML decoding, stderr normalization, UTF-8 output repair |
| Path differences | Normalize casing, separators і global session paths |
| Line endings | Preserve original CRLF/LF style when applying patches |
| WSL | Maintain migration and cross-platform build guides |

---

## Agents

OpenCode містить кілька built-in primary agents, між якими можна перемикатися через `Tab`. Default agent можна override через `default_agent`; subagents здебільшого викликаються через task dispatch або `@agent`.

| Agent | Type | Permission Model | Best For |
| --- | --- | --- | --- |
| `build` | primary | Default development mode; runs tools according to configured permissions, allows question confirmation and entering plan | Implementing features, fixing bugs, running tests, end-to-end delivery |
| `interactive` | primary | More conservative interactive mode; `bash`, notebook execution, and notebook environment operations ask by default | Tasks needing confirmation for key commands or lower risk of accidental operations |
| `auto` | primary | Enabled only when selected explicitly; `bash`, `edit`, and shell external directory access enter auto permission review | Automatically reviewing shell/edit risk without changing default build behavior accidentally |
| `decide` | primary | Disables tools and makes a one-shot judgment from limited recent context | Lower-cost one-off decisions, tradeoffs, and next-step choices with a high-performance model |
| `plan` | primary | Disallows edit tools and notebook changes; allows writing plan files and exiting plan | Code analysis, planning, risk review, pre-execution design |
| `general` | subagent | General subagent; forbids `todowrite`, otherwise follows merged permission config | Complex search, multi-step research, parallelizable support tasks |
| `explore` | subagent | Allows only search, read, list, web query, and similar exploration tools | Quickly locating files, symbols, call chains, config, and docs |
| `scout` | subagent, experimental | Targets external docs and dependency source; allows managed repo cache reads | Inspecting third-party library implementation, cloning dependency source, researching external API behavior |

`title`, `summary` і `compaction` є hidden system agents для title generation, summaries і compaction flows, а не щоденними targets для manual switching. Дізнайтеся більше про [Agents](https://opencode.ai/docs/agents).

---

## Документація

| Resource | Link |
| --- | --- |
| Official docs | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Contributing guide | [CONTRIBUTING.md](../../CONTRIBUTING.md) |

---

## FAQ

### Чим це відрізняється від Claude Code?

Ціль можливостей схожа, але OpenCode фокусується на open source, terminal-first usage, provider independence, client/server architecture і extensible tool system. Гілка SMARK додатково посилює Windows/PowerShell, VS Code Notebook, token visibility, network proxy support і installation experience.

### Для кого ця гілка?

Якщо ви часто розробляєте в terminal, потребуєте auditable agent behavior або використовуєте AI coding agents у Windows/PowerShell чи VS Code Notebook scenarios, ця гілка надає повніший experience, ніж upstream defaults.

### Чому installer не використовує sudo за замовчуванням?

User-level installation безпечніше й простіше в керуванні. Installer за замовчуванням writes to user directory і refuses implicit sudo. Використовуйте `sudo env ... --allow-sudo` лише тоді, коли явно встановлюєте в system directory, наприклад `/usr/local/bin`; також розгляньте `--no-modify-path`, щоб root не modifying user profiles.

### Що, якщо старий opencode вже є в system?

Installer довіряє лише target install path. Навіть якщо `/usr/local/bin/opencode` уже має ту саму version, specifying `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` все одно installs to `~/.local/bin/opencode` і не буде blocked старим binary у PATH.

---

## Внесок

Перед надсиланням PR прочитайте [contributing guide](../../CONTRIBUTING.md). Якщо назва вашого власного project використовує `opencode`, зазначте в його README, що це не official OpenCode team project і він не affiliated з OpenCode team.

---

## Спільнота

**Приєднуйтеся до нашої спільноти** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
