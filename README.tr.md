<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">Açık kaynaklı AI Coding Agent — SMARK geliştirilmiş dalı</p>
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

> **Bu dal hakkında**: Bu, OpenCode'un `dev-smark` geliştirilmiş dalıdır (geçerli sürüm `1.15.6`, CLI release tag `v1.15.6-smark`). Upstream `dev` temel alınmıştır ve TUI etkileşimi, oturum yönetimi, token istatistikleri, Windows/PowerShell uyumluluğu, VS Code Notebook entegrasyonu, ağ proxy desteği ve kurulum deneyimine odaklanır.

---

## Hızlı Kurulum

SMARK dalının releases sayfasındaki installer'ı kullanın. Varsayılan olarak en son release'i kurar ve kurulum dizinini mevcut shell profillerine yazar.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Kurulumdan sonra doğrulayın:

```bash
opencode --version
which opencode
```

Geçerli shell PATH'i yenilemediyse terminali yeniden açın veya kurulum günlüğünde gösterilen profili source edin.

### Kurulum Dizinini Belirtme

Kullanıcı düzeyi kurulumlar için `~/.local/bin` önerilir. Ortam değişkeni yalnızca `curl` için değil, installer'ı çalıştıran `bash` sürecine geçirilmelidir.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

Sorun gidermek için önce script'i indirin, sonra çalıştırın:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Bunu şu şekilde yazmayın:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Bu yalnızca `OPENCODE_INSTALL_DIR` değerini `curl` için geçirir; installer'ı gerçekten çalıştıran `bash` sürecine geçirmez.

### Sürüm Belirtme

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.6-smark
```

Tam biçim budur: `bash -s --`, `bash`'e installer'ı stdin'den okumasını ve `--version 1.15.6-smark` değerini installer argümanları olarak geçirmesini söyler. Sürüm `1.15.6-smark` veya release tag biçimi olan `v1.15.6-smark` olabilir.

### Installer Davranışı

| Senaryo | Davranış |
| --- | --- |
| Varsayılan kurulum dizini | `$OPENCODE_INSTALL_DIR`, sonra `$XDG_BIN_DIR`, sonra `$HOME/.opencode/bin` |
| Hedef yolda aynı sürüm zaten var | Yeniden kurar ve üzerine yazar; hasarlı veya bayat binary'leri yenilemek için kullanışlıdır |
| PATH içinde başka bir yerde aynı sürüm var | Yalnızca bildirim yazdırır; istenen dizine kurulumu engellemez |
| PATH yazma | Varsayılan olarak desteklenen mevcut tüm profilleri günceller ve yinelenen girdilerden kaçınır |
| sudo | Varsayılan olarak `sudo` başlatmayı reddeder; sistem kurulumları açıkça `--allow-sudo` geçmelidir |
| macOS quarantine | Kurulumdan sonra `com.apple.quarantine` niteliğini kaldırmayı dener |
| checksum | Release `checksums.txt` sağlıyorsa indirilen asset'leri doğrular |

### PATH Ve Shell Profilleri

Installer mevcut profilleri algılar ve günceller: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*` ve `~/.config/fish/config.fish`.

| İhtiyaç | Komut |
| --- | --- |
| PATH'i değiştirme | `bash /tmp/opencode-install --no-modify-path` |
| Yalnızca bir profile yaz | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Profili etkileşimli seç | `bash /tmp/opencode-install --interactive` |
| Sistem dizinine kur | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

`~/.local/bin/opencode` yolunun `/usr/local/bin/opencode` yolundan öncelikli olmasını istiyorsanız profilinizin PATH sırasının şöyle olduğundan emin olun:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Diğer Kurulum Yöntemleri

Bu yöntemler upstream paket yöneticisi ekosistemini kullanır. SMARK dalı derlemesine ihtiyacınız varsa yukarıdaki GitHub release installer'ı tercih edin.

