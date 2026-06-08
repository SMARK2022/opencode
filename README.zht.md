<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">開源的 AI Coding Agent — SMARK 增強分支</p>
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

> **關於本分支**：這是 OpenCode 的 `dev-smark` 增強分支（目前版本 `1.15.6`，CLI release tag 為 `v1.15.6-smark`）。它基於上游 `dev` 分支，重點增強 TUI 互動、會話管理、Token 統計、Windows/PowerShell 相容性、VSCode Notebook 整合、網路代理與安裝體驗。

---

## 快速安裝

建議使用 SMARK 分支發布頁中的安裝腳本。預設會安裝最新 release，並把安裝目錄寫入既有的 shell profile。

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

安裝後驗證：

```bash
opencode --version
which opencode
```

如果目前 shell 尚未重新整理 PATH，可以重新開啟終端機，或依安裝日誌提示 source 對應的 profile。

### 指定安裝目錄

使用者層級安裝建議放到 `~/.local/bin`。注意環境變數必須傳給右側執行 installer 的 `bash`，不要只傳給 `curl`。

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

較適合排查問題的寫法是先下載腳本，再執行：

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

不要這樣寫：

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

這種寫法只會把 `OPENCODE_INSTALL_DIR` 傳給 `curl`，不會傳給真正執行安裝腳本的 `bash`。

