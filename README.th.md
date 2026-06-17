<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">เอเจนต์ AI Coding แบบโอเพนซอร์ส — สาขาปรับปรุง SMARK</p>
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

> **เกี่ยวกับสาขานี้**: นี่คือสาขาปรับปรุง `dev-smark` ของ OpenCode (เวอร์ชันปัจจุบัน `1.15.7`, CLI release tag `v1.15.7-smark`) โดยอิงจาก upstream `dev` และมุ่งเน้นประสบการณ์ TUI, การจัดการเซสชัน, สถิติ token, ความเข้ากันได้กับ Windows/PowerShell, การผสานรวม VS Code Notebook, การรองรับ network proxy และประสบการณ์การติดตั้ง

---

## ติดตั้งอย่างรวดเร็ว

ใช้ตัวติดตั้งจากหน้า releases ของสาขา SMARK โดยค่าเริ่มต้นจะติดตั้ง release ล่าสุดและเขียนไดเรกทอรีติดตั้งลงใน shell profiles ที่มีอยู่

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

ตรวจสอบหลังติดตั้ง:

```bash
opencode --version
which opencode
```

ถ้า shell ปัจจุบันยังไม่ได้รีเฟรช PATH ให้เปิด terminal ใหม่ หรือ source profile ที่แสดงใน log การติดตั้ง

### ระบุไดเรกทอรีติดตั้ง

แนะนำให้ติดตั้งระดับผู้ใช้ไว้ที่ `~/.local/bin` ต้องส่ง environment variable ให้กับ process `bash` ที่รัน installer ไม่ใช่ส่งให้เฉพาะ `curl`

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

สำหรับการแก้ปัญหา ให้ดาวน์โหลดสคริปต์ก่อนแล้วจึงรัน:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

อย่าเขียนแบบนี้:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

เพราะจะส่ง `OPENCODE_INSTALL_DIR` ให้ `curl` เท่านั้น ไม่ได้ส่งให้ process `bash` ที่รัน installer จริง

### ระบุเวอร์ชัน

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

นี่คือรูปแบบเต็ม: `bash -s --` บอกให้ `bash` อ่าน installer จาก stdin และส่ง `--version 1.15.7-smark` เป็น installer arguments เวอร์ชันอาจเป็น `1.15.7-smark` หรือรูปแบบ release tag `v1.15.7-smark`

### พฤติกรรมของ Installer

| สถานการณ์ | พฤติกรรม |
| --- | --- |
| ไดเรกทอรีติดตั้งเริ่มต้น | `$OPENCODE_INSTALL_DIR`, จากนั้น `$XDG_BIN_DIR`, จากนั้น `$HOME/.opencode/bin` |
| มีเวอร์ชันเดียวกันอยู่แล้วที่ target path | ติดตั้งซ้ำและเขียนทับ เหมาะสำหรับรีเฟรช binary ที่เสียหายหรือล้าสมัย |
| มีเวอร์ชันเดียวกันอยู่ที่อื่นใน PATH | แสดง notice เท่านั้น ไม่บล็อกการติดตั้งไปยังไดเรกทอรีที่ร้องขอ |
| การเขียน PATH | โดยค่าเริ่มต้นจะอัปเดต supported profiles ที่มีอยู่ทั้งหมดและหลีกเลี่ยงรายการซ้ำ |
| sudo | ปฏิเสธการเริ่มด้วย `sudo` โดยค่าเริ่มต้น; การติดตั้งระดับระบบต้องส่ง `--allow-sudo` อย่างชัดเจน |
| macOS quarantine | พยายามลบ attribute `com.apple.quarantine` หลังติดตั้ง |
| checksum | ตรวจสอบ downloaded assets เมื่อ release มี `checksums.txt` |

### PATH และ Shell Profiles

