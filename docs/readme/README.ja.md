<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="../../packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="../../packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="../../packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">オープンソースの AI Coding Agent — SMARK 強化ブランチ</p>
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

> **このブランチについて**: これは OpenCode の `dev-smark` 強化ブランチです（現在のバージョン `1.15.7`、CLI release tag は `v1.15.7-smark`）。上流 `dev` を基にしており、TUI 操作、セッション管理、Token 統計、Windows/PowerShell 互換性、VS Code Notebook 統合、ネットワークプロキシ対応、インストール体験に重点を置いています。

---

## クイックインストール

SMARK ブランチの releases ページにある installer を使用してください。デフォルトでは最新 release をインストールし、既存の shell profile にインストールディレクトリを書き込みます。

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

インストール後に確認します。

```bash
opencode --version
which opencode
```

現在の shell で PATH がまだ更新されていない場合は、terminal を開き直すか、インストールログに表示された profile を source してください。

### インストールディレクトリを指定する

ユーザーレベルのインストール先には `~/.local/bin` を推奨します。環境変数は `curl` だけではなく、installer を実行する `bash` プロセスへ渡す必要があります。

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

トラブルシューティングでは、先にスクリプトをダウンロードしてから実行してください。

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

次のようには書かないでください。

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

これは `OPENCODE_INSTALL_DIR` を `curl` に渡すだけで、実際に installer を実行する `bash` プロセスには渡しません。

### バージョンを指定する

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

これが完全な形式です。`bash -s --` は `bash` に stdin から installer を読ませ、`--version 1.15.7-smark` を installer 引数として渡します。バージョンは `1.15.7-smark`、または release tag 形式の `v1.15.7-smark` を指定できます。

### Installer の動作

| シナリオ | 動作 |
| --- | --- |
| デフォルトのインストールディレクトリ | `$OPENCODE_INSTALL_DIR`、次に `$XDG_BIN_DIR`、次に `$HOME/.opencode/bin` |
| 対象パスに同じバージョンが既にある | 再インストールして上書きし、破損または古い binary の更新に使える |
| PATH 内の別の場所に同じバージョンがある | 通知だけを表示し、要求されたディレクトリへのインストールはブロックしない |
| PATH 書き込み | デフォルトでは既存の対応 profile をすべて更新し、重複 entry を避ける |
| sudo | デフォルトでは `sudo` 起動を拒否する。system install では明示的に `--allow-sudo` を渡す必要がある |
| macOS quarantine | インストール後に `com.apple.quarantine` 属性の削除を試みる |
| checksum | release が `checksums.txt` を提供している場合、download asset を検証する |

### PATH と shell profile

Installer は既存の profile を検出して更新します: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*`, `~/.config/fish/config.fish`。

| 必要なこと | コマンド |
| --- | --- |
| PATH を変更しない | `bash /tmp/opencode-install --no-modify-path` |
| 1 つの profile だけに書く | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| profile を対話的に選ぶ | `bash /tmp/opencode-install --interactive` |
| system directory にインストールする | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

`~/.local/bin/opencode` を `/usr/local/bin/opencode` より優先したい場合は、profile の PATH 順序が次のようになっていることを確認してください。

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### その他のインストール方法

これらの方法は上流の package-manager ecosystem を使用します。SMARK ブランチ build が必要な場合は、上記の GitHub release installer を優先してください。

| Platform | Command | Notes |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | `bun`、`pnpm`、`yarn` も使用できます |
| macOS/Linux | `brew install anomalyco/tap/opencode` | 上流 tap。通常は素早く更新されます |
| macOS/Linux | `brew install opencode` | 公式 Homebrew formula。遅れる場合があります |
| Windows | `scoop install opencode` | Scoop package |
| Windows | `choco install opencode` | Chocolatey package |
| Arch Linux | `sudo pacman -S opencode` | Stable package |
| Arch Linux | `paru -S opencode-bin` | 最新の AUR binary package |
| Any system | `mise use -g opencode` | mise で tool version を管理します |
| Nix | `nix run nixpkgs#opencode` | GitHub から development version を実行することもできます |