| Platform | Komut | Notlar |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | `bun`, `pnpm` veya `yarn` da kullanabilirsiniz |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Upstream tap, genellikle hızlı güncellenir |
| macOS/Linux | `brew install opencode` | Resmi Homebrew formula, geriden gelebilir |
| Windows | `scoop install opencode` | Scoop paketi |
| Windows | `choco install opencode` | Chocolatey paketi |
| Arch Linux | `sudo pacman -S opencode` | Kararlı paket |
| Arch Linux | `paru -S opencode-bin` | En yeni AUR binary paketi |
| Herhangi bir sistem | `mise use -g opencode` | Araç sürümlerini mise ile yönetin |
| Nix | `nix run nixpkgs#opencode` | GitHub'dan geliştirme sürümünü de çalıştırabilir |

---

## Hızlı Başlangıç

```bash
cd <your-project>
opencode
```

Başladıktan sonra doğrudan bir görev tarif edin; örneğin "bu modül mimarisini açıkla", "bu hatayı düzelt" veya "bu özellik için test ekle". TUI içinde agent'lar arasında geçiş yapmak için `Tab` kullanın; dosya okumak/yazmak, komut çalıştırmak, diff incelemek ve oturumları yönetmek için yerleşik araçları kullanın.

| Eylem | Açıklama |
| --- | --- |
| `Tab` | Kullanılabilir agent'lar arasında geçiş yap |
| Oturum listesi | Geçmişi görüntüle, başlıkları ve mesaj içeriğini ara |
| Diff önizleme | Dosya yazmalarından önce ve sonra git diff tarzı değişiklikleri göster |
| Manuel sıkıştırma | Uzun oturumlarda token alanını boşaltmak için bağlamı proaktif olarak sıkıştır |
| Shell tool | İptal, çıktı sıkıştırma ve PowerShell çıktı normalleştirmesini destekler |

---

## Masaüstü Uygulaması