Installer จะตรวจหาและอัปเดต profiles ที่มีอยู่: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*` และ `~/.config/fish/config.fish`

| ความต้องการ | คำสั่ง |
| --- | --- |
| ไม่แก้ไข PATH | `bash /tmp/opencode-install --no-modify-path` |
| เขียนเพียง profile เดียว | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| เลือก profile แบบโต้ตอบ | `bash /tmp/opencode-install --interactive` |
| ติดตั้งไปยังไดเรกทอรีระบบ | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

ถ้าคุณต้องการให้ `~/.local/bin/opencode` มีลำดับความสำคัญเหนือ `/usr/local/bin/opencode` ให้ตรวจว่า profile จัดลำดับ PATH แบบนี้:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### วิธีติดตั้งอื่น

วิธีเหล่านี้ใช้ ecosystem ของ package manager จาก upstream ถ้าคุณต้องการ build ของสาขา SMARK ให้ใช้ GitHub release installer ด้านบนเป็นหลัก

| แพลตฟอร์ม | คำสั่ง | หมายเหตุ |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | ใช้ `bun`, `pnpm` หรือ `yarn` ได้เช่นกัน |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Upstream tap มักอัปเดตเร็ว |
| macOS/Linux | `brew install opencode` | Official Homebrew formula อาจล่าช้า |
| Windows | `scoop install opencode` | Scoop package |
| Windows | `choco install opencode` | Chocolatey package |
| Arch Linux | `sudo pacman -S opencode` | Stable package |
| Arch Linux | `paru -S opencode-bin` | Latest AUR binary package |
| Any system | `mise use -g opencode` | จัดการเวอร์ชันเครื่องมือด้วย mise |
| Nix | `nix run nixpkgs#opencode` | สามารถรัน development version จาก GitHub ได้ด้วย |

---

## เริ่มต้นอย่างรวดเร็ว

```bash
cd <your-project>
opencode
```

หลังเริ่มต้น ให้บรรยายงานโดยตรง เช่น "explain this module architecture", "fix this error" หรือ "add tests for this feature" ใน TUI ใช้ `Tab` เพื่อสลับ agents และใช้ built-in tools เพื่ออ่าน/เขียนไฟล์ รันคำสั่ง ตรวจ diff และจัดการเซสชัน

| การกระทำ | คำอธิบาย |
| --- | --- |
| `Tab` | สลับระหว่าง agents ที่มีอยู่ |
| Session list | ดูประวัติและค้นหาชื่อเรื่องกับเนื้อหาข้อความ |
| Diff preview | แสดงการเปลี่ยนแปลงสไตล์ git diff ก่อนและหลังการเขียนไฟล์ |
| Manual compaction | บีบอัด context เชิงรุกในเซสชันยาวเพื่อคืนพื้นที่ token |
| Shell tool | รองรับการยกเลิก, output compression และ PowerShell output normalization |

---

## Desktop App