---

## クイックスタート

```bash
cd <your-project>
opencode
```

起動後は、「この module architecture を説明して」「この error を修正して」「この feature の test を追加して」のように、task を直接記述します。TUI では `Tab` で agent を切り替え、built-in tools でファイルの読み書き、コマンド実行、diff 確認、session 管理を行います。

| Action | Description |
| --- | --- |
| `Tab` | 利用可能な agent を切り替える |
| Session list | 履歴を表示し、title と message content を検索する |
| Diff preview | file write の前後に git diff style の変更を表示する |
| Manual compaction | 長い session で context を能動的に compact し、token space を解放する |
| Shell tool | cancellation、output compression、PowerShell output normalization をサポートする |

---

## Desktop App

SMARK `dev-smark` ブランチは現在 CLI releases のみを公開しており、desktop app installer は公開していません。desktop app (BETA) については [opencode.ai/download](https://opencode.ai/download) と上流 release notes を信頼できる情報源として使用してください。SMARK CLI release page を desktop installer source として扱わないでください。

---

## Core Features

このブランチは単なる機能の寄せ集めではありません。一般的な開発上の痛点を、観測可能で、復旧可能で、cross-platform な workflow に変えます。

| Area | Problem Solved | What You Will See |
| --- | --- | --- |
| TUI interaction | 長い出力、streaming messages、読みにくい diffs | Live rendering、collapsible reasoning、diff preview、instant status updates |
| Session management | 長い sessions は context を失いやすく、復旧 cost が高い | Session search、path filters、manual compaction、interrupt recovery、Session Warping |
| Token statistics | 何が context を消費しているか分かりにくい | Input/output tokens、tool results、attachments、request overhead breakdowns |
| Tool system | File と shell output が context を汚染しやすい | Structured Read output、Shell output compression、Write auto diff |
| Provider | Multi-account、endpoint、model setup が複雑 | Provider aliases、client version override、ClaudeCode provider |
| VSCode | Notebook scenarios を CLI agents が確実に操作できない | Cell summary、read、edit、run、output read、kernel management |
| Windows | PowerShell、encoding、paths、CRLF で error が起きやすい | CLIXML decoding、UTF-8 fixes、path normalization、CRLF preservation |
| Network proxy | Provider、plugin、fetch proxy logic が分散している | NetworkProxy が HTTP_PROXY、HTTPS_PROXY、NO_PROXY を一貫して処理する |
| Daemon | Multi-instance、locks、health checks、clients が複雑 | Server Lock、health checks、HttpApi、PTY WebSocket tickets |

### TUI と操作体験

| Capability | Details |
| --- | --- |
| Streaming output | Assistant messages と reasoning chunks を incremental に render し、streaming 中は elapsed time を表示する |
| Reasoning display | 長い reasoning を collapse して screen usage を減らせる |
| Diff preview | File overwrite 時に git diff style view を自動生成し、added/deleted line counts を表示する |
| Session list | 最近の message summaries を表示し、title と message content による検索をサポートする |
| Layout stability | Scrollbars、terminal width handling、CJK character width handling の信頼性を高める |
| Shell mode | cancel button、custom icon、example placeholder、live completion status を提供する |

### Session と Context Management

| Capability | Details |
| --- | --- |
| Session recovery | Hidden messages、undo operations、pending-message checks、error recovery がより堅牢になる |
| Interrupt control | interrupt counts と confirmation time を記録し、parent session interrupts を subtasks に伝播する |
| Path compatibility | Windows global session paths を normalize し、session storage は relative paths を使用する |
| Manual compaction | user が compaction を trigger でき、compaction selection は asynchronous に処理され error を報告する |
| Git context | current branch、status、recent commits、関連 data を config switch により自動注入する |

### Token と Cost Visibility

| Entry | Usage | Display |
| --- | --- | --- |
| TUI Context usage | session で `/context` を実行するか、command palette から `Context usage` を選ぶ | 現在の context window、model、used/available tokens、Prompt/Conversation/Window category grid を表示する |
| Context usage footer | TUI panel の下部 | session usage がある場合は `Input`, `Output`, `Reason`, `Cache W/R`, `Cost` を表示し、cumulative usage がない場合は `Used`, `Free`, `Usable`, `Buffer` を表示する |
| Session list cost column | `opencode session list --cost` または `opencode session list -c` | session list に `Cost` と `Tokens` columns を追加し、cost hotspots を素早く見つける |
| Single-session details | `opencode session info -s <Session_ID>` | provider/model ごとに `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` を表示する |
| Global stats | `opencode stats --models` | total cost、daily average cost、average tokens、tool usage、model usage を要約する |

内部 stats は request usage data を優先し、古い sessions では message metadata に fallback します。TUI Context usage は instruction、skills、tool definitions、attachments、tool results、compaction summary が context window で占める量も推定します。

### Tool System

| Tool | Enhancement |
| --- | --- |
| Read | Metadata、stub、default read line count、byte limits、device-file protection |
| Grep/Ripgrep | maximum files と result counts を制限し、過度に broad な searches には明確な errors を出す |
| Shell | bash、PowerShell、cmd がそれぞれ shell-aware prompts を使用する |
| Write | files を overwrite するときに diff を自動生成し、user が実際の変更を確認できるようにする |
| Permission | parent-agent permissions を subtasks に渡す前に filter し、tool availability checks をより厳格にする |

### Provider と Models

| Capability | Description |
| --- | --- |
| Provider aliases | 同じ underlying provider に対して複数の accounts または endpoints を設定する |
| Client version override | custom providers、compatibility proxies、special API endpoints に適応する |
| ClaudeCode provider | API Key、Base URL、dynamic authentication modes をサポートする |
| Cloudflare AI Gateway | Routing fixes。non-Anthropic models では tool streaming がデフォルトで無効になる |

### VS Code Notebook Integration

Notebook tools を使用する前に、VS Code extension [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge) をインストールしてください。extension version は `1.15.5` のままで、SMARK CLI `1.15.7` と引き続き動作します。この CLI README update のために upgrade する必要はありません。この extension は VS Code/Jupyter Notebook と OpenCode CLI の間に local authenticated bridge を作成します。インストールまたは接続されていない場合、CLI は notebook cells を確実に read、edit、run できません。

起動後、extension は `127.0.0.1:<random port>` に local bridge を開き、heartbeat manifest を `~/.local/state/opencode/ide/<uuid>.json` に書き込みます。OpenCode は workspace と notebook path によって一致する VS Code bridge を自動選択します。remote SSH、WSL、container setup では、CLI は bridge にアクセスできる同じ側で実行する必要があります。

| Tool | Purpose |
| --- | --- |
| `vscode_notebook_summary` | notebook cells の stable `#VSC-*` IDs、display index、type、language、execution state、output summary、dirty state、runtime info を取得する |
| `vscode_notebook_source` | 1-based global virtual line numbers で notebook source を読む。返される content はデフォルトで 16KB に制限される |
| `vscode_notebook_edit` | cells を insert、edit、delete する。exact `oldCode/newCode` string replacement と code/markdown type switching をサポートする |
| `vscode_notebook_run` | VS Code/Jupyter 経由で 1 つの code cell または stable-ID range を実行する。range execution は failure または timeout で停止する |
| `vscode_notebook_output` | text、image、HTML、JSON、その他の outputs を読む。large outputs は `.opencode/cache/notebook-outputs/` に書き込まれ、artifact paths として返される |
| `vscode_notebook_env` | kernel/runtime の inspect、kernel selection の trigger、kernel restart、または user が明示的に要求した場合の notebook save を行う |

Recommended flow: `vscode_notebook_summary` で現在の cell ID を取得し、`vscode_notebook_source` で target cell を読み、edit 後に `vscode_notebook_run` で validate し、`vscode_notebook_output` で results を inspect します。display index `cN` を長期的に安定した reference として扱わないでください。insert、delete、type switch の後は、tool が返す新しい `#VSC-*` ID を使用するか、summary を再実行してください。

### Cross-Platform Support

| Platform Issue | Handling |
| --- | --- |
| Windows encoding | UTF-8/UTF-16LE を auto-detect し、pipe mojibake を修復する |
| PowerShell | CLIXML decoding、stderr normalization、UTF-8 output repair |
| Path differences | casing、separators、global session paths を normalize する |
| Line endings | patches を apply するときに元の CRLF/LF style を preserve する |
| WSL | migration と cross-platform build guides を維持する |

---

## Agents

OpenCode には複数の built-in primary agents が含まれており、`Tab` で切り替えられます。default agent は `default_agent` で override できます。subagents は主に task dispatch または `@agent` で呼び出されます。

| Agent | Type | Permission Model | Best For |
| --- | --- | --- | --- |
| `build` | primary | デフォルトの development mode。configured permissions に従って tools を実行し、question confirmation と plan への移行を許可する | features の実装、bugs の修正、tests の実行、end-to-end delivery |
| `interactive` | primary | より保守的な interactive mode。`bash`、notebook execution、notebook environment operations はデフォルトで質問する | key commands の confirmation が必要な tasks、または accidental operations の risk を下げたい tasks |
| `auto` | primary | 明示的に選択した場合のみ有効。`bash`、`edit`、shell external directory access は auto permission review に入る | デフォルトの build behavior を意図せず変更せずに shell/edit risk を自動 review したい場合 |
| `decide` | primary | tools を無効化し、limited recent context から one-shot judgment を行う | high-performance model による low-cost の one-off decisions、tradeoffs、next-step choices |
| `plan` | primary | edit tools と notebook changes を禁止し、plan files の書き込みと plan の終了を許可する | code analysis、planning、risk review、pre-execution design |
| `general` | subagent | General subagent。`todowrite` を禁止し、それ以外は merged permission config に従う | complex search、multi-step research、parallelizable support tasks |
| `explore` | subagent | search、read、list、web query などの exploration tools のみを許可する | files、symbols、call chains、config、docs を素早く locating する |
| `scout` | subagent, experimental | external docs と dependency source を対象にし、managed repo cache reads を許可する | third-party library implementation の調査、dependency source の cloning、external API behavior の research |

`title`、`summary`、`compaction` は title generation、summaries、compaction flows のための hidden system agents であり、日常的に手動で切り替える対象ではありません。[Agents](https://opencode.ai/docs/agents) で詳細を確認できます。

---

## Documentation

| Resource | Link |
| --- | --- |
| Official docs | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Contributing guide | [CONTRIBUTING.md](../../CONTRIBUTING.md) |

---

## FAQ

### Claude Code とは何が違いますか？

能力の target は似ていますが、OpenCode は open source、terminal-first usage、provider independence、client/server architecture、extensible tool system に重点を置いています。SMARK ブランチはさらに Windows/PowerShell、VS Code Notebook、token visibility、network proxy support、installation experience を強化しています。

### このブランチは誰向けですか？

terminal で開発することが多い、auditable agent behavior が必要、または Windows/PowerShell や VS Code Notebook scenarios で AI coding agents を使用する場合、このブランチは上流 defaults より complete な experience を提供します。

### なぜ installer はデフォルトで sudo を使わないのですか？

User-level installation はより安全で管理しやすいです。installer はデフォルトで user directory に書き込み、implicit sudo を拒否します。`/usr/local/bin` のような system directory に明示的に install する場合だけ、`sudo env ... --allow-sudo` を使用してください。また、root が user profiles を変更しないよう `--no-modify-path` も検討してください。

### 古い opencode が system に既にある場合はどうなりますか？

Installer は target install path だけを信頼します。`/usr/local/bin/opencode` に同じ version が既にあっても、`OPENCODE_INSTALL_DIR="$HOME/.local/bin"` を指定すれば `~/.local/bin/opencode` にインストールされ、PATH 上の古い binary によってブロックされることはありません。

---

## Contributing

PR を送信する前に [contributing guide](../../CONTRIBUTING.md) を読んでください。自分の project name に `opencode` を使用する場合は、その README に、その project が official OpenCode team project ではなく、OpenCode team と affiliated していないことを明記してください。

---

## Community

**Join our community** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
