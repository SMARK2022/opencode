<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">Open source AI Coding Agent — расширенная ветка SMARK</p>
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

> **О ветке**: это расширенная ветка OpenCode `dev-smark` (текущая версия `1.15.7`, CLI release tag `v1.15.7-smark`). Она основана на upstream `dev` и сосредоточена на TUI-взаимодействии, управлении сессиями, статистике token, совместимости с Windows/PowerShell, интеграции VS Code Notebook, поддержке сетевых proxy и опыте установки.

---

## Быстрая установка

Используйте installer со страницы релизов ветки SMARK. По умолчанию он устанавливает последний release и записывает каталог установки в существующие shell profiles.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Проверка после установки:

```bash
opencode --version
which opencode
```

Если текущий shell еще не обновил PATH, откройте терминал заново или выполните source для profile, указанного в логе установки.

### Указать каталог установки

Для пользовательской установки рекомендуется `~/.local/bin`. Переменную окружения нужно передавать процессу `bash`, который запускает installer, а не только `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

Для диагностики сначала скачайте скрипт, затем запустите его:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Не пишите так:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Так `OPENCODE_INSTALL_DIR` передается только в `curl`, а не в процесс `bash`, который фактически запускает installer.

### Указать версию

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

Это полная форма: `bash -s --` говорит `bash` читать installer из stdin и передать `--version 1.15.7-smark` как аргументы installer. Версия может быть `1.15.7-smark` или в форме release tag `v1.15.7-smark`.

### Поведение Installer

| Сценарий | Поведение |
| --- | --- |
| Каталог установки по умолчанию | `$OPENCODE_INSTALL_DIR`, затем `$XDG_BIN_DIR`, затем `$HOME/.opencode/bin` |
| Та же версия уже есть в целевом пути | Переустановить и перезаписать, полезно для обновления поврежденных или устаревших binaries |
| Та же версия есть в другом месте в PATH | Только напечатать notice; не блокировать установку в запрошенный каталог |
| Запись PATH | По умолчанию обновлять все существующие поддерживаемые profiles и избегать дубликатов |
| sudo | По умолчанию отказывать запуску через `sudo`; системные установки должны явно передавать `--allow-sudo` |
| macOS quarantine | Попытаться удалить атрибут `com.apple.quarantine` после установки |
| checksum | Проверять скачанные assets, когда release предоставляет `checksums.txt` |

### PATH И Shell Profiles

Installer обнаруживает и обновляет существующие profiles: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*` и `~/.config/fish/config.fish`.

| Потребность | Команда |
| --- | --- |
| Не изменять PATH | `bash /tmp/opencode-install --no-modify-path` |
| Записать только один profile | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Выбрать profile интерактивно | `bash /tmp/opencode-install --interactive` |
| Установить в системный каталог | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

Если вы хотите, чтобы `~/.local/bin/opencode` имел приоритет над `/usr/local/bin/opencode`, убедитесь, что ваш profile упорядочивает PATH так:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Другие способы установки

Эти способы используют upstream ecosystem менеджеров пакетов. Если вам нужна сборка ветки SMARK, предпочитайте GitHub release installer выше.

| Платформа | Команда | Примечания |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | Также можно использовать `bun`, `pnpm` или `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Upstream tap, обычно быстро обновляется |
| macOS/Linux | `brew install opencode` | Официальная Homebrew formula, может отставать |
| Windows | `scoop install opencode` | Scoop package |
| Windows | `choco install opencode` | Chocolatey package |
| Arch Linux | `sudo pacman -S opencode` | Stable package |
| Arch Linux | `paru -S opencode-bin` | Последний AUR binary package |
| Любая система | `mise use -g opencode` | Управление версиями tools через mise |
| Nix | `nix run nixpkgs#opencode` | Также может запускать development version из GitHub |

---

## Быстрый старт

```bash
cd <your-project>
opencode
```

После запуска опишите задачу напрямую, например "explain this module architecture", "fix this error" или "add tests for this feature". В TUI используйте `Tab` для переключения agents и встроенные tools для чтения/записи файлов, запуска commands, просмотра diffs и управления sessions.

| Действие | Описание |
| --- | --- |
| `Tab` | Переключаться между доступными agents |
| Session list | Смотреть history и искать по titles и message content |
| Diff preview | Показывать изменения в стиле git diff до и после file writes |
| Manual compaction | Проактивно сжимать context в длинных sessions, чтобы освободить token space |
| Shell tool | Поддерживает cancellation, output compression и нормализацию PowerShell output |

---

## Desktop App

