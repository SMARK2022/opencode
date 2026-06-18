<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="../../packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="../../packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="../../packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">오픈 소스 AI Coding Agent — SMARK 강화 브랜치</p>
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

> **이 브랜치에 대하여**: 이 브랜치는 OpenCode의 `dev-smark` 강화 브랜치입니다(현재 버전 `1.15.7`, CLI release tag `v1.15.7-smark`). 업스트림 `dev`를 기반으로 하며 TUI 상호작용, 세션 관리, token 통계, Windows/PowerShell 호환성, VS Code Notebook 통합, 네트워크 프록시 지원, 설치 경험에 집중합니다.

---

## 빠른 설치

SMARK 브랜치 release 페이지의 installer를 사용하세요. 기본적으로 최신 release를 설치하고 설치 디렉터리를 기존 shell profile에 기록합니다.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

설치 후 확인:

```bash
opencode --version
which opencode
```

현재 shell이 PATH를 아직 새로고침하지 않았다면 터미널을 다시 열거나 설치 로그에 표시된 profile을 source 하세요.

### 설치 디렉터리 지정

사용자 단위 설치는 `~/.local/bin`을 권장합니다. 환경 변수는 `curl`에만 전달하지 말고 installer를 실행하는 `bash` 프로세스에 전달해야 합니다.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

문제 해결 시에는 먼저 스크립트를 다운로드한 뒤 실행하세요.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

다음처럼 작성하지 마세요.

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

이 방식은 `OPENCODE_INSTALL_DIR`을 `curl`에만 전달하고 실제로 installer를 실행하는 `bash` 프로세스에는 전달하지 않습니다.

### 버전 지정

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

이것이 완전한 형식입니다. `bash -s --`는 `bash`가 stdin에서 installer를 읽고 `--version 1.15.7-smark`를 installer 인수로 전달하라는 뜻입니다. 버전은 `1.15.7-smark` 또는 release tag 형식인 `v1.15.7-smark`를 사용할 수 있습니다.

### Installer 동작

| 시나리오 | 동작 |
| --- | --- |
| 기본 설치 디렉터리 | `$OPENCODE_INSTALL_DIR`, 그다음 `$XDG_BIN_DIR`, 그다음 `$HOME/.opencode/bin` |
| 대상 경로에 같은 버전이 이미 있음 | 다시 설치하고 덮어씀. 손상되었거나 오래된 바이너리를 새로고침할 때 유용 |
| PATH의 다른 위치에 같은 버전이 이미 있음 | 알림만 출력하며 요청한 디렉터리로의 설치를 막지 않음 |
| PATH 기록 | 기본적으로 지원되는 기존 profile을 모두 업데이트하고 중복 항목을 피함 |
| sudo | 기본적으로 `sudo` 시작을 거부함. 시스템 설치는 명시적으로 `--allow-sudo`를 전달해야 함 |
| macOS quarantine | 설치 후 `com.apple.quarantine` 속성 제거를 시도함 |
| checksum | release가 `checksums.txt`를 제공하면 다운로드한 asset을 검증함 |

### PATH와 Shell Profile

installer는 기존 profile을 감지하고 업데이트합니다: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*`, `~/.config/fish/config.fish`.

| 필요 | 명령 |
| --- | --- |
| PATH를 수정하지 않음 | `bash /tmp/opencode-install --no-modify-path` |
| 하나의 profile에만 기록 | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| profile을 대화형으로 선택 | `bash /tmp/opencode-install --interactive` |
| 시스템 디렉터리에 설치 | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

`~/.local/bin/opencode`가 `/usr/local/bin/opencode`보다 우선되게 하려면 profile의 PATH 순서가 다음과 같도록 하세요.

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 기타 설치 방법

이 방법들은 업스트림 패키지 매니저 생태계를 사용합니다. SMARK 브랜치 빌드가 필요하면 위의 GitHub release installer를 우선 사용하세요.

| 플랫폼 | 명령 | 참고 |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | `bun`, `pnpm`, `yarn`도 사용할 수 있음 |
| macOS/Linux | `brew install anomalyco/tap/opencode` | 업스트림 tap, 보통 빠르게 업데이트됨 |
| macOS/Linux | `brew install opencode` | 공식 Homebrew formula, 지연될 수 있음 |
| Windows | `scoop install opencode` | Scoop package |
| Windows | `choco install opencode` | Chocolatey package |
| Arch Linux | `sudo pacman -S opencode` | Stable package |
| Arch Linux | `paru -S opencode-bin` | 최신 AUR binary package |
| 모든 시스템 | `mise use -g opencode` | mise로 tool version 관리 |
| Nix | `nix run nixpkgs#opencode` | GitHub에서 development version도 실행 가능 |

