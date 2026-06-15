<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">ওপেন সোর্স AI Coding Agent — SMARK উন্নত শাখা</p>
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

> **এই শাখা সম্পর্কে**: এটি OpenCode-এর `dev-smark` উন্নত শাখা (বর্তমান সংস্করণ `1.15.7`, CLI release tag `v1.15.7-smark`)। এটি upstream `dev`-এর উপর ভিত্তি করে তৈরি এবং TUI interaction, session management, token statistics, Windows/PowerShell compatibility, VS Code Notebook integration, network proxy support, ও installation experience উন্নত করার উপর কেন্দ্রীভূত।

---

## দ্রুত ইনস্টল

SMARK branch releases page থেকে installer ব্যবহার করুন। ডিফল্টভাবে এটি সর্বশেষ release ইনস্টল করে এবং বিদ্যমান shell profiles-এ install directory লিখে।

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

ইনস্টলেশনের পরে যাচাই করুন:

```bash
opencode --version
which opencode
```

বর্তমান shell যদি PATH refresh না করে থাকে, terminal আবার খুলুন অথবা install log-এ দেখানো profile source করুন।

### Install Directory নির্দিষ্ট করুন

User-level install-এর জন্য `~/.local/bin` সুপারিশ করা হয়। environment variable অবশ্যই installer চালানো `bash` process-এ পাঠাতে হবে, শুধু `curl`-এ নয়।

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

Troubleshooting-এর জন্য আগে script download করে তারপর চালান:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

এভাবে লিখবেন না:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

এতে `OPENCODE_INSTALL_DIR` শুধু `curl`-এ যায়, installer আসলে যে `bash` process চালায় সেখানে যায় না।

### Version নির্দিষ্ট করুন

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

এটি সম্পূর্ণ form: `bash -s --` `bash`-কে stdin থেকে installer পড়তে এবং `--version 1.15.7-smark` installer arguments হিসেবে পাঠাতে বলে। version `1.15.7-smark` হতে পারে অথবা release tag form `v1.15.7-smark` হতে পারে।

### Installer Behavior

| Scenario | Behavior |
| --- | --- |
| Default install directory | `$OPENCODE_INSTALL_DIR`, তারপর `$XDG_BIN_DIR`, তারপর `$HOME/.opencode/bin` |
| Same version already at target path | Reinstall করে overwrite করে, damaged বা stale binaries refresh করতে উপযোগী |
| Same version elsewhere in PATH | শুধু notice print করে; requested directory-তে install block করে না |
| PATH writing | ডিফল্টভাবে সব বিদ্যমান supported profiles update করে এবং duplicate entries এড়ায় |
| sudo | ডিফল্টভাবে `sudo` startup প্রত্যাখ্যান করে; system installs-এ স্পষ্টভাবে `--allow-sudo` দিতে হবে |
| macOS quarantine | install-এর পরে `com.apple.quarantine` attribute সরানোর চেষ্টা করে |
| checksum | release-এ `checksums.txt` থাকলে downloaded assets verify করে |

### PATH এবং Shell Profiles

installer বিদ্যমান profiles detect ও update করে: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*`, এবং `~/.config/fish/config.fish`।

| Need | Command |
| --- | --- |
| PATH modify করবেন না | `bash /tmp/opencode-install --no-modify-path` |
| শুধু একটি profile লিখুন | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| interactively profile বেছে নিন | `bash /tmp/opencode-install --interactive` |
| system directory-তে install করুন | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

আপনি যদি `/usr/local/bin/opencode`-এর চেয়ে `~/.local/bin/opencode`-কে priority দিতে চান, আপনার profile-এ PATH order যেন এমন হয় তা নিশ্চিত করুন:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### অন্যান্য Install Methods

এই পদ্ধতিগুলো upstream package-manager ecosystem ব্যবহার করে। SMARK branch build দরকার হলে উপরের GitHub release installer-কে অগ্রাধিকার দিন।

| Platform | Command | Notes |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | `bun`, `pnpm`, বা `yarn`-ও ব্যবহার করতে পারেন |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Upstream tap, সাধারণত দ্রুত update হয় |
| macOS/Linux | `brew install opencode` | Official Homebrew formula, পিছিয়ে থাকতে পারে |
| Windows | `scoop install opencode` | Scoop package |
| Windows | `choco install opencode` | Chocolatey package |
| Arch Linux | `sudo pacman -S opencode` | Stable package |
| Arch Linux | `paru -S opencode-bin` | Latest AUR binary package |
| Any system | `mise use -g opencode` | mise দিয়ে tool versions manage করুন |
| Nix | `nix run nixpkgs#opencode` | GitHub থেকে development version-ও চালানো যায় |