สาขา SMARK `dev-smark` ปัจจุบันเผยแพร่เฉพาะ CLI releases เท่านั้น ไม่เผยแพร่ desktop app installers สำหรับ desktop app (BETA) ให้ใช้ [opencode.ai/download](https://opencode.ai/download) และ upstream release notes เป็นแหล่งข้อมูลจริง อย่าถือว่าหน้า SMARK CLI release เป็นแหล่ง desktop installer

---

## ฟีเจอร์หลัก

สาขานี้ไม่ใช่แค่การรวมฟีเจอร์จำนวนมาก แต่เปลี่ยน pain points ที่พบบ่อยในการพัฒนาให้เป็น workflows ที่สังเกตได้ กู้คืนได้ และทำงานข้ามแพลตฟอร์มได้

| ด้าน | ปัญหาที่แก้ | สิ่งที่คุณจะเห็น |
| --- | --- | --- |
| TUI interaction | output ยาว, streaming messages, diff อ่านยาก | การ render สด, reasoning ที่พับได้, diff preview, status updates ทันที |
| Session management | เซสชันยาวสูญเสีย context และกู้คืน costly | Session search, path filters, manual compaction, interrupt recovery, Session Warping |
| Token statistics | ยากที่จะรู้ว่าอะไรใช้ context | input/output tokens, tool results, attachments, request overhead breakdowns |
| Tool system | output ของ file และ shell อาจทำให้ context ปนเปื้อน | Structured Read output, Shell output compression, Write auto diff |
| Provider | การตั้งค่า multi-account, endpoint และ model ซับซ้อน | Provider aliases, client version override, ClaudeCode provider |
| VSCode | Notebook scenarios ไม่สามารถถูกจัดการโดย CLI agents ได้อย่างน่าเชื่อถือ | Cell summary, read, edit, run, output read, kernel management |
| Windows | PowerShell, encoding, paths และ CRLF เกิดข้อผิดพลาดง่าย | CLIXML decoding, UTF-8 fixes, path normalization, CRLF preservation |
| Network proxy | provider, plugin และ fetch proxy logic กระจัดกระจาย | NetworkProxy จัดการ HTTP_PROXY, HTTPS_PROXY, NO_PROXY อย่างสม่ำเสมอ |
| Daemon | multi-instance, locks, health checks และ clients ซับซ้อน | Server Lock, health checks, HttpApi, PTY WebSocket tickets |

### TUI และประสบการณ์การโต้ตอบ

| ความสามารถ | รายละเอียด |
| --- | --- |
| Streaming output | Assistant messages และ reasoning chunks render แบบ incremental พร้อมแสดงเวลาที่ใช้ขณะ streaming |
| Reasoning display | reasoning ยาวสามารถพับเก็บเพื่อลดการใช้พื้นที่หน้าจอ |
| Diff preview | การเขียนทับไฟล์จะสร้างมุมมองสไตล์ git diff โดยอัตโนมัติ พร้อมจำนวนบรรทัดที่เพิ่ม/ลบ |
| Session list | แสดงสรุปข้อความล่าสุดและรองรับการค้นหาตามชื่อเรื่องกับเนื้อหาข้อความ |
| Layout stability | scrollbars, terminal width handling และ CJK character width handling น่าเชื่อถือขึ้น |
| Shell mode | มี cancel button, custom icon, example placeholder และ live completion status |

### การจัดการเซสชันและ Context

| ความสามารถ | รายละเอียด |
| --- | --- |
| Session recovery | hidden messages, undo operations, pending-message checks และ error recovery แข็งแรงขึ้น |
| Interrupt control | บันทึก interrupt counts และ confirmation time; parent session interrupts ส่งต่อไปยัง subtasks |
| Path compatibility | Windows global session paths ถูก normalize; session storage ใช้ relative paths |
| Manual compaction | ผู้ใช้สามารถ trigger compaction; compaction selection เป็น asynchronous และรายงาน errors |
| Git context | inject current branch, status, recent commits และข้อมูลที่เกี่ยวข้องโดยอัตโนมัติพร้อม config switch |

### การมองเห็น Token และ Cost

| รายการ | วิธีใช้ | การแสดงผล |
| --- | --- | --- |
| TUI Context usage | รัน `/context` ในเซสชัน หรือเลือก `Context usage` จาก command palette | แสดง current context window, model, used/available tokens และ Prompt/Conversation/Window category grid |
| Context usage footer | ด้านล่างของ TUI panel | เมื่อมี session usage จะแสดง `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`; เมื่อไม่มี cumulative usage จะแสดง `Used`, `Free`, `Usable`, `Buffer` |
| Session list cost column | `opencode session list --cost` หรือ `opencode session list -c` | เพิ่มคอลัมน์ `Cost` และ `Tokens` ใน session list เพื่อหา cost hotspots ได้เร็ว |
| Single-session details | `opencode session info -s <Session_ID>` | แสดง `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` ตาม provider/model |
| Global stats | `opencode stats --models` | สรุป total cost, daily average cost, average tokens, tool usage และ model usage |

Internal stats จะเลือกใช้ request usage data ก่อน และ fallback ไปยัง message metadata สำหรับเซสชันเก่า TUI Context usage ยังประเมิน usage ของ instruction, skills, tool definitions, attachments, tool results และ compaction summary ใน context window ด้วย

### Tool System

| Tool | Enhancement |
| --- | --- |
| Read | Metadata, stub, default read line count, byte limits, device-file protection |
| Grep/Ripgrep | จำกัด maximum files และ result counts พร้อม errors ชัดเจนเมื่อค้นหากว้างเกินไป |
| Shell | bash, PowerShell และ cmd ใช้ shell-aware prompts แยกกัน |
| Write | สร้าง diff โดยอัตโนมัติเมื่อเขียนทับไฟล์ เพื่อให้ผู้ใช้ยืนยันการเปลี่ยนแปลงจริง |
| Permission | parent-agent permissions ถูกกรองก่อนส่งต่อให้ subtasks; tool availability checks เข้มงวดขึ้น |

### Provider และ Models

| ความสามารถ | คำอธิบาย |
| --- | --- |
| Provider aliases | กำหนดหลาย accounts หรือ endpoints สำหรับ underlying provider เดียวกัน |
| Client version override | ปรับให้เข้ากับ custom providers, compatibility proxies และ special API endpoints |
| ClaudeCode provider | รองรับ API Key, Base URL และ dynamic authentication modes |
| Cloudflare AI Gateway | routing fixes; tool streaming ถูกปิดโดย default สำหรับ non-Anthropic models |

### การผสานรวม VS Code Notebook

ก่อนใช้ Notebook tools ให้ติดตั้ง VS Code extension [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge) เวอร์ชัน extension ยังคงเป็น `1.15.5` และยังทำงานต่อกับ SMARK CLI `1.15.7` ได้ ไม่จำเป็นต้องอัปเกรดสำหรับการอัปเดต CLI README นี้ extension สร้าง local authenticated bridge ระหว่าง VS Code/Jupyter Notebook และ OpenCode CLI; หากไม่ได้ติดตั้งหรือเชื่อมต่อ CLI จะไม่สามารถอ่าน แก้ไข หรือรัน notebook cells ได้อย่างน่าเชื่อถือ

หลังเริ่มต้น extension จะเปิด local bridge บน `127.0.0.1:<random port>` และเขียน heartbeat manifest ไปที่ `~/.local/state/opencode/ide/<uuid>.json` OpenCode จะเลือก VS Code bridge ที่ตรงกันโดยอัตโนมัติตาม workspace และ notebook path ใน remote SSH, WSL หรือ container setups CLI ต้องรันอยู่ฝั่งเดียวกับที่เข้าถึง bridge ได้

| Tool | Purpose |
| --- | --- |
| `vscode_notebook_summary` | รับ stable `#VSC-*` IDs, display index, type, language, execution state, output summary, dirty state และ runtime info สำหรับ notebook cells |
| `vscode_notebook_source` | อ่าน notebook source ด้วย 1-based global virtual line numbers; เนื้อหาที่คืนมาถูกจำกัดที่ 16KB โดย default |
| `vscode_notebook_edit` | insert, edit หรือ delete cells; รองรับ exact `oldCode/newCode` string replacement และ code/markdown type switching |
| `vscode_notebook_run` | รัน code cell หนึ่ง cell หรือ stable-ID range ผ่าน VS Code/Jupyter; range execution หยุดเมื่อ failure หรือ timeout |
| `vscode_notebook_output` | อ่าน text, image, HTML, JSON และ outputs อื่น; outputs ขนาดใหญ่ถูกเขียนไปที่ `.opencode/cache/notebook-outputs/` และคืนเป็น artifact paths |
| `vscode_notebook_env` | inspect kernel/runtime, trigger kernel selection, restart kernel หรือ save notebook เมื่อผู้ใช้ร้องขออย่างชัดเจน |

Recommended flow: ใช้ `vscode_notebook_summary` เพื่อรับ current cell ID, `vscode_notebook_source` เพื่ออ่าน target cell, `vscode_notebook_run` เพื่อ validate หลังแก้ไข และ `vscode_notebook_output` เพื่อตรวจผลลัพธ์ อย่าถือว่า display index `cN` เป็น stable long-term reference; หลัง inserts, deletes หรือ type switches ให้ใช้ `#VSC-*` ID ใหม่ที่ tool คืนมา หรือรัน summary อีกครั้ง

### การรองรับข้ามแพลตฟอร์ม

| Platform Issue | Handling |
| --- | --- |
| Windows encoding | Auto-detect UTF-8/UTF-16LE และซ่อม pipe mojibake |
| PowerShell | CLIXML decoding, stderr normalization, UTF-8 output repair |
| Path differences | Normalize casing, separators และ global session paths |
| Line endings | Preserve original CRLF/LF style เมื่อ applying patches |
| WSL | Maintain migration และ cross-platform build guides |

---

## Agents

OpenCode มี built-in primary agents หลายตัวที่สลับได้ด้วย `Tab` default agent สามารถ override ได้ด้วย `default_agent`; subagents ส่วนใหญ่ถูกเรียกผ่าน task dispatch หรือ `@agent`

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

`title`, `summary` และ `compaction` เป็น hidden system agents สำหรับ title generation, summaries และ compaction flows ไม่ใช่เป้าหมายการสลับด้วยตนเองในชีวิตประจำวัน เรียนรู้เพิ่มเติมเกี่ยวกับ [Agents](https://opencode.ai/docs/agents)

---

## เอกสาร

| Resource | Link |
| --- | --- |
| Official docs | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Contributing guide | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## FAQ

### แตกต่างจาก Claude Code อย่างไร?

เป้าหมายด้านความสามารถคล้ายกัน แต่ OpenCode เน้น open source, การใช้งานแบบ terminal-first, provider independence, client/server architecture และ extensible tool system สาขา SMARK ยังเสริม Windows/PowerShell, VS Code Notebook, token visibility, network proxy support และ installation experience ให้แข็งแรงขึ้น

### สาขานี้เหมาะกับใคร?

ถ้าคุณพัฒนาใน terminal บ่อย ต้องการพฤติกรรม agent ที่ตรวจสอบได้ หรือใช้ AI coding agents ในสถานการณ์ Windows/PowerShell หรือ VS Code Notebook สาขานี้ให้ประสบการณ์ครบถ้วนกว่า upstream defaults

### ทำไม installer ไม่ใช้ sudo โดย default?

การติดตั้งระดับผู้ใช้ปลอดภัยกว่าและจัดการง่ายกว่า Installer เขียนไปยัง user directory โดย default และปฏิเสธ implicit sudo ใช้ `sudo env ... --allow-sudo` เฉพาะเมื่อคุณติดตั้งไปยัง system directory เช่น `/usr/local/bin` อย่างชัดเจน และควรพิจารณา `--no-modify-path` เพื่อหลีกเลี่ยงไม่ให้ root แก้ไข user profiles

### ถ้ามี opencode เก่าอยู่ในระบบแล้วต้องทำอย่างไร?

Installer เชื่อถือเฉพาะ target install path เท่านั้น แม้ว่า `/usr/local/bin/opencode` จะมีเวอร์ชันเดียวกันอยู่แล้ว การระบุ `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` ก็ยังติดตั้งไปที่ `~/.local/bin/opencode` และจะไม่ถูกบล็อกโดย binary เก่าใน PATH

---

## การมีส่วนร่วม

อ่าน [contributing guide](./CONTRIBUTING.md) ก่อนส่ง PR หากชื่อโปรเจกต์ของคุณใช้ `opencode` ให้ระบุใน README ว่าไม่ใช่โปรเจกต์อย่างเป็นทางการของทีม OpenCode และไม่มีความเกี่ยวข้องกับทีม OpenCode

---

## ชุมชน

**เข้าร่วมชุมชนของเรา** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