### 指定版本

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.6-smark
```

這是完整寫法：`bash -s --` 表示讓 `bash` 從 stdin 讀取 installer，並把後面的 `--version 1.15.6-smark` 作為 installer 參數傳入。版本參數可以寫 `1.15.6-smark`，也可以寫 release tag 形式的 `v1.15.6-smark`。

### 安裝腳本行為

| 場景 | 行為 |
| --- | --- |
| 預設安裝目錄 | `$OPENCODE_INSTALL_DIR`，然後 `$XDG_BIN_DIR`，最後 `$HOME/.opencode/bin` |
| 目標路徑已有同版本 | 重新覆蓋安裝，用於刷新損壞或過期的二進位檔 |
| PATH 裡其他位置已有同版本 | 只列印提示，不阻止安裝到指定目錄 |
| PATH 寫入 | 預設更新所有已存在的受支援 profile，且不會重複寫入 |
| sudo | 預設拒絕 `sudo` 啟動；系統級安裝需要明確傳 `--allow-sudo` |
| macOS quarantine | 安裝後自動嘗試移除 `com.apple.quarantine` 屬性 |
| checksum | 如果 release 提供 `checksums.txt`，會校驗下載資產 |

### PATH 與 shell profile

安裝腳本會識別並更新這些已存在的 profile：`.bashrc`、`.bash_profile`、`.profile`、`.zshrc`、`.zprofile`、`.zshenv`、`~/.config/bash/*`、`~/.config/zsh/*`、`~/.config/fish/config.fish`。

| 需求 | 命令 |
| --- | --- |
| 不修改 PATH | `bash /tmp/opencode-install --no-modify-path` |
| 只寫入指定 profile | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| 互動選擇 profile | `bash /tmp/opencode-install --interactive` |
| 系統目錄安裝 | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

如果你希望 `~/.local/bin/opencode` 優先於 `/usr/local/bin/opencode`，請確保 profile 裡的 PATH 順序類似這樣：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 其他安裝方式

這些方式適合使用上游套件管理生態。若你需要 SMARK 分支版本，請優先使用上面的 GitHub release installer。

| 平台 | 命令 | 說明 |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | 也可使用 `bun`、`pnpm`、`yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | 上游 tap，通常更新較快 |
| macOS/Linux | `brew install opencode` | Homebrew 官方 formula，可能滯後 |
| Windows | `scoop install opencode` | Scoop 套件 |
| Windows | `choco install opencode` | Chocolatey 套件 |
| Arch Linux | `sudo pacman -S opencode` | 穩定套件 |
| Arch Linux | `paru -S opencode-bin` | AUR 最新二進位套件 |
| 任意系統 | `mise use -g opencode` | 透過 mise 管理工具版本 |
| Nix | `nix run nixpkgs#opencode` | 也可使用 GitHub 來源執行開發版本 |

---

## 快速開始

```bash
cd <your-project>
opencode
```

啟動後可以直接描述任務，例如「解釋這個模組的架構」、「修復這個錯誤」、「替這個功能補測試」。TUI 內使用 `Tab` 切換 Agent，使用內建工具讀寫檔案、執行命令、查看 diff、管理會話。

| 操作 | 說明 |
| --- | --- |
| `Tab` | 在可用 Agent 之間切換 |
| 會話列表 | 查看歷史會話、搜尋標題和訊息內容 |
| Diff 預覽 | 寫入檔案前後展示 git diff 風格變更 |
| 手動壓縮 | 長會話中主動壓縮上下文，釋放 token 空間 |
| Shell 工具 | 支援取消、輸出壓縮、PowerShell 輸出正規化 |

---

## 桌面應用程式

SMARK `dev-smark` 分支目前只發布 CLI，不發布桌面應用安裝包。需要桌面版（BETA）時，請以 [opencode.ai/download](https://opencode.ai/download) 和上游 release 說明為準；不要把 SMARK CLI release 頁面當作 desktop 安裝包來源。

---

## 核心特性

這個分支的重點不是簡單堆功能，而是把真實開發中的高頻痛點做成可觀察、可復原、可跨平台的工作流。

| 方向 | 解決的問題 | 你會看到的變化 |
| --- | --- | --- |
| TUI 互動 | 長輸出、串流訊息、diff 難讀 | 即時渲染、可折疊推理、差異預覽、狀態即時更新 |
| 會話管理 | 長會話易丟上下文，復原成本高 | 會話搜尋、路徑過濾、手動壓縮、中斷復原、Session Warping |
| Token 統計 | 不知道上下文被什麼消耗 | 輸入/輸出 token、工具結果、附件、請求開銷分項展示 |
| 工具系統 | 檔案讀寫和 shell 輸出容易污染上下文 | Read 輸出結構化、Shell 輸出壓縮、Write 自動 diff |
| Provider | 多帳號、多端點、多模型設定複雜 | Provider 別名、客戶端版本覆蓋、ClaudeCode provider |
| VSCode | Notebook 場景無法被 CLI Agent 可靠操作 | 單元格概覽、讀取、編輯、執行、輸出讀取、kernel 管理 |
| Windows | PowerShell、編碼、路徑、CRLF 容易出錯 | CLIXML 解碼、UTF-8 修復、路徑正規化、CRLF 保留 |
| 網路代理 | provider、plugin、fetch 代理邏輯分散 | NetworkProxy 統一處理 HTTP_PROXY、HTTPS_PROXY、NO_PROXY |
| 守護行程 | 多實例、鎖、健康檢查、客戶端連線複雜 | Server Lock、健康檢查、HttpApi、PTY WebSocket 票據 |

### TUI 與互動體驗

| 能力 | 細節 |
| --- | --- |
| 串流輸出 | 助手訊息和推理片段增量渲染，串流處理期間顯示耗時 |
| 推理展示 | 長推理可折疊預覽，減少螢幕占用 |
| 差異預覽 | 檔案覆蓋時自動生成 git diff 風格視圖，並顯示增刪行統計 |
| 會話列表 | 展示最近訊息摘要，支援按標題和訊息內容搜尋 |
| 版面穩定性 | 捲軸、終端寬度、CJK 字元寬度處理更可靠 |
| Shell 模式 | 提供取消按鈕、自訂圖示、範例 placeholder 和即時完成狀態 |

### 會話與上下文管理

| 能力 | 細節 |
| --- | --- |
| 會話復原 | 隱藏訊息、撤銷操作、待處理訊息檢查和錯誤復原邏輯更穩 |
| 中斷控制 | 記錄中斷次數和確認時間，父會話中斷會傳播到子任務 |
| 路徑相容 | Windows 全域會話路徑正規化，會話儲存使用相對路徑 |
| 手動壓縮 | 使用者可以主動觸發壓縮，壓縮選擇非同步處理並帶錯誤提示 |
| Git 上下文 | 自動注入目前分支、狀態、最近提交等資訊，可設定開關 |

### Token 與成本可見性

| 入口 | 使用方式 | 展示內容 |
| --- | --- | --- |
| TUI Context usage | 在會話中執行 `/context`，或從命令面板選擇 `Context usage` | 展示目前上下文視窗、模型、已用/可用 token、Prompt/Conversation/Window 分類網格 |
| Context usage footer | TUI 面板底部 | 有會話用量時顯示 `Input`、`Output`、`Reason`、`Cache W/R`、`Cost`；無累計用量時顯示 `Used`、`Free`、`Usable`、`Buffer` |
| 會話列表成本列 | `opencode session list --cost` 或 `opencode session list -c` | 在 session list 中追加 `Cost` 和 `Tokens` 欄，便於按會話快速定位成本熱點 |
| 單會話明細 | `opencode session info -s <Session_ID>` | 按 provider/model 展示 `Calls`、`Input`、`Cache Write`、`Cache Read`、`Output`、`Cost` |
| 全域統計 | `opencode stats --models` | 匯總總成本、日均成本、平均 token、工具使用和模型用量 |

內部統計會優先讀取 request usage 資料；較舊會話沒有 request usage 時，會回退到訊息 metadata。TUI 的 Context usage 還會估算 instruction、skills、tool definitions、附件、工具結果和 compaction summary 對上下文視窗的占用。

### 工具系統

| 工具 | 增強點 |
| --- | --- |
| Read | metadata、stub、預設讀取行數、位元組限制、裝置檔案保護 |
| Grep/Ripgrep | 最大檔案數和結果數限制，搜尋過寬時給出明確錯誤 |
| Shell | bash、PowerShell、cmd 分別使用 shell 感知提示詞 |
| Write | 覆蓋檔案時自動生成 diff，幫助使用者確認實際修改 |
| 權限 | 父代理權限會過濾傳遞給子任務，工具可用性檢查更嚴格 |

### Provider 與模型

| 能力 | 說明 |
| --- | --- |
| Provider 別名 | 同一底層 provider 可設定多個帳號或端點 |
| 客戶端版本覆蓋 | 適配自訂 provider、相容代理和特殊 API 端點 |
| ClaudeCode provider | 支援 API Key、Base URL 和動態鑑權模式 |
| Cloudflare AI Gateway | 路由修復，非 Anthropic 模型預設關閉 tool streaming |

### VS Code Notebook 整合

使用 Notebook 工具前，請先安裝 VS Code 擴充套件 [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge)。目前擴充套件版本保持 `1.15.5`，可繼續配合 SMARK CLI `1.15.6` 使用，不需要隨本次 CLI README 更新而升級。該擴充套件負責在 VS Code/Jupyter Notebook 與 OpenCode CLI 之間建立本地鑑權 bridge；未安裝或未連線時，CLI 無法可靠讀取、編輯或執行 notebook cell。

擴充套件啟動後會在 `127.0.0.1:<random port>` 開本地 bridge，並把帶 heartbeat 的 manifest 寫到 `~/.local/state/opencode/ide/<uuid>.json`。OpenCode 會按 workspace 與 notebook 路徑自動選擇匹配的 VS Code bridge；遠端 SSH、WSL 或容器場景下，CLI 需要執行在能存取該 bridge 的同一側環境。

| 工具 | 用途 |
| --- | --- |
| `vscode_notebook_summary` | 取得 notebook cell 的穩定 `#VSC-*` ID、顯示序號、類型、語言、執行狀態、輸出摘要、dirty 狀態和 runtime 資訊 |
| `vscode_notebook_source` | 以 1-based 全域虛擬行號分頁讀取 notebook 原始碼，返回內容預設限制在 16KB 內 |
| `vscode_notebook_edit` | 插入、修改、刪除 cell，支援 `oldCode/newCode` 精確字串替換，也支援 code/markdown 類型切換 |
| `vscode_notebook_run` | 透過 VS Code/Jupyter 執行單個 code cell 或穩定 ID 範圍，範圍執行遇到失敗或逾時會停止 |
| `vscode_notebook_output` | 讀取文字、圖片、HTML、JSON 等輸出；大輸出會寫入 `.opencode/cache/notebook-outputs/` 並返回 artifact 路徑 |
| `vscode_notebook_env` | 查看 kernel/runtime，觸發 kernel 選擇，重啟 kernel，或在使用者明確要求時儲存 notebook |

推薦流程：先用 `vscode_notebook_summary` 取得目前 cell ID，再用 `vscode_notebook_source` 讀取目標 cell，修改後用 `vscode_notebook_run` 驗證，最後用 `vscode_notebook_output` 查看結果。不要把顯示序號 `cN` 當成長期穩定引用；插入、刪除或類型切換後應使用工具返回的新 `#VSC-*` ID 或重新 summary。

### 跨平台支援

| 平台問題 | 處理方式 |
| --- | --- |
| Windows 編碼 | 自動偵測 UTF-8/UTF-16LE，修復管線亂碼 |
| PowerShell | CLIXML 解碼、stderr 正規化、UTF-8 輸出修復 |
| 路徑差異 | 大小寫、分隔符、全域會話路徑統一正規化 |
| 行結尾 | 套用 patch 時保留 CRLF/LF 原始風格 |
| WSL | 維護遷移與跨平台建置指南 |

---

## Agents

OpenCode 內建多種 primary agent，可用 `Tab` 快速切換。預設 agent 可透過 `default_agent` 設定覆蓋；子 agent 主要透過任務派發或 `@agent` 方式呼叫。

| Agent | 類型 | 權限模型 | 適合場景 |
| --- | --- | --- | --- |
| `build` | primary | 預設開發模式，按設定權限執行工具，允許問題確認和進入 plan | 實作功能、修復 bug、執行測試、端到端交付 |
| `interactive` | primary | 更保守的互動模式；`bash`、notebook 執行和 notebook 環境操作預設詢問 | 需要使用者確認關鍵命令、希望降低誤操作風險的開發任務 |
| `auto` | primary | 明確選擇才啟用；`bash`、`edit` 和 shell 外部目錄存取進入 auto permission review | 希望自動審查 shell/編輯風險，同時避免預設 build 行為被意外改變的場景 |
| `decide` | primary | 禁用工具，只基於有限近期上下文輸出一次性判斷 | 使用高效能模型做相對低成本的單次決策、方案取捨、下一步判斷 |
| `plan` | primary | 禁止編輯工具和 notebook 變更，允許寫入 plan 檔案並退出 plan | 程式碼分析、方案制定、風險梳理、執行前規劃 |
| `general` | subagent | 通用子代理，禁止 `todowrite`，其餘遵循合併後的權限設定 | 複雜搜尋、多步驟研究、可並行拆解的輔助任務 |
| `explore` | subagent | 只允許搜尋、讀取、列表、web 查詢等探索工具 | 快速定位檔案、符號、呼叫鏈、設定和文件 |
| `scout` | subagent，實驗性 | 面向外部文件和依賴原始碼，允許 managed repo cache 讀取 | 查詢第三方函式庫實作、clone 依賴原始碼、研究外部 API 行為 |

`title`、`summary`、`compaction` 是隱藏的系統 agent，用於標題生成、摘要和壓縮流程，不是日常手動切換對象。了解更多 [Agents](https://opencode.ai/docs/agents) 相關資訊。

---

## 文件

| 資源 | 連結 |
| --- | --- |
| 官方文件 | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| 貢獻指南 | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## 常見問題

### 這和 Claude Code 有什麼不同？

功能定位相近，但 OpenCode 的重點是開源、終端優先、provider 無關、client/server 架構和可擴充工具系統。SMARK 分支在此基礎上進一步強化 Windows/PowerShell、VSCode Notebook、Token 可見性、網路代理和安裝體驗。

### 這個分支適合誰？

如果你經常在終端機裡開發、需要可稽核的 Agent 行為、需要在 Windows/PowerShell 或 VSCode Notebook 場景中使用 AI coding agent，這個分支會比上游預設體驗更完整。

### 為什麼安裝腳本不預設使用 sudo？

使用者層級安裝更安全，也更容易管理。安裝腳本預設寫入使用者目錄，並拒絕隱式 sudo。只有你明確要安裝到 `/usr/local/bin` 這類系統目錄時，才需要 `sudo env ... --allow-sudo`，並建議同時使用 `--no-modify-path` 避免 root 修改使用者 profile。

### 如果系統裡已經有舊的 opencode，會怎樣？

安裝腳本只以目標安裝路徑為準。即使 `/usr/local/bin/opencode` 已有同版本，只要你指定 `OPENCODE_INSTALL_DIR="$HOME/.local/bin"`，腳本仍會安裝到 `~/.local/bin/opencode`，不會被 PATH 上的舊二進位檔攔截。

---

## 參與貢獻

提交 PR 前請閱讀 [貢獻指南](./CONTRIBUTING.md)。如果你在自己的專案名中使用 `opencode`，請在 README 中說明該專案並非 OpenCode 團隊官方專案，也不與 OpenCode 團隊存在關聯。

---

## 社群

**加入我們的社群** [飛書](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
