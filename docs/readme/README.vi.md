<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="../../packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="../../packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="../../packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">AI Coding Agent ma nguon mo - nhanh SMARK nang cao</p>
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

> **Ve nhanh nay**: Day la nhanh nang cao `dev-smark` cua OpenCode (phien ban hien tai `1.15.7`, CLI release tag `v1.15.7-smark`). Nhanh nay dua tren upstream `dev` va tap trung vao tuong tac TUI, quan ly phien, thong ke token, tuong thich Windows/PowerShell, tich hop VS Code Notebook, ho tro network proxy va trai nghiem cai dat.

---

## Cai Dat Nhanh

Su dung installer tu trang releases cua nhanh SMARK. Theo mac dinh, no cai dat release moi nhat va ghi thu muc cai dat vao cac shell profile hien co.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Xac minh sau khi cai dat:

```bash
opencode --version
which opencode
```

Neu shell hien tai chua lam moi PATH, hay mo lai terminal hoac source profile duoc hien thi trong install log.

### Chi Dinh Thu Muc Cai Dat

Khuyen nghi cai dat cap nguoi dung vao `~/.local/bin`. Bien moi truong phai duoc truyen cho tien trinh `bash` chay installer, khong chi truyen cho `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

De xu ly su co, hay tai script truoc roi chay no:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Khong viet theo cach nay:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Cach do chi truyen `OPENCODE_INSTALL_DIR` cho `curl`, khong truyen cho tien trinh `bash` that su chay installer.

### Chi Dinh Phien Ban

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

Day la dang day du: `bash -s --` bao `bash` doc installer tu stdin va truyen `--version 1.15.7-smark` lam doi so installer. Phien ban co the la `1.15.7-smark` hoac dang release tag `v1.15.7-smark`.

### Hanh Vi Installer

| Tinh huong | Hanh vi |
| --- | --- |
| Thu muc cai dat mac dinh | `$OPENCODE_INSTALL_DIR`, sau do `$XDG_BIN_DIR`, sau do `$HOME/.opencode/bin` |
| Cung phien ban da co o duong dan dich | Cai dat lai va ghi de, huu ich de lam moi binary bi hong hoac cu |
| Cung phien ban ton tai o noi khac trong PATH | Chi in thong bao; khong chan cai dat vao thu muc duoc yeu cau |
| Ghi PATH | Theo mac dinh cap nhat tat ca profile duoc ho tro dang ton tai va tranh muc trung lap |
| sudo | Mac dinh tu choi khoi dong bang `sudo`; cai dat he thong phai truyen ro `--allow-sudo` |
| macOS quarantine | Thu go thuoc tinh `com.apple.quarantine` sau khi cai dat |
| checksum | Xac minh tai san da tai khi release cung cap `checksums.txt` |

### PATH Va Shell Profiles

Installer phat hien va cap nhat cac profile hien co: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*`, va `~/.config/fish/config.fish`.

| Nhu cau | Lenh |
| --- | --- |
| Khong sua PATH | `bash /tmp/opencode-install --no-modify-path` |
| Chi ghi mot profile | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Chon profile tuong tac | `bash /tmp/opencode-install --interactive` |
| Cai dat vao thu muc he thong | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

Neu ban muon `~/.local/bin/opencode` uu tien hon `/usr/local/bin/opencode`, hay dam bao profile sap xep PATH nhu sau:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Cac Cach Cai Dat Khac

Cac cach nay dung he sinh thai package-manager upstream. Neu ban can ban build nhanh SMARK, hay uu tien GitHub release installer o tren.

| Nen tang | Lenh | Ghi chu |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | Ban cung co the dung `bun`, `pnpm`, hoac `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Upstream tap, thuong duoc cap nhat nhanh |
| macOS/Linux | `brew install opencode` | Formula Homebrew chinh thuc, co the cham hon |
| Windows | `scoop install opencode` | Goi Scoop |
| Windows | `choco install opencode` | Goi Chocolatey |
| Arch Linux | `sudo pacman -S opencode` | Goi on dinh |
| Arch Linux | `paru -S opencode-bin` | Goi binary AUR moi nhat |
| Bat ky he thong nao | `mise use -g opencode` | Quan ly phien ban cong cu bang mise |
| Nix | `nix run nixpkgs#opencode` | Cung co the chay phien ban phat trien tu GitHub |

---

## Bat Dau Nhanh

```bash
cd <your-project>
opencode
```

Sau khi khoi dong, mo ta truc tiep mot tac vu, chang han "giai thich kien truc module nay", "sua loi nay", hoac "them test cho tinh nang nay". Trong TUI, dung `Tab` de chuyen agent va dung cac cong cu tich hop de doc/ghi file, chay lenh, kiem tra diff va quan ly phien.