Ветка SMARK `dev-smark` сейчас публикует только CLI releases, а не installers для desktop app. Для desktop app (BETA) используйте [opencode.ai/download](https://opencode.ai/download) и upstream release notes как источник истины; не рассматривайте страницу релизов SMARK CLI как источник desktop installers.

---

## Основные возможности

Эта ветка не просто набор функций; она превращает распространенные проблемы разработки в наблюдаемые, восстанавливаемые, cross-platform workflows.

| Область | Решаемая проблема | Что вы увидите |
| --- | --- | --- |
| TUI interaction | Длинный output, streaming messages, трудночитаемые diffs | Live rendering, сворачиваемое reasoning, diff preview, мгновенные status updates |
| Session management | Длинные sessions теряют context, восстановление стоит дорого | Session search, path filters, manual compaction, interrupt recovery, Session Warping |
| Token statistics | Трудно понять, что расходует context | Input/output tokens, tool results, attachments, разбивка request overhead |
| Tool system | File и shell output могут загрязнять context | Structured Read output, Shell output compression, Write auto diff |
| Provider | Multi-account, endpoint и model setup сложны | Provider aliases, client version override, ClaudeCode provider |
| VSCode | Notebook scenarios не могут надежно управляться CLI agents | Cell summary, read, edit, run, output read, kernel management |
| Windows | PowerShell, encoding, paths и CRLF часто ошибочны | CLIXML decoding, UTF-8 fixes, path normalization, CRLF preservation |
| Network proxy | Provider, plugin и fetch proxy logic разрознены | NetworkProxy единообразно обрабатывает HTTP_PROXY, HTTPS_PROXY, NO_PROXY |
| Daemon | Multi-instance, locks, health checks и clients сложны | Server Lock, health checks, HttpApi, PTY WebSocket tickets |

### TUI И Опыт Взаимодействия

| Возможность | Детали |
| --- | --- |
| Streaming output | Assistant messages и reasoning chunks отображаются инкрементально, с показом elapsed time во время streaming |
| Reasoning display | Длинное reasoning можно свернуть, чтобы уменьшить использование экрана |
| Diff preview | File overwrites автоматически создают git diff style view с числом added/deleted lines |
| Session list | Показывает summaries последних сообщений и поддерживает поиск по title и message content |
| Layout stability | Более надежные scrollbars, обработка terminal width и ширины CJK characters |
| Shell mode | Предоставляет cancel button, custom icon, example placeholder и live completion status |

### Управление Sessions И Context

| Возможность | Детали |
| --- | --- |
| Session recovery | Hidden messages, undo operations, pending-message checks и error recovery стали надежнее |
| Interrupt control | Записывает interrupt counts и confirmation time; parent session interrupts распространяются на subtasks |
| Path compatibility | Windows global session paths нормализуются; session storage использует relative paths |
| Manual compaction | Users могут запускать compaction; compaction selection асинхронен и сообщает errors |
| Git context | Автоматически injects current branch, status, recent commits и related data с config switch |

### Видимость Token И Cost

| Вход | Использование | Отображение |
| --- | --- | --- |
| TUI Context usage | Выполните `/context` в session или выберите `Context usage` из command palette | Показывает текущий context window, model, used/available tokens и category grid Prompt/Conversation/Window |
| Context usage footer | Низ TUI panel | При наличии session usage показывает `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`; без cumulative usage показывает `Used`, `Free`, `Usable`, `Buffer` |
| Session list cost column | `opencode session list --cost` или `opencode session list -c` | Добавляет столбцы `Cost` и `Tokens` в session list, чтобы быстро находить cost hotspots |
| Single-session details | `opencode session info -s <Session_ID>` | Показывает `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` по provider/model |
| Global stats | `opencode stats --models` | Summarizes total cost, daily average cost, average tokens, tool usage и model usage |

Internal stats предпочитает request usage data и откатывается к message metadata для older sessions. TUI Context usage также оценивает instruction, skills, tool definitions, attachments, tool results и compaction summary usage в context window.

### Tool System

| Tool | Enhancement |
| --- | --- |
| Read | Metadata, stub, default read line count, byte limits, device-file protection |
| Grep/Ripgrep | Limits maximum files and result counts, with clear errors for overly broad searches |
| Shell | bash, PowerShell и cmd используют shell-aware prompts separately |
| Write | Автоматически создает diff при overwriting files, чтобы users могли подтвердить actual change |
| Permission | Parent-agent permissions фильтруются перед передачей subtasks; tool availability checks строже |

### Provider И Models

| Возможность | Описание |
| --- | --- |
| Provider aliases | Настроить multiple accounts или endpoints для одного underlying provider |
| Client version override | Адаптировать custom providers, compatibility proxies и special API endpoints |
| ClaudeCode provider | Поддерживает API Key, Base URL и dynamic authentication modes |
| Cloudflare AI Gateway | Routing fixes; tool streaming отключен по умолчанию для non-Anthropic models |

### Интеграция VS Code Notebook

Перед использованием Notebook tools установите расширение VS Code [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). Версия расширения остается `1.15.5` и может продолжать работать с SMARK CLI `1.15.7`; обновление для этого CLI README update не требуется. Расширение создает локальный authenticated bridge между VS Code/Jupyter Notebook и OpenCode CLI; без установленного или подключенного расширения CLI не может надежно читать, редактировать или запускать notebook cells.

После запуска расширение открывает local bridge на `127.0.0.1:<random port>` и записывает heartbeat manifest в `~/.local/state/opencode/ide/<uuid>.json`. OpenCode автоматически выбирает подходящий VS Code bridge по workspace и notebook path. В remote SSH, WSL или container setups CLI должен запускаться на той же стороне, которая может получить доступ к bridge.

| Tool | Purpose |
| --- | --- |
| `vscode_notebook_summary` | Получить стабильные `#VSC-*` IDs, display index, type, language, execution state, output summary, dirty state и runtime info для notebook cells |
| `vscode_notebook_source` | Читать notebook source с 1-based global virtual line numbers; возвращаемый content по умолчанию ограничен 16KB |
| `vscode_notebook_edit` | Insert, edit или delete cells; поддерживает точную string replacement `oldCode/newCode` и переключение code/markdown type |
| `vscode_notebook_run` | Запускать один code cell или range stable-ID через VS Code/Jupyter; range execution останавливается при failure или timeout |
| `vscode_notebook_output` | Читать text, image, HTML, JSON и другие outputs; large outputs записываются в `.opencode/cache/notebook-outputs/` и возвращаются как artifact paths |
| `vscode_notebook_env` | Inspect kernel/runtime, trigger kernel selection, restart kernel или save notebook, когда user явно requested |

Recommended flow: используйте `vscode_notebook_summary`, чтобы получить текущий cell ID, `vscode_notebook_source`, чтобы прочитать target cell, `vscode_notebook_run`, чтобы validate после editing, и `vscode_notebook_output`, чтобы inspect results. Не используйте display index `cN` как stable long-term reference; после inserts, deletes или type switches используйте новый `#VSC-*` ID, возвращенный tool, или снова выполните summary.

### Cross-Platform Support

| Platform Issue | Handling |
| --- | --- |
| Windows encoding | Auto-detect UTF-8/UTF-16LE и repair pipe mojibake |
| PowerShell | CLIXML decoding, stderr normalization, UTF-8 output repair |
| Path differences | Normalize casing, separators и global session paths |
| Line endings | Preserve original CRLF/LF style при applying patches |
| WSL | Maintain migration и cross-platform build guides |

---

## Agents

OpenCode включает несколько встроенных primary agents, между которыми можно переключаться с помощью `Tab`. Default agent можно переопределить через `default_agent`; subagents в основном вызываются task dispatch или `@agent`.

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

`title`, `summary` и `compaction` являются hidden system agents для title generation, summaries и compaction flows, а не daily manual switching targets. Подробнее об [Agents](https://opencode.ai/docs/agents).

---

## Документация

| Resource | Link |
| --- | --- |
| Official docs | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Contributing guide | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## FAQ

### Чем это отличается от Claude Code?

Цель по возможностям похожа, но OpenCode фокусируется на open source, terminal-first usage, provider independence, client/server architecture и extensible tool system. Ветка SMARK дополнительно усиливает Windows/PowerShell, VS Code Notebook, token visibility, network proxy support и installation experience.

### Для кого эта ветка?

Если вы часто разрабатываете в terminal, нуждаетесь в auditable agent behavior или используете AI coding agents в сценариях Windows/PowerShell или VS Code Notebook, эта ветка дает более полный опыт, чем upstream defaults.

### Почему installer не использует sudo по умолчанию?

User-level installation безопаснее и проще в управлении. Installer по умолчанию пишет в пользовательский каталог и отказывается от implicit sudo. Используйте `sudo env ... --allow-sudo` только когда явно устанавливаете в системный каталог вроде `/usr/local/bin`; также рассмотрите `--no-modify-path`, чтобы root не менял user profiles.

### Что делать, если старый opencode уже есть в системе?

Installer доверяет только target install path. Даже если `/usr/local/bin/opencode` уже имеет ту же версию, указание `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` все равно устанавливает в `~/.local/bin/opencode` и не будет заблокировано старым binary в PATH.

---

## Contributing

Прочитайте [contributing guide](./CONTRIBUTING.md) перед отправкой PR. Если имя вашего собственного проекта использует `opencode`, укажите в его README, что это не официальный проект OpenCode team и он не аффилирован с OpenCode team.

---

## Community

**Join our community** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