---

## 빠른 시작

```bash
cd <your-project>
opencode
```

시작 후 "explain this module architecture", "fix this error", "add tests for this feature"처럼 작업을 바로 설명하세요. TUI에서는 `Tab`으로 agent를 전환하고 내장 tools로 파일 읽기/쓰기, 명령 실행, diff 검사, 세션 관리를 수행합니다.

| 작업 | 설명 |
| --- | --- |
| `Tab` | 사용 가능한 agent 사이 전환 |
| Session list | 기록을 보고 제목 및 메시지 내용 검색 |
| Diff preview | 파일 쓰기 전후의 git diff 스타일 변경 표시 |
| Manual compaction | 긴 세션에서 context를 선제적으로 압축해 token 공간 확보 |
| Shell tool | 취소, output compression, PowerShell output normalization 지원 |

---

## 데스크톱 앱

SMARK `dev-smark` 브랜치는 현재 CLI release만 게시하며 desktop app installer는 게시하지 않습니다. desktop app(BETA)은 [opencode.ai/download](https://opencode.ai/download)와 업스트림 release notes를 신뢰 기준으로 사용하세요. SMARK CLI release 페이지를 desktop installer 출처로 취급하지 마세요.

---

## 핵심 기능

이 브랜치는 기능을 단순히 쌓아 올린 것이 아니라, 흔한 개발 고충을 관찰 가능하고 복구 가능하며 cross-platform인 workflow로 바꿉니다.

| 영역 | 해결하는 문제 | 보게 될 것 |
| --- | --- | --- |
| TUI interaction | 긴 출력, streaming message, 읽기 어려운 diff | Live rendering, collapsible reasoning, diff preview, 즉시 상태 업데이트 |
| Session management | 긴 세션에서 context가 손실되고 복구 비용이 큼 | Session search, path filters, manual compaction, interrupt recovery, Session Warping |
| Token statistics | 무엇이 context를 소비하는지 알기 어려움 | Input/output tokens, tool results, attachments, request overhead breakdowns |
| Tool system | File 및 shell output이 context를 오염시킬 수 있음 | Structured Read output, Shell output compression, Write auto diff |
| Provider | Multi-account, endpoint, model 설정이 복잡함 | Provider aliases, client version override, ClaudeCode provider |
| VSCode | Notebook 시나리오를 CLI agents가 안정적으로 조작할 수 없음 | Cell summary, read, edit, run, output read, kernel management |
| Windows | PowerShell, encoding, paths, CRLF가 오류를 일으키기 쉬움 | CLIXML decoding, UTF-8 fixes, path normalization, CRLF preservation |
| Network proxy | Provider, plugin, fetch proxy logic이 흩어져 있음 | NetworkProxy가 HTTP_PROXY, HTTPS_PROXY, NO_PROXY를 일관되게 처리 |
| Daemon | Multi-instance, locks, health checks, clients가 복잡함 | Server Lock, health checks, HttpApi, PTY WebSocket tickets |

### TUI와 상호작용 경험

| 기능 | 세부 정보 |
| --- | --- |
| Streaming output | Assistant messages와 reasoning chunks가 점진적으로 렌더링되고 streaming 중 elapsed time 표시 |
| Reasoning display | 긴 reasoning을 접어 화면 사용량을 줄일 수 있음 |
| Diff preview | 파일 overwrite 시 추가/삭제 line counts와 함께 git diff 스타일 view 자동 생성 |
| Session list | 최근 message summaries를 표시하고 title 및 message content 검색 지원 |
| Layout stability | Scrollbars, terminal width handling, CJK character width handling의 안정성 향상 |
| Shell mode | Cancel button, custom icon, example placeholder, live completion status 제공 |

### 세션과 Context 관리

| 기능 | 세부 정보 |
| --- | --- |
| Session recovery | Hidden messages, undo operations, pending-message checks, error recovery가 더 견고함 |
| Interrupt control | Interrupt count와 confirmation time을 기록하며 parent session interrupts가 subtasks로 전파됨 |
| Path compatibility | Windows global session paths가 normalized되고 session storage는 relative paths 사용 |
| Manual compaction | 사용자가 compaction을 trigger할 수 있고 compaction selection은 비동기로 처리되며 errors 보고 |
| Git context | 현재 branch, status, recent commits 및 관련 데이터를 config switch로 자동 주입 |

### Token과 비용 가시성

| 항목 | 사용법 | 표시 |
| --- | --- | --- |
| TUI Context usage | 세션에서 `/context` 실행 또는 command palette에서 `Context usage` 선택 | 현재 context window, model, used/available tokens, Prompt/Conversation/Window category grid 표시 |
| Context usage footer | TUI panel 하단 | Session usage가 있으면 `Input`, `Output`, `Reason`, `Cache W/R`, `Cost` 표시. cumulative usage가 없으면 `Used`, `Free`, `Usable`, `Buffer` 표시 |
| Session list cost column | `opencode session list --cost` 또는 `opencode session list -c` | Session list에 `Cost`와 `Tokens` columns를 추가해 cost hotspot을 빠르게 찾음 |
| Single-session details | `opencode session info -s <Session_ID>` | Provider/model별 `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` 표시 |
| Global stats | `opencode stats --models` | Total cost, daily average cost, average tokens, tool usage, model usage 요약 |

내부 통계는 request usage data를 우선 사용하고 오래된 세션은 message metadata로 fallback합니다. TUI Context usage는 instruction, skills, tool definitions, attachments, tool results, compaction summary가 context window에서 차지하는 양도 추정합니다.

### Tool System

| Tool | Enhancement |
| --- | --- |
| Read | Metadata, stub, default read line count, byte limits, device-file protection |
| Grep/Ripgrep | Limits maximum files and result counts, with clear errors for overly broad searches |
| Shell | bash, PowerShell, and cmd use shell-aware prompts separately |
| Write | Automatically generates a diff when overwriting files so users can confirm the actual change |
| Permission | Parent-agent permissions are filtered before passing to subtasks; tool availability checks are stricter |

### Provider와 Models

| 기능 | 설명 |
| --- | --- |
| Provider aliases | 같은 underlying provider에 여러 계정 또는 endpoint 설정 |
| Client version override | Custom providers, compatibility proxies, special API endpoints에 맞춤 |
| ClaudeCode provider | API Key, Base URL, dynamic authentication modes 지원 |
| Cloudflare AI Gateway | Routing fixes. Non-Anthropic models는 tool streaming이 기본적으로 비활성화됨 |

### VS Code Notebook 통합

Notebook tools를 사용하기 전에 VS Code extension [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge)를 설치하세요. Extension version은 `1.15.5`로 유지되며 SMARK CLI `1.15.7`과 계속 함께 사용할 수 있습니다. 이 CLI README 업데이트를 위해 업그레이드할 필요가 없습니다. Extension은 VS Code/Jupyter Notebook과 OpenCode CLI 사이에 local authenticated bridge를 만듭니다. 설치되어 있지 않거나 연결되어 있지 않으면 CLI가 notebook cells를 안정적으로 읽고, 편집하고, 실행할 수 없습니다.

시작 후 extension은 `127.0.0.1:<random port>`에 local bridge를 열고 heartbeat manifest를 `~/.local/state/opencode/ide/<uuid>.json`에 씁니다. OpenCode는 workspace와 notebook path를 기준으로 일치하는 VS Code bridge를 자동 선택합니다. Remote SSH, WSL, container 환경에서는 CLI가 bridge에 접근할 수 있는 같은 쪽에서 실행되어야 합니다.

| Tool | Purpose |
| --- | --- |
| `vscode_notebook_summary` | Notebook cells의 안정적인 `#VSC-*` IDs, display index, type, language, execution state, output summary, dirty state, runtime info 가져오기 |
| `vscode_notebook_source` | 1-based global virtual line numbers로 notebook source 읽기. 반환 내용은 기본적으로 16KB로 제한됨 |
| `vscode_notebook_edit` | Cell 삽입, 편집, 삭제. 정확한 `oldCode/newCode` string replacement 및 code/markdown type switching 지원 |
| `vscode_notebook_run` | VS Code/Jupyter를 통해 하나의 code cell 또는 stable-ID range 실행. Range execution은 실패나 timeout에서 중단됨 |
| `vscode_notebook_output` | Text, image, HTML, JSON 및 기타 outputs 읽기. 큰 outputs는 `.opencode/cache/notebook-outputs/`에 기록되고 artifact paths로 반환됨 |
| `vscode_notebook_env` | Kernel/runtime 검사, kernel selection trigger, kernel restart, 또는 사용자가 명시적으로 요청한 경우 notebook 저장 |

권장 flow: `vscode_notebook_summary`로 현재 cell ID를 가져오고, `vscode_notebook_source`로 target cell을 읽고, edit 후 `vscode_notebook_run`으로 검증하고, `vscode_notebook_output`으로 결과를 확인하세요. Display index `cN`을 장기적으로 안정적인 reference로 취급하지 마세요. Insert, delete, type switch 후에는 tool이 반환한 새 `#VSC-*` ID를 사용하거나 summary를 다시 실행하세요.

### Cross-Platform Support

| Platform Issue | Handling |
| --- | --- |
| Windows encoding | UTF-8/UTF-16LE를 자동 감지하고 pipe mojibake 복구 |
| PowerShell | CLIXML decoding, stderr normalization, UTF-8 output repair |
| Path differences | Casing, separators, global session paths normalize |
| Line endings | Patches 적용 시 원래 CRLF/LF style 보존 |
| WSL | Migration 및 cross-platform build guides 유지 |

---

## Agents

OpenCode에는 `Tab`으로 전환할 수 있는 여러 built-in primary agents가 포함되어 있습니다. Default agent는 `default_agent`로 override할 수 있고 subagents는 주로 task dispatch 또는 `@agent`로 호출됩니다.

| Agent | Type | Permission Model | Best For |
| --- | --- | --- | --- |
| `build` | primary | 기본 development mode. Configured permissions에 따라 tools를 실행하고 question confirmation 및 plan 진입 허용 | Features 구현, bugs 수정, tests 실행, end-to-end delivery |
| `interactive` | primary | 더 보수적인 interactive mode. `bash`, notebook execution, notebook environment operations는 기본적으로 질문 | Key commands 확인이 필요한 작업 또는 accidental operations 위험을 낮춰야 하는 작업 |
| `auto` | primary | 명시적으로 선택할 때만 활성화됨. `bash`, `edit`, shell external directory access는 auto permission review로 진입 | 기본 build behavior를 실수로 바꾸지 않으면서 shell/edit risk를 자동 검토 |
| `decide` | primary | Tools를 비활성화하고 제한된 recent context에서 one-shot judgment 수행 | High-performance model로 더 낮은 비용의 one-off decisions, tradeoffs, next-step choices |
| `plan` | primary | Edit tools와 notebook changes를 허용하지 않음. Plan files 작성 및 exiting plan 허용 | Code analysis, planning, risk review, pre-execution design |
| `general` | subagent | General subagent. `todowrite`를 금지하고 그 외에는 merged permission config를 따름 | Complex search, multi-step research, parallelizable support tasks |
| `explore` | subagent | Search, read, list, web query 및 유사 exploration tools만 허용 | Files, symbols, call chains, config, docs를 빠르게 찾기 |
| `scout` | subagent, experimental | External docs와 dependency source 대상. Managed repo cache reads 허용 | Third-party library implementation 검사, dependency source cloning, external API behavior 조사 |

`title`, `summary`, `compaction`은 title generation, summaries, compaction flows를 위한 hidden system agents이며 일상적인 수동 전환 대상이 아닙니다. [Agents](https://opencode.ai/docs/agents)에 대해 더 알아보세요.

---

## 문서

| Resource | Link |
| --- | --- |
| Official docs | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Contributing guide | [CONTRIBUTING.md](../../CONTRIBUTING.md) |

---

## FAQ

### Claude Code와 어떻게 다른가요?

기능 목표는 비슷하지만 OpenCode는 open source, terminal-first usage, provider independence, client/server architecture, extensible tool system에 집중합니다. SMARK 브랜치는 여기에 더해 Windows/PowerShell, VS Code Notebook, token visibility, network proxy support, installation experience를 강화합니다.

### 이 브랜치는 누구를 위한 것인가요?

Terminal에서 자주 개발하거나 auditable agent behavior가 필요하거나 Windows/PowerShell 또는 VS Code Notebook 시나리오에서 AI coding agents를 사용한다면, 이 브랜치는 업스트림 기본값보다 더 완성된 경험을 제공합니다.

### Installer가 기본적으로 sudo를 사용하지 않는 이유는 무엇인가요?

사용자 단위 설치가 더 안전하고 관리하기 쉽습니다. Installer는 기본적으로 user directory에 쓰고 implicit sudo를 거부합니다. `/usr/local/bin` 같은 system directory에 명시적으로 설치할 때만 `sudo env ... --allow-sudo`를 사용하세요. 또한 root가 user profiles를 수정하지 않도록 `--no-modify-path` 사용도 고려하세요.

### 시스템에 오래된 opencode가 이미 있으면 어떻게 되나요?

Installer는 target install path만 신뢰합니다. `/usr/local/bin/opencode`에 같은 버전이 이미 있더라도 `OPENCODE_INSTALL_DIR="$HOME/.local/bin"`을 지정하면 여전히 `~/.local/bin/opencode`에 설치하며 PATH의 오래된 binary에 의해 차단되지 않습니다.

---

## 기여하기

PR을 제출하기 전에 [contributing guide](../../CONTRIBUTING.md)를 읽어주세요. 자신의 project name에 `opencode`를 사용하는 경우, README에 해당 project가 공식 OpenCode team project가 아니며 OpenCode team과 제휴되어 있지 않다고 명시하세요.

---

## 커뮤니티

**커뮤니티에 참여하기** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