| Hanh dong | Mo ta |
| --- | --- |
| `Tab` | Chuyen giua cac agent kha dung |
| Session list | Xem lich su va tim kiem tieu de cung noi dung tin nhan |
| Diff preview | Hien thi thay doi kieu git diff truoc va sau khi ghi file |
| Manual compaction | Chu dong compact context trong cac phien dai de giai phong khong gian token |
| Shell tool | Ho tro huy, nen dau ra va chuan hoa dau ra PowerShell |

---

## Ung Dung Desktop

Nhanh SMARK `dev-smark` hien chi phat hanh CLI, khong phat hanh desktop app installers. Voi ung dung desktop (BETA), hay dung [opencode.ai/download](https://opencode.ai/download) va upstream release notes lam nguon thong tin chuan; khong coi trang SMARK CLI release la nguon desktop installer.

---

## Tinh Nang Cot Loi

Nhanh nay khong chi la mot tap hop tinh nang; no bien cac diem dau pho bien trong phat trien thanh nhung workflow co the quan sat, co the khoi phuc va hoat dong da nen tang.

| Khu vuc | Van de duoc giai quyet | Ban se thay gi |
| --- | --- | --- |
| TUI interaction | Dau ra dai, tin nhan streaming, diff kho doc | Render truc tiep, reasoning co the thu gon, diff preview, cap nhat trang thai tuc thi |
| Session management | Phien dai mat context va ton kem de khoi phuc | Tim kiem phien, bo loc duong dan, manual compaction, interrupt recovery, Session Warping |
| Token statistics | Kho biet thu gi tieu thu context | Token dau vao/dau ra, ket qua tool, attachments, phan tach request overhead |
| Tool system | Dau ra file va shell co the lam ban context | Dau ra Read co cau truc, nen dau ra Shell, Write tu dong diff |
| Provider | Cai dat nhieu tai khoan, endpoint va model rat phuc tap | Provider aliases, client version override, ClaudeCode provider |
| VSCode | Khong the thao tac cac kich ban Notebook mot cach tin cay bang CLI agents | Tong quan cell, doc, sua, chay, doc dau ra, quan ly kernel |
| Windows | PowerShell, encoding, duong dan va CRLF de gay loi | Giai ma CLIXML, sua UTF-8, chuan hoa duong dan, bao toan CRLF |
| Network proxy | Logic proxy cho provider, plugin va fetch bi phan tan | NetworkProxy xu ly HTTP_PROXY, HTTPS_PROXY, NO_PROXY nhat quan |
| Daemon | Nhieu instance, locks, health checks va clients phuc tap | Server Lock, health checks, HttpApi, PTY WebSocket tickets |

### TUI Va Trai Nghiem Tuong Tac

| Nang luc | Chi tiet |
| --- | --- |
| Streaming output | Tin nhan assistant va reasoning chunks render tang dan, kem thoi gian da troi qua khi streaming |
| Reasoning display | Reasoning dai co the thu gon de giam dien tich man hinh |
| Diff preview | Khi ghi de file, tu dong tao view kieu git diff voi so dong them/xoa |
| Session list | Hien thi tom tat tin nhan gan day va ho tro tim kiem theo tieu de cung noi dung tin nhan |
| Layout stability | Scrollbar, xu ly do rong terminal va xu ly do rong ky tu CJK dang tin cay hon |
| Shell mode | Cung cap nut huy, icon tuy chinh, placeholder vi du va trang thai hoan tat truc tiep |

### Quan Ly Phien Va Context

| Nang luc | Chi tiet |
| --- | --- |
| Session recovery | Tin nhan an, thao tac undo, kiem tra pending-message va khoi phuc loi manh me hon |
| Interrupt control | Ghi lai so lan interrupt va thoi diem xac nhan; interrupt cua phien cha lan truyen toi subtasks |
| Path compatibility | Duong dan phien global tren Windows duoc chuan hoa; session storage dung duong dan tuong doi |
| Manual compaction | Nguoi dung co the kich hoat compaction; lua chon compaction la bat dong bo va bao cao loi |
| Git context | Tu dong chen nhanh hien tai, trang thai, commit gan day va du lieu lien quan voi cong tac cau hinh |

### Kha Kien Token Va Chi Phi

| Muc | Cach dung | Hien thi |
| --- | --- | --- |
| TUI Context usage | Chay `/context` trong mot phien hoac chon `Context usage` tu command palette | Hien thi context window hien tai, model, token da dung/kha dung va luoi phan loai Prompt/Conversation/Window |
| Context usage footer | Cuoi bang TUI | Khi co session usage, hien `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`; khi khong co usage tich luy, hien `Used`, `Free`, `Usable`, `Buffer` |
| Cot chi phi danh sach phien | `opencode session list --cost` hoac `opencode session list -c` | Them cot `Cost` va `Tokens` vao session list de nhanh chong tim diem nong chi phi |
| Chi tiet mot phien | `opencode session info -s <Session_ID>` | Hien `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` theo provider/model |
| Thong ke toan cuc | `opencode stats --models` | Tong hop tong chi phi, chi phi trung binh ngay, token trung binh, muc dung tool va muc dung model |

Thong ke noi bo uu tien du lieu request usage va fallback ve message metadata cho phien cu. TUI Context usage cung uoc tinh muc dung instruction, skills, tool definitions, attachments, tool results va compaction summary trong context window.

### He Thong Tool

| Tool | Nang cap |
| --- | --- |
| Read | Metadata, stub, so dong doc mac dinh, gioi han byte, bao ve device-file |
| Grep/Ripgrep | Gioi han so file va so ket qua toi da, kem loi ro rang khi tim kiem qua rong |
| Shell | bash, PowerShell va cmd dung prompt rieng biet theo tung shell |
| Write | Tu dong tao diff khi ghi de file de nguoi dung co the xac nhan thay doi thuc te |
| Permission | Quyen cua parent-agent duoc loc truoc khi truyen cho subtasks; kiem tra tinh kha dung cua tool chat che hon |

### Provider Va Models

| Nang luc | Mo ta |
| --- | --- |
| Provider aliases | Cau hinh nhieu tai khoan hoac endpoint cho cung mot provider nen tang |
| Client version override | Thich ung custom providers, compatibility proxies va API endpoints dac biet |
| ClaudeCode provider | Ho tro API Key, Base URL va cac che do xac thuc dong |
| Cloudflare AI Gateway | Sua routing; tool streaming mac dinh bi tat cho cac model khong phai Anthropic |

### Tich Hop VS Code Notebook

Truoc khi dung Notebook tools, hay cai VS Code extension [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). Phien ban extension van la `1.15.5` va tiep tuc hoat dong voi SMARK CLI `1.15.7`; khong can nang cap cho ban cap nhat CLI README nay. Extension tao mot local authenticated bridge giua VS Code/Jupyter Notebook va OpenCode CLI; neu no chua duoc cai dat hoac ket noi, CLI khong the doc, sua hoac chay notebook cells mot cach tin cay.

Sau khi khoi dong, extension mo mot local bridge tai `127.0.0.1:<random port>` va ghi heartbeat manifest vao `~/.local/state/opencode/ide/<uuid>.json`. OpenCode tu dong chon VS Code bridge phu hop theo workspace va notebook path. Trong cac thiet lap remote SSH, WSL hoac container, CLI phai chay cung phia co the truy cap bridge.

| Tool | Muc dich |
| --- | --- |
| `vscode_notebook_summary` | Lay ID `#VSC-*` on dinh, display index, type, language, execution state, output summary, dirty state va runtime info cho notebook cells |
| `vscode_notebook_source` | Doc nguon notebook voi so dong ao toan cuc 1-based; noi dung tra ve mac dinh gioi han 16KB |
| `vscode_notebook_edit` | Chen, sua hoac xoa cells; ho tro thay the chuoi chinh xac `oldCode/newCode` va chuyen doi kieu code/markdown |
| `vscode_notebook_run` | Chay mot code cell hoac mot khoang stable-ID qua VS Code/Jupyter; chay khoang se dung khi loi hoac timeout |
| `vscode_notebook_output` | Doc text, image, HTML, JSON va cac dau ra khac; dau ra lon duoc ghi vao `.opencode/cache/notebook-outputs/` va tra ve duoi dang artifact paths |
| `vscode_notebook_env` | Kiem tra kernel/runtime, kich hoat kernel selection, restart kernel, hoac save notebook khi nguoi dung yeu cau ro rang |

Flow khuyen nghi: dung `vscode_notebook_summary` de lay cell ID hien tai, `vscode_notebook_source` de doc cell muc tieu, `vscode_notebook_run` de xac minh sau khi sua, va `vscode_notebook_output` de kiem tra ket qua. Khong coi display index `cN` la tham chieu on dinh dai han; sau khi chen, xoa hoac chuyen type, hay dung ID `#VSC-*` moi do tool tra ve hoac chay summary lai.

### Ho Tro Da Nen Tang

| Van de nen tang | Cach xu ly |
| --- | --- |
| Windows encoding | Tu dong phat hien UTF-8/UTF-16LE va sua mojibake cua pipe |
| PowerShell | Giai ma CLIXML, chuan hoa stderr, sua dau ra UTF-8 |
| Path differences | Chuan hoa casing, separators va duong dan phien global |
| Line endings | Bao toan kieu CRLF/LF goc khi apply patches |
| WSL | Duy tri huong dan migration va build da nen tang |

---

## Agents

OpenCode bao gom nhieu built-in primary agents co the chuyen bang `Tab`. Agent mac dinh co the duoc ghi de bang `default_agent`; subagents chu yeu duoc goi boi task dispatch hoac `@agent`.

| Agent | Type | Permission Model | Best For |
| --- | --- | --- | --- |
| `build` | primary | Che do phat trien mac dinh; chay tools theo quyen da cau hinh, cho phep xac nhan cau hoi va vao plan | Trien khai tinh nang, sua bug, chay tests, ban giao dau-cuoi |
| `interactive` | primary | Che do tuong tac than trong hon; `bash`, notebook execution va notebook environment operations mac dinh hoi | Tac vu can xac nhan cho lenh quan trong hoac giam rui ro thao tac ngoai y muon |
| `auto` | primary | Chi kich hoat khi duoc chon ro; `bash`, `edit` va shell external directory access vao auto permission review | Tu dong xem xet rui ro shell/edit ma khong vo tinh thay doi hanh vi build mac dinh |
| `decide` | primary | Tat tools va dua ra phan doan mot lan tu context gan day gioi han | Quyet dinh mot lan chi phi thap hon, can nhac tradeoff va chon buoc tiep theo bang model hieu nang cao |
| `plan` | primary | Khong cho phep edit tools va thay doi notebook; cho phep ghi plan files va thoat plan | Phan tich code, lap ke hoach, danh gia rui ro, thiet ke truoc khi thuc thi |
| `general` | subagent | Subagent tong quat; cam `todowrite`, ngoai ra theo merged permission config | Tim kiem phuc tap, nghien cuu nhieu buoc, tac vu ho tro co the song song hoa |
| `explore` | subagent | Chi cho phep search, read, list, web query va cac cong cu kham pha tuong tu | Nhanh chong dinh vi file, symbol, call chain, config va docs |
| `scout` | subagent, experimental | Huong toi external docs va dependency source; cho phep doc managed repo cache | Kiem tra implementation cua thu vien ben thu ba, clone dependency source, nghien cuu hanh vi external API |

`title`, `summary`, va `compaction` la hidden system agents cho title generation, summaries va compaction flows, khong phai muc tieu chuyen doi thu cong hang ngay. Tim hieu them ve [Agents](https://opencode.ai/docs/agents).

---

## Tai Lieu

| Tai nguyen | Lien ket |
| --- | --- |
| Tai lieu chinh thuc | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Huong dan dong gop | [CONTRIBUTING.md](../../CONTRIBUTING.md) |

---

## FAQ

### Khac gi so voi Claude Code?

Muc tieu nang luc tuong tu, nhung OpenCode tap trung vao ma nguon mo, cach dung terminal-first, doc lap provider, kien truc client/server va he thong tool co the mo rong. Nhanh SMARK tang cuong them Windows/PowerShell, VS Code Notebook, kha kien token, ho tro network proxy va trai nghiem cai dat.

### Nhanh nay danh cho ai?

Neu ban thuong phat trien trong terminal, can hanh vi agent co the audit, hoac dung AI coding agents trong cac kich ban Windows/PowerShell hay VS Code Notebook, nhanh nay cung cap trai nghiem hoan chinh hon mac dinh upstream.

### Vi sao installer khong dung sudo theo mac dinh?

Cai dat cap nguoi dung an toan hon va de quan ly hon. Installer mac dinh ghi vao thu muc nguoi dung va tu choi sudo ngam dinh. Chi dung `sudo env ... --allow-sudo` khi ban chu dong cai vao thu muc he thong nhu `/usr/local/bin`; cung nen can nhac `--no-modify-path` de tranh root sua user profiles.

### Neu opencode cu da ton tai tren he thong thi sao?

Installer chi tin vao duong dan cai dat dich. Ngay ca khi `/usr/local/bin/opencode` da co cung phien ban, viec chi dinh `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` van cai vao `~/.local/bin/opencode` va se khong bi chan boi binary cu trong PATH.

---

## Dong Gop

Doc [huong dan dong gop](../../CONTRIBUTING.md) truoc khi gui PR. Neu ten du an rieng cua ban dung `opencode`, hay neu trong README cua du an do rang no khong phai du an chinh thuc cua doi ngu OpenCode va khong lien ket voi doi ngu OpenCode.

---

## Cong Dong

**Tham gia cong dong cua chung toi** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