---

## Quick Start

```bash
cd <your-project>
opencode
```

Startup-এর পরে সরাসরি task বর্ণনা করুন, যেমন "explain this module architecture", "fix this error", অথবা "add tests for this feature"। TUI-তে agent switch করতে `Tab` ব্যবহার করুন এবং files read/write, commands run, diffs inspect, ও sessions manage করতে built-in tools ব্যবহার করুন।

| Action | Description |
| --- | --- |
| `Tab` | available agents-এর মধ্যে switch করুন |
| Session list | history দেখুন এবং titles ও message content search করুন |
| Diff preview | file writes-এর আগে ও পরে git diff style changes দেখান |
| Manual compaction | দীর্ঘ sessions-এ token space খালি করতে proactively context compact করুন |
| Shell tool | cancellation, output compression, এবং PowerShell output normalization support করে |

---

## Desktop App

SMARK `dev-smark` branch বর্তমানে শুধু CLI releases publish করে, desktop app installers নয়। desktop app (BETA)-এর জন্য [opencode.ai/download](https://opencode.ai/download) এবং upstream release notes-কে source of truth হিসেবে ব্যবহার করুন; SMARK CLI release page-কে desktop installer source হিসেবে ধরবেন না।

---

## Core Features

এই branch শুধু features-এর স্তূপ নয়; এটি সাধারণ development pain points-কে observable, recoverable, cross-platform workflows-এ রূপ দেয়।

| Area | Problem Solved | What You Will See |
| --- | --- | --- |
| TUI interaction | Long output, streaming messages, hard-to-read diffs | Live rendering, collapsible reasoning, diff preview, instant status updates |
| Session management | Long sessions context হারায় এবং recover করা costly | Session search, path filters, manual compaction, interrupt recovery, Session Warping |
| Token statistics | কী context consume করছে বোঝা কঠিন | Input/output tokens, tool results, attachments, request overhead breakdowns |
| Tool system | File এবং shell output context pollute করতে পারে | Structured Read output, Shell output compression, Write auto diff |
| Provider | Multi-account, endpoint, এবং model setup complex | Provider aliases, client version override, ClaudeCode provider |
| VSCode | Notebook scenarios CLI agents দ্বারা reliably operate করা যায় না | Cell summary, read, edit, run, output read, kernel management |
| Windows | PowerShell, encoding, paths, এবং CRLF error-prone | CLIXML decoding, UTF-8 fixes, path normalization, CRLF preservation |
| Network proxy | Provider, plugin, এবং fetch proxy logic scattered | NetworkProxy HTTP_PROXY, HTTPS_PROXY, NO_PROXY consistently handle করে |
| Daemon | Multi-instance, locks, health checks, এবং clients complex | Server Lock, health checks, HttpApi, PTY WebSocket tickets |

### TUI এবং Interaction Experience

| Capability | Details |
| --- | --- |
| Streaming output | Assistant messages এবং reasoning chunks incrementally render হয়, streaming চলাকালে elapsed time দেখানো হয় |
| Reasoning display | screen usage কমাতে long reasoning collapse করা যায় |
| Diff preview | File overwrites added/deleted line counts সহ automatic git diff style view generate করে |
| Session list | Recent message summaries দেখায় এবং title ও message content দিয়ে search support করে |
| Layout stability | Scrollbars, terminal width handling, এবং CJK character width handling আরও reliable |
| Shell mode | Cancel button, custom icon, example placeholder, এবং live completion status দেয় |

### Session এবং Context Management

| Capability | Details |
| --- | --- |
| Session recovery | Hidden messages, undo operations, pending-message checks, এবং error recovery আরও robust |
| Interrupt control | interrupt counts এবং confirmation time record করে; parent session interrupts subtasks-এ propagate করে |
| Path compatibility | Windows global session paths normalized; session storage relative paths ব্যবহার করে |
| Manual compaction | Users compaction trigger করতে পারেন; compaction selection asynchronous এবং errors report করে |
| Git context | config switch দিয়ে current branch, status, recent commits, এবং related data automatically inject করে |

### Token এবং Cost Visibility

| Entry | Usage | Display |
| --- | --- | --- |
| TUI Context usage | session-এ `/context` run করুন অথবা command palette থেকে `Context usage` বেছে নিন | current context window, model, used/available tokens, এবং Prompt/Conversation/Window category grid দেখায় |
| Context usage footer | TUI panel-এর নিচে | session usage থাকলে `Input`, `Output`, `Reason`, `Cache W/R`, `Cost` দেখায়; cumulative usage না থাকলে `Used`, `Free`, `Usable`, `Buffer` দেখায় |
| Session list cost column | `opencode session list --cost` অথবা `opencode session list -c` | cost hotspots দ্রুত খুঁজতে session list-এ `Cost` এবং `Tokens` columns যোগ করে |
| Single-session details | `opencode session info -s <Session_ID>` | provider/model অনুযায়ী `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` দেখায় |
| Global stats | `opencode stats --models` | total cost, daily average cost, average tokens, tool usage, এবং model usage summarize করে |

Internal stats request usage data পছন্দ করে এবং older sessions-এর জন্য message metadata-তে fallback করে। TUI Context usage context window-তে instruction, skills, tool definitions, attachments, tool results, এবং compaction summary usage-ও estimate করে।

### Tool System

| Tool | Enhancement |
| --- | --- |
| Read | Metadata, stub, default read line count, byte limits, device-file protection |
| Grep/Ripgrep | maximum files এবং result counts limit করে, overly broad searches-এর জন্য clear errors দেয় |
| Shell | bash, PowerShell, এবং cmd আলাদাভাবে shell-aware prompts ব্যবহার করে |
| Write | files overwrite করার সময় automatic diff generate করে যাতে users actual change confirm করতে পারেন |
| Permission | Parent-agent permissions subtasks-এ পাঠানোর আগে filtered হয়; tool availability checks আরও strict |

### Provider এবং Models

| Capability | Description |
| --- | --- |
| Provider aliases | একই underlying provider-এর জন্য multiple accounts বা endpoints configure করুন |
| Client version override | custom providers, compatibility proxies, এবং special API endpoints adapt করুন |
| ClaudeCode provider | API Key, Base URL, এবং dynamic authentication modes support করে |
| Cloudflare AI Gateway | Routing fixes; non-Anthropic models-এর জন্য tool streaming defaultভাবে disabled |

### VS Code Notebook Integration

Notebook tools ব্যবহার করার আগে VS Code extension [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge) install করুন। extension version `1.15.5`-ই থাকে এবং SMARK CLI `1.15.7`-এর সাথে কাজ চালিয়ে যেতে পারে; এই CLI README update-এর জন্য upgrade দরকার নেই। extension VS Code/Jupyter Notebook এবং OpenCode CLI-এর মধ্যে local authenticated bridge তৈরি করে; এটি installed বা connected না থাকলে CLI reliably notebook cells read, edit, বা run করতে পারে না।

Startup-এর পরে extension `127.0.0.1:<random port>`-এ local bridge খোলে এবং heartbeat manifest `~/.local/state/opencode/ide/<uuid>.json`-এ লেখে। OpenCode workspace এবং notebook path অনুযায়ী matching VS Code bridge automatically select করে। remote SSH, WSL, বা container setups-এ CLI একই side-এ run করতে হবে যেখান থেকে bridge access করা যায়।

| Tool | Purpose |
| --- | --- |
| `vscode_notebook_summary` | notebook cells-এর stable `#VSC-*` IDs, display index, type, language, execution state, output summary, dirty state, এবং runtime info পান |
| `vscode_notebook_source` | 1-based global virtual line numbers সহ notebook source পড়ুন; returned content defaultভাবে 16KB-তে limited |
| `vscode_notebook_edit` | cells insert, edit, বা delete করুন; exact `oldCode/newCode` string replacement এবং code/markdown type switching support করে |
| `vscode_notebook_run` | VS Code/Jupyter-এর মাধ্যমে এক code cell বা stable-ID range run করুন; range execution failure বা timeout-এ থেমে যায় |
| `vscode_notebook_output` | text, image, HTML, JSON, এবং অন্যান্য outputs পড়ুন; বড় outputs `.opencode/cache/notebook-outputs/`-এ লেখা হয় এবং artifact paths হিসেবে returned হয় |
| `vscode_notebook_env` | kernel/runtime inspect করুন, kernel selection trigger করুন, kernel restart করুন, অথবা user স্পষ্টভাবে request করলে notebook save করুন |

Recommended flow: current cell ID পেতে `vscode_notebook_summary` ব্যবহার করুন, target cell পড়তে `vscode_notebook_source` ব্যবহার করুন, edit-এর পরে validate করতে `vscode_notebook_run` ব্যবহার করুন, এবং results inspect করতে `vscode_notebook_output` ব্যবহার করুন। display index `cN`-কে stable long-term reference ভাববেন না; inserts, deletes, বা type switches-এর পরে tool-returned নতুন `#VSC-*` ID ব্যবহার করুন অথবা summary আবার run করুন।

### Cross-Platform Support

| Platform Issue | Handling |
| --- | --- |
| Windows encoding | UTF-8/UTF-16LE auto-detect করে এবং pipe mojibake repair করে |
| PowerShell | CLIXML decoding, stderr normalization, UTF-8 output repair |
| Path differences | casing, separators, এবং global session paths normalize করে |
| Line endings | patches apply করার সময় original CRLF/LF style preserve করে |
| WSL | migration এবং cross-platform build guides maintain করে |

---

## Agents

OpenCode-এ একাধিক built-in primary agents আছে যেগুলো `Tab` দিয়ে switch করা যায়। default agent `default_agent` দিয়ে override করা যায়; subagents মূলত task dispatch বা `@agent` দিয়ে invoked হয়।

| Agent | Type | Permission Model | Best For |
| --- | --- | --- | --- |
| `build` | primary | Default development mode; configured permissions অনুযায়ী tools run করে, question confirmation এবং plan-এ যাওয়া allow করে | features implement, bugs fix, tests run, end-to-end delivery |
| `interactive` | primary | আরও conservative interactive mode; `bash`, notebook execution, এবং notebook environment operations defaultভাবে ask করে | key commands-এর জন্য confirmation দরকার বা accidental operations-এর risk কমাতে চাইলে |
| `auto` | primary | শুধু explicitly select করলে enabled; `bash`, `edit`, এবং shell external directory access auto permission review-তে যায় | default build behavior accidentally না বদলে shell/edit risk automatically review করা |
| `decide` | primary | tools disable করে এবং limited recent context থেকে one-shot judgment করে | high-performance model দিয়ে lower-cost one-off decisions, tradeoffs, এবং next-step choices |
| `plan` | primary | edit tools এবং notebook changes disallow করে; plan files লেখা এবং plan থেকে exit allow করে | Code analysis, planning, risk review, pre-execution design |
| `general` | subagent | General subagent; `todowrite` forbid করে, otherwise merged permission config অনুসরণ করে | Complex search, multi-step research, parallelizable support tasks |
| `explore` | subagent | শুধু search, read, list, web query, এবং similar exploration tools allow করে | files, symbols, call chains, config, এবং docs দ্রুত locate করা |
| `scout` | subagent, experimental | external docs এবং dependency source target করে; managed repo cache reads allow করে | third-party library implementation inspect, dependency source clone, external API behavior research |

`title`, `summary`, এবং `compaction` hidden system agents; এগুলো title generation, summaries, এবং compaction flows-এর জন্য, daily manual switching targets নয়। আরও জানুন [Agents](https://opencode.ai/docs/agents)।

---

## Documentation

| Resource | Link |
| --- | --- |
| Official docs | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Contributing guide | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## FAQ

### এটি Claude Code থেকে কীভাবে আলাদা?

Capability target similar, কিন্তু OpenCode open source, terminal-first usage, provider independence, client/server architecture, এবং extensible tool system-এ focus করে। SMARK branch আরও Windows/PowerShell, VS Code Notebook, token visibility, network proxy support, এবং installation experience শক্তিশালী করে।

### এই branch কার জন্য?

আপনি যদি প্রায়ই terminal-এ develop করেন, auditable agent behavior দরকার হয়, অথবা Windows/PowerShell বা VS Code Notebook scenarios-এ AI coding agents ব্যবহার করেন, এই branch upstream defaults-এর চেয়ে আরও complete experience দেয়।

### installer defaultভাবে sudo ব্যবহার করে না কেন?

User-level installation নিরাপদ এবং manage করা সহজ। installer defaultভাবে user directory-তে লেখে এবং implicit sudo প্রত্যাখ্যান করে। `/usr/local/bin`-এর মতো system directory-তে explicitly install করলেই শুধু `sudo env ... --allow-sudo` ব্যবহার করুন; root যেন user profiles modify না করে সে জন্য `--no-modify-path`-ও বিবেচনা করুন।

### system-এ পুরোনো opencode আগে থেকেই থাকলে কী হবে?

installer শুধু target install path-কে trust করে। `/usr/local/bin/opencode`-এ same version আগে থেকেই থাকলেও, `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` specify করলে এটি তবুও `~/.local/bin/opencode`-এ install করবে এবং PATH-এর old binary দ্বারা block হবে না।

---

## Contributing

PR submit করার আগে [contributing guide](./CONTRIBUTING.md) পড়ুন। আপনার নিজের project name-এ `opencode` ব্যবহার করলে তার README-তে লিখুন যে এটি official OpenCode team project নয় এবং OpenCode team-এর সাথে affiliated নয়।

---

## Community

**আমাদের community-তে যোগ দিন** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