SMARK `dev-smark` dalı şu anda masaüstü uygulaması installer'ları değil, yalnızca CLI release'leri yayınlar. Masaüstü uygulaması (BETA) için doğruluk kaynağı olarak [opencode.ai/download](https://opencode.ai/download) ve upstream release notlarını kullanın; SMARK CLI release sayfasını masaüstü installer kaynağı olarak değerlendirmeyin.

---

## Temel Özellikler

Bu dal yalnızca bir özellik yığını değildir; yaygın geliştirme sorunlarını gözlemlenebilir, kurtarılabilir, platformlar arası iş akışlarına dönüştürür.

| Alan | Çözdüğü Sorun | Görecekleriniz |
| --- | --- | --- |
| TUI etkileşimi | Uzun çıktı, akan mesajlar, okunması zor diff'ler | Canlı render, daraltılabilir reasoning, diff önizleme, anlık durum güncellemeleri |
| Oturum yönetimi | Uzun oturumlar bağlamı kaybeder ve kurtarması maliyetlidir | Oturum arama, yol filtreleri, manuel sıkıştırma, kesinti kurtarma, Session Warping |
| Token istatistikleri | Bağlamı neyin tükettiğini bilmek zordur | Input/output token'ları, tool sonuçları, ekler, request overhead kırılımları |
| Tool sistemi | Dosya ve shell çıktısı bağlamı kirletebilir | Yapılandırılmış Read çıktısı, Shell çıktı sıkıştırması, Write otomatik diff |
| Provider | Çoklu hesap, endpoint ve model kurulumu karmaşıktır | Provider alias'ları, client version override, ClaudeCode provider |
| VSCode | Notebook senaryoları CLI agent'ları tarafından güvenilir işletilemez | Cell summary, read, edit, run, output read, kernel management |
| Windows | PowerShell, encoding, yollar ve CRLF hataya açıktır | CLIXML decoding, UTF-8 düzeltmeleri, path normalization, CRLF preservation |
| Network proxy | Provider, plugin ve fetch proxy mantığı dağınıktır | NetworkProxy, HTTP_PROXY, HTTPS_PROXY, NO_PROXY değerlerini tutarlı işler |
| Daemon | Çoklu instance, kilitler, health check'ler ve client'lar karmaşıktır | Server Lock, health checks, HttpApi, PTY WebSocket tickets |

### TUI Ve Etkileşim Deneyimi

| Yetenek | Ayrıntılar |
| --- | --- |
| Streaming output | Assistant messages ve reasoning chunk'ları artımlı render edilir; streaming sırasında geçen süre gösterilir |
| Reasoning display | Uzun reasoning ekran kullanımını azaltmak için daraltılabilir |
| Diff preview | Dosya üzerine yazmaları, eklenen/silinen satır sayılarıyla git diff tarzı görünümü otomatik üretir |
| Session list | Son mesaj özetlerini gösterir ve başlığa ve mesaj içeriğine göre aramayı destekler |
| Layout stability | Daha güvenilir scrollbar'lar, terminal width handling ve CJK karakter genişliği handling |
| Shell mode | İptal düğmesi, özel ikon, örnek placeholder ve canlı tamamlanma durumu sağlar |

### Oturum Ve Bağlam Yönetimi

| Yetenek | Ayrıntılar |
| --- | --- |
| Session recovery | Hidden messages, undo operations, pending-message checks ve error recovery daha sağlamdır |
| Interrupt control | Kesinti sayılarını ve onay zamanını kaydeder; parent session kesintileri subtask'lere yayılır |
| Path compatibility | Windows global session path'leri normalize edilir; session storage relative path'ler kullanır |
| Manual compaction | Kullanıcılar compaction tetikleyebilir; compaction selection asenkrondur ve hataları bildirir |
| Git context | Geçerli branch, status, recent commits ve ilgili verileri config switch ile otomatik enjekte eder |

### Token Ve Maliyet Görünürlüğü

| Giriş | Kullanım | Gösterim |
| --- | --- | --- |
| TUI Context usage | Bir oturumda `/context` çalıştırın veya command palette'ten `Context usage` seçin | Geçerli context window, model, kullanılan/kullanılabilir token'lar ve Prompt/Conversation/Window kategori grid'ini gösterir |
| Context usage footer | TUI panelinin altı | Session usage varsa `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`; cumulative usage yoksa `Used`, `Free`, `Usable`, `Buffer` gösterir |
| Session list cost column | `opencode session list --cost` veya `opencode session list -c` | Maliyet hotspot'larını hızlı bulmak için session list'e `Cost` ve `Tokens` sütunları ekler |
| Single-session details | `opencode session info -s <Session_ID>` | Provider/model bazında `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` gösterir |
| Global stats | `opencode stats --models` | Toplam maliyet, günlük ortalama maliyet, ortalama token, tool usage ve model usage özetler |

Dahili istatistikler request usage verisini tercih eder ve eski oturumlar için message metadata'ya geri düşer. TUI Context usage ayrıca instruction, skills, tool definitions, attachments, tool results ve compaction summary kullanımını context window içinde tahmin eder.

### Tool Sistemi

| Tool | Geliştirme |
| --- | --- |
| Read | Metadata, stub, default read line count, byte limits, device-file protection |
| Grep/Ripgrep | Aşırı geniş aramalar için açık hatalarla maximum files ve result counts sınırlar |
| Shell | bash, PowerShell ve cmd için ayrı ayrı shell-aware prompt'lar kullanır |
| Write | Dosyaların üzerine yazarken diff'i otomatik üretir, böylece kullanıcılar gerçek değişikliği onaylayabilir |
| Permission | Parent-agent permission'ları subtask'lere geçirilmeden önce filtrelenir; tool availability check'leri daha sıkıdır |

### Provider Ve Modeller

| Yetenek | Açıklama |
| --- | --- |
| Provider aliases | Aynı underlying provider için birden çok hesap veya endpoint yapılandırın |
| Client version override | Custom provider'lara, compatibility proxy'lere ve special API endpoint'lere uyum sağlar |
| ClaudeCode provider | API Key, Base URL ve dynamic authentication mode'larını destekler |
| Cloudflare AI Gateway | Routing fix'leri; Anthropic olmayan modeller için tool streaming varsayılan olarak kapalıdır |

### VS Code Notebook Entegrasyonu

Notebook tools kullanmadan önce VS Code extension [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge) kurun. Extension sürümü `1.15.5` olarak kalır ve SMARK CLI `1.15.6` ile çalışmaya devam edebilir; bu CLI README güncellemesi için yükseltme gerekmez. Extension, VS Code/Jupyter Notebook ile OpenCode CLI arasında yerel authenticated bridge oluşturur; kurulu veya bağlı değilse CLI notebook cell'lerini güvenilir şekilde okuyamaz, düzenleyemez veya çalıştıramaz.

Başladıktan sonra extension `127.0.0.1:<random port>` üzerinde yerel bridge açar ve heartbeat manifest'ini `~/.local/state/opencode/ide/<uuid>.json` yoluna yazar. OpenCode, workspace ve notebook path'e göre eşleşen VS Code bridge'i otomatik seçer. Remote SSH, WSL veya container kurulumlarında CLI, bridge'e erişebilen aynı tarafta çalışmalıdır.

| Tool | Amaç |
| --- | --- |
| `vscode_notebook_summary` | Notebook cell'leri için stable `#VSC-*` ID'leri, display index, type, language, execution state, output summary, dirty state ve runtime info alır |
| `vscode_notebook_source` | Notebook source'u 1-based global virtual line number'larla okur; dönen içerik varsayılan olarak 16KB ile sınırlıdır |
| `vscode_notebook_edit` | Cell insert, edit veya delete yapar; exact `oldCode/newCode` string replacement ve code/markdown type switching destekler |
| `vscode_notebook_run` | VS Code/Jupyter üzerinden tek code cell veya stable-ID range çalıştırır; range execution failure veya timeout durumunda durur |
| `vscode_notebook_output` | Text, image, HTML, JSON ve diğer output'ları okur; büyük output'lar `.opencode/cache/notebook-outputs/` altına yazılır ve artifact path olarak döner |
| `vscode_notebook_env` | Kernel/runtime incele, kernel selection tetikle, kernel restart et veya kullanıcı açıkça istediğinde notebook save et |

Önerilen akış: geçerli cell ID'yi almak için `vscode_notebook_summary`, hedef cell'i okumak için `vscode_notebook_source`, düzenleme sonrası doğrulamak için `vscode_notebook_run` ve sonuçları incelemek için `vscode_notebook_output` kullanın. Display index `cN` değerini uzun vadeli stabil referans saymayın; insert, delete veya type switch sonrası tool'un döndürdüğü yeni `#VSC-*` ID'yi kullanın veya summary'yi yeniden çalıştırın.

### Platformlar Arası Destek

| Platform Sorunu | İşleme |
| --- | --- |
| Windows encoding | UTF-8/UTF-16LE otomatik algılanır ve pipe mojibake onarılır |
| PowerShell | CLIXML decoding, stderr normalization, UTF-8 output repair |
| Path differences | Büyük/küçük harf, ayırıcılar ve global session path'leri normalize edilir |
| Line endings | Patch uygularken özgün CRLF/LF stili korunur |
| WSL | Migration ve cross-platform build guide'ları sürdürülür |

---

## Agents

OpenCode, `Tab` ile geçiş yapılabilen birden çok yerleşik primary agent içerir. Varsayılan agent `default_agent` ile override edilebilir; subagent'lar çoğunlukla task dispatch veya `@agent` ile çağrılır.

| Agent | Tür | Permission Model | En Uygun Kullanım |
| --- | --- | --- | --- |
| `build` | primary | Varsayılan geliştirme modu; araçları yapılandırılmış permission'lara göre çalıştırır, question confirmation ve plan'a girmeye izin verir | Özellik implementasyonu, bug düzeltme, test çalıştırma, uçtan uca teslim |
| `interactive` | primary | Daha korumacı interactive mode; `bash`, notebook execution ve notebook environment operations varsayılan olarak sorar | Önemli komutlar için confirmation gereken veya accidental operation riskini düşürmek isteyen görevler |
| `auto` | primary | Yalnızca açıkça seçildiğinde etkinleşir; `bash`, `edit` ve shell external directory access auto permission review'e girer | Varsayılan build behavior yanlışlıkla değişmeden shell/edit riskini otomatik review etmek |
| `decide` | primary | Tool'ları devre dışı bırakır ve sınırlı recent context'ten one-shot judgment üretir | High-performance model ile daha düşük maliyetli tek seferlik decision, tradeoff ve next-step choice'lar |
| `plan` | primary | Edit tools ve notebook changes'a izin vermez; plan file yazmaya ve plan'dan çıkmaya izin verir | Code analysis, planning, risk review, pre-execution design |
| `general` | subagent | General subagent; `todowrite` yasaktır, aksi halde merged permission config'i izler | Complex search, multi-step research, parallelizable support tasks |
| `explore` | subagent | Yalnızca search, read, list, web query ve benzeri exploration tools'a izin verir | File, symbol, call chain, config ve docs hızlı bulma |
| `scout` | subagent, experimental | External docs ve dependency source hedeflenir; managed repo cache read'lerine izin verir | Third-party library implementation inceleme, dependency source cloning, external API behavior araştırma |

`title`, `summary` ve `compaction`, title generation, summaries ve compaction flow'ları için hidden system agent'lardır; günlük manuel geçiş hedefleri değildir. Daha fazla bilgi için [Agents](https://opencode.ai/docs/agents) bölümüne bakın.

---

## Dokümantasyon

| Kaynak | Bağlantı |
| --- | --- |
| Resmi dokümanlar | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Katkı rehberi | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## SSS

### Bunun Claude Code'dan farkı nedir?

Yetenek hedefi benzerdir, ancak OpenCode açık kaynak, terminal-first kullanım, provider bağımsızlığı, client/server mimarisi ve extensible tool system üzerine odaklanır. SMARK dalı ayrıca Windows/PowerShell, VS Code Notebook, token visibility, network proxy support ve installation experience alanlarını güçlendirir.

### Bu dal kimler içindir?

Terminalde sık geliştirme yapıyorsanız, auditable agent behavior'a ihtiyacınız varsa veya AI coding agent'ları Windows/PowerShell ya da VS Code Notebook senaryolarında kullanıyorsanız bu dal upstream varsayılanlarına göre daha eksiksiz bir deneyim sağlar.

### Installer neden varsayılan olarak sudo kullanmaz?

Kullanıcı düzeyi kurulum daha güvenli ve yönetmesi daha kolaydır. Installer varsayılan olarak kullanıcı dizinine yazar ve implicit sudo'yu reddeder. `sudo env ... --allow-sudo` yalnızca `/usr/local/bin` gibi bir sistem dizinine açıkça kurulum yaparken kullanın; root'un kullanıcı profillerini değiştirmesini önlemek için `--no-modify-path` seçeneğini de değerlendirin.

### Sistemde eski bir opencode zaten varsa ne olur?

Installer yalnızca hedef kurulum yoluna güvenir. `/usr/local/bin/opencode` aynı sürüme sahip olsa bile `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` belirtmek yine `~/.local/bin/opencode` yoluna kurar ve PATH'teki eski binary tarafından engellenmez.

---

## Katkıda Bulunma

PR göndermeden önce [katkı rehberini](./CONTRIBUTING.md) okuyun. Kendi proje adınız `opencode` kullanıyorsa README dosyasında bunun resmi bir OpenCode team projesi olmadığını ve OpenCode team ile bağlantılı olmadığını belirtin.

---

## Topluluk

**Topluluğumuza katılın** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
