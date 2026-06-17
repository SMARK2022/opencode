<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">Open source AI Coding Agent — SMARK poboljšana grana</p>
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

> **O ovoj grani**: Ovo je OpenCode `dev-smark` poboljšana grana (trenutna verzija `1.15.7`, CLI release tag `v1.15.7-smark`). Zasnovana je na upstream `dev` grani i fokusira se na TUI interakciju, upravljanje sesijama, statistiku tokena, Windows/PowerShell kompatibilnost, VS Code Notebook integraciju, podršku za mrežni proxy i iskustvo instalacije.

---

## Brza Instalacija

Koristite installer sa stranice izdanja SMARK grane. Podrazumijevano instalira najnovije izdanje i upisuje instalacijski direktorij u postojeće shell profile.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Provjerite nakon instalacije:

```bash
opencode --version
which opencode
```

Ako trenutni shell nije osvježio PATH, ponovo otvorite terminal ili source-ajte profile prikazan u instalacijskom logu.

### Navedite Instalacijski Direktorij

Korisničke instalacije se preporučuju u `~/.local/bin`. Varijabla okruženja mora se proslijediti `bash` procesu koji pokreće installer, ne samo komandi `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

Za otklanjanje problema, prvo preuzmite skriptu pa je zatim pokrenite:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Nemojte pisati ovako:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

To prosljeđuje `OPENCODE_INSTALL_DIR` samo komandi `curl`, ne `bash` procesu koji stvarno pokreće installer.

### Navedite Verziju

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

Ovo je potpuni oblik: `bash -s --` kaže komandi `bash` da čita installer iz stdin i proslijedi `--version 1.15.7-smark` kao argumente installera. Verzija može biti `1.15.7-smark` ili oblik release taga `v1.15.7-smark`.

### Ponašanje Installera

| Scenarij | Ponašanje |
| --- | --- |
| Podrazumijevani instalacijski direktorij | `$OPENCODE_INSTALL_DIR`, zatim `$XDG_BIN_DIR`, zatim `$HOME/.opencode/bin` |
| Ista verzija već postoji na ciljnoj putanji | Ponovo instalira i prepisuje, korisno za osvježavanje oštećenih ili zastarjelih binarnih datoteka |
| Ista verzija drugdje u PATH | Ispiše samo obavijest; ne blokira instalaciju u traženi direktorij |
| PATH upisivanje | Podrazumijevano ažurira sve postojeće podržane profile i izbjegava duple unose |
| sudo | Podrazumijevano odbija pokretanje sa `sudo`; sistemske instalacije moraju eksplicitno proslijediti `--allow-sudo` |
| macOS quarantine | Pokušava ukloniti atribut `com.apple.quarantine` nakon instalacije |
| checksum | Provjerava preuzete assete kada izdanje pruža `checksums.txt` |

### PATH I Shell Profili

Installer otkriva i ažurira postojeće profile: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*` i `~/.config/fish/config.fish`.

| Potreba | Komanda |
| --- | --- |
| Ne mijenjaj PATH | `bash /tmp/opencode-install --no-modify-path` |
| Upiši samo jedan profile | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Interaktivno izaberi profile | `bash /tmp/opencode-install --interactive` |
| Instaliraj u sistemski direktorij | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

Ako želite da `~/.local/bin/opencode` ima prioritet nad `/usr/local/bin/opencode`, provjerite da vaš profile uređuje PATH ovako:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Drugi Načini Instalacije

Ove metode koriste upstream ekosistem package managera. Ako trebate build SMARK grane, preferirajte GitHub release installer iznad.

| Platforma | Komanda | Napomene |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | Možete koristiti i `bun`, `pnpm` ili `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Upstream tap, obično se brzo ažurira |
| macOS/Linux | `brew install opencode` | Zvanična Homebrew formula, može kasniti |
| Windows | `scoop install opencode` | Scoop paket |
| Windows | `choco install opencode` | Chocolatey paket |
| Arch Linux | `sudo pacman -S opencode` | Stabilni paket |
| Arch Linux | `paru -S opencode-bin` | Najnoviji AUR binarni paket |
| Bilo koji sistem | `mise use -g opencode` | Upravljajte verzijama alata pomoću mise |
| Nix | `nix run nixpkgs#opencode` | Može pokrenuti i development verziju sa GitHub-a |

---

## Brzi Početak

```bash
cd <your-project>
opencode
```

Nakon pokretanja, direktno opišite zadatak, kao što je "explain this module architecture", "fix this error" ili "add tests for this feature". U TUI-ju koristite `Tab` za prebacivanje agenata i ugrađene alate za čitanje/pisanje datoteka, pokretanje komandi, pregled diffova i upravljanje sesijama.

| Radnja | Opis |
| --- | --- |
| `Tab` | Prebacivanje između dostupnih agenata |
| Lista sesija | Pregled historije i pretraga naslova i sadržaja poruka |
| Diff pregled | Prikaz git diff stila izmjena prije i poslije pisanja datoteka |
| Ručna kompakcija | Proaktivno kompakcira kontekst u dugim sesijama radi oslobađanja prostora za tokene |
| Shell tool | Podržava otkazivanje, kompresiju izlaza i normalizaciju PowerShell izlaza |

---

## Desktop Aplikacija

SMARK `dev-smark` grana trenutno objavljuje samo CLI izdanja, ne installere za desktop aplikaciju. Za desktop aplikaciju (BETA) koristite [opencode.ai/download](https://opencode.ai/download) i upstream napomene o izdanju kao izvor istine; ne tretirajte SMARK CLI release stranicu kao izvor desktop installera.

---

## Ključne Funkcije

Ova grana nije samo skup funkcija; ona pretvara česte razvojne probleme u vidljive, oporavljive, cross-platform tokove rada.

| Područje | Riješen Problem | Šta Ćete Vidjeti |
| --- | --- | --- |
| TUI interakcija | Dugačak izlaz, streaming poruke, teško čitljivi diffovi | Renderiranje uživo, sklopivo reasoning, diff pregled, trenutna ažuriranja statusa |
| Upravljanje sesijama | Duge sesije gube kontekst i skupe su za oporavak | Pretraga sesija, filteri putanja, ručna kompakcija, oporavak od prekida, Session Warping |
| Statistika tokena | Teško je znati šta troši kontekst | Input/output tokeni, rezultati alata, prilozi, razrada request overheada |
| Sistem alata | Izlaz datoteka i shell-a može zagaditi kontekst | Strukturirani Read izlaz, Shell kompresija izlaza, Write automatski diff |
| Provider | Podešavanje više računa, endpointa i modela je složeno | Provider aliasi, override verzije klijenta, ClaudeCode provider |
| VSCode | Notebook scenarijima CLI agenti ne mogu pouzdano upravljati | Sažetak ćelija, čitanje, uređivanje, pokretanje, čitanje izlaza, upravljanje kernelom |
| Windows | PowerShell, kodiranje, putanje i CRLF su skloni greškama | CLIXML dekodiranje, UTF-8 popravci, normalizacija putanja, očuvanje CRLF |
| Network proxy | Provider, plugin i fetch proxy logika je raspršena | NetworkProxy dosljedno obrađuje HTTP_PROXY, HTTPS_PROXY, NO_PROXY |
| Daemon | Više instanci, lockovi, health checkovi i klijenti su složeni | Server Lock, health checkovi, HttpApi, PTY WebSocket ticketi |

### TUI I Iskustvo Interakcije

| Sposobnost | Detalji |
| --- | --- |
| Streaming izlaz | Poruke asistenta i reasoning segmenti renderiraju se inkrementalno, uz prikaz proteklog vremena tokom streaminga |
| Reasoning prikaz | Dugo reasoning se može sklopiti radi manje zauzetosti ekrana |
| Diff pregled | Prepisivanje datoteka automatski generira prikaz u git diff stilu sa brojem dodanih/obrisanih linija |
| Lista sesija | Prikazuje sažetke nedavnih poruka i podržava pretragu po naslovu i sadržaju poruka |
| Stabilnost layouta | Pouzdanije rukovanje scrollbarovima, širinom terminala i širinom CJK znakova |
| Shell mode | Pruža dugme za otkazivanje, prilagođenu ikonu, primjer placeholdera i status završetka uživo |

### Upravljanje Sesijom I Kontekstom

| Sposobnost | Detalji |
| --- | --- |
| Oporavak sesije | Skrivene poruke, undo operacije, provjere poruka na čekanju i oporavak od grešaka su robusniji |
| Kontrola prekida | Bilježi broj prekida i vrijeme potvrde; prekidi roditeljske sesije propagiraju se na podzadatke |
| Kompatibilnost putanja | Windows globalne putanje sesija se normaliziraju; pohrana sesija koristi relativne putanje |
| Ručna kompakcija | Korisnici mogu pokrenuti kompakciju; izbor kompakcije je asinhron i prijavljuje greške |
| Git kontekst | Automatski ubacuje trenutnu granu, status, nedavne commitove i povezane podatke pomoću config switcha |

### Vidljivost Tokena I Troškova

| Unos | Upotreba | Prikaz |
| --- | --- | --- |
| TUI Context usage | Pokrenite `/context` u sesiji ili izaberite `Context usage` iz command palette | Prikazuje trenutni context window, model, iskorištene/dostupne tokene i Prompt/Conversation/Window kategorijsku mrežu |
| Context usage footer | Dno TUI panela | Sa upotrebom sesije prikazuje `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`; bez kumulativne upotrebe prikazuje `Used`, `Free`, `Usable`, `Buffer` |
| Cost kolona liste sesija | `opencode session list --cost` ili `opencode session list -c` | Dodaje `Cost` i `Tokens` kolone u listu sesija za brzo pronalaženje troškovnih žarišta |
| Detalji jedne sesije | `opencode session info -s <Session_ID>` | Prikazuje `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` po provider/model |
| Globalna statistika | `opencode stats --models` | Sažima ukupni trošak, dnevni prosječni trošak, prosječne tokene, upotrebu alata i upotrebu modela |

Interna statistika preferira request usage podatke i vraća se na metapodatke poruka za starije sesije. TUI Context usage također procjenjuje zauzeće instruction, skills, tool definitions, priloga, rezultata alata i compaction summary u context windowu.

### Sistem Alata

| Alat | Poboljšanje |
| --- | --- |
| Read | Metapodaci, stub, podrazumijevani broj linija čitanja, byte ograničenja, zaštita device-file |
| Grep/Ripgrep | Ograničava maksimalni broj datoteka i rezultata, uz jasne greške za preširoke pretrage |
| Shell | bash, PowerShell i cmd odvojeno koriste shell-aware promptove |
| Write | Automatski generira diff pri prepisivanju datoteka kako bi korisnici mogli potvrditi stvarnu izmjenu |
| Permission | Dozvole roditeljskog agenta filtriraju se prije prosljeđivanja podzadacima; provjere dostupnosti alata su strožije |

### Provider I Modeli

| Sposobnost | Opis |
| --- | --- |
| Provider aliasi | Konfigurirajte više računa ili endpointa za isti osnovni provider |
| Override verzije klijenta | Prilagodite custom providere, kompatibilne proxyje i posebne API endpointe |
| ClaudeCode provider | Podržava API Key, Base URL i dinamičke authentication modove |
| Cloudflare AI Gateway | Popravci routinga; tool streaming je podrazumijevano isključen za non-Anthropic modele |

### VS Code Notebook Integracija

Prije korištenja Notebook alata instalirajte VS Code ekstenziju [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). Verzija ekstenzije ostaje `1.15.5` i može nastaviti raditi sa SMARK CLI `1.15.7`; ne mora se nadograditi za ovo ažuriranje CLI README-a. Ekstenzija kreira lokalni autentificirani bridge između VS Code/Jupyter Notebook i OpenCode CLI-ja; bez nje instalirane ili povezane, CLI ne može pouzdano čitati, uređivati ili pokretati notebook ćelije.

Nakon pokretanja, ekstenzija otvara lokalni bridge na `127.0.0.1:<random port>` i upisuje heartbeat manifest u `~/.local/state/opencode/ide/<uuid>.json`. OpenCode automatski bira odgovarajući VS Code bridge prema workspaceu i notebook putanji. U remote SSH, WSL ili container postavkama, CLI mora raditi na istoj strani koja može pristupiti bridgeu.

| Tool | Purpose |
| --- | --- |
| `vscode_notebook_summary` | Dobija stabilne `#VSC-*` ID-jeve, display index, type, language, execution state, output summary, dirty state i runtime info za notebook ćelije |
| `vscode_notebook_source` | Čita notebook source sa 1-based globalnim virtualnim brojevima linija; vraćeni sadržaj je podrazumijevano ograničen na 16KB |
| `vscode_notebook_edit` | Umeće, uređuje ili briše ćelije; podržava tačnu `oldCode/newCode` zamjenu stringa i code/markdown promjenu tipa |
| `vscode_notebook_run` | Pokreće jednu code ćeliju ili stable-ID raspon kroz VS Code/Jupyter; izvršavanje raspona staje pri grešci ili timeoutu |
| `vscode_notebook_output` | Čita tekst, slike, HTML, JSON i druge izlaze; veliki izlazi se zapisuju u `.opencode/cache/notebook-outputs/` i vraćaju kao artifact putanje |
| `vscode_notebook_env` | Provjerava kernel/runtime, pokreće izbor kernela, restartuje kernel ili sprema notebook kada korisnik to eksplicitno zatraži |

Preporučeni tok: koristite `vscode_notebook_summary` da dobijete trenutni ID ćelije, `vscode_notebook_source` da pročitate ciljnu ćeliju, `vscode_notebook_run` za validaciju nakon uređivanja i `vscode_notebook_output` za pregled rezultata. Ne tretirajte display index `cN` kao stabilnu dugoročnu referencu; nakon umetanja, brisanja ili promjene tipa koristite novi `#VSC-*` ID koji alat vrati ili ponovo pokrenite summary.

### Cross-Platform Podrška

| Platform Issue | Handling |
| --- | --- |
| Windows encoding | Automatski detektuje UTF-8/UTF-16LE i popravlja pipe mojibake |
| PowerShell | CLIXML dekodiranje, stderr normalizacija, popravak UTF-8 izlaza |
| Path differences | Normalizira velika/mala slova, separatore i globalne putanje sesija |
| Line endings | Čuva originalni CRLF/LF stil pri primjeni patcheva |
| WSL | Održava migracijske i cross-platform build vodiče |

---

## Agenti

OpenCode uključuje više ugrađenih primary agenata koji se mogu prebacivati pomoću `Tab`. Podrazumijevani agent se može promijeniti pomoću `default_agent`; subagenti se uglavnom pozivaju dispatchom zadataka ili preko `@agent`.

| Agent | Tip | Model Dozvola | Najbolje Za |
| --- | --- | --- | --- |
| `build` | primary | Podrazumijevani razvojni mode; pokreće alate prema konfiguriranim dozvolama, dopušta potvrdu pitanjem i ulazak u plan | Implementacija funkcija, ispravljanje bugova, pokretanje testova, end-to-end isporuka |
| `interactive` | primary | Konzervativniji interaktivni mode; `bash`, notebook izvršavanje i notebook environment operacije podrazumijevano pitaju | Zadaci koji trebaju potvrdu za ključne komande ili manji rizik slučajnih operacija |
| `auto` | primary | Omogućen samo kada je eksplicitno izabran; `bash`, `edit` i shell pristup vanjskim direktorijima ulaze u auto permission review | Automatski pregled shell/edit rizika bez slučajne promjene podrazumijevanog build ponašanja |
| `decide` | primary | Isključuje alate i donosi jednokratnu procjenu iz ograničenog nedavnog konteksta | Jeftinije jednokratne odluke, tradeoffi i izbori sljedećeg koraka uz model visokih performansi |
| `plan` | primary | Zabranjuje edit alate i notebook promjene; dopušta pisanje plan datoteka i izlazak iz plan | Analiza koda, planiranje, pregled rizika, dizajn prije izvršavanja |
| `general` | subagent | Opći subagent; zabranjuje `todowrite`, inače slijedi spojenu konfiguraciju dozvola | Složena pretraga, višekoračno istraživanje, podrška koja se može paralelizirati |
| `explore` | subagent | Dopušta samo pretragu, čitanje, listanje, web query i slične istraživačke alate | Brzo lociranje datoteka, simbola, lanaca poziva, konfiguracije i dokumentacije |
| `scout` | subagent, experimental | Cilja vanjsku dokumentaciju i source zavisnosti; dopušta čitanje managed repo cachea | Pregled implementacije third-party biblioteka, kloniranje sourcea zavisnosti, istraživanje ponašanja vanjskog API-ja |

`title`, `summary` i `compaction` su skriveni sistemski agenti za generiranje naslova, sažetke i tokove kompakcije, ne svakodnevni ciljevi za ručno prebacivanje. Saznajte više o [Agents](https://opencode.ai/docs/agents).

---

## Dokumentacija

| Resurs | Link |
| --- | --- |
| Zvanična dokumentacija | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Vodič za doprinos | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## FAQ

### Kako se ovo razlikuje od Claude Code-a?

Cilj sposobnosti je sličan, ali OpenCode se fokusira na open source, terminal-first upotrebu, nezavisnost od providera, client/server arhitekturu i proširiv sistem alata. SMARK grana dodatno jača Windows/PowerShell, VS Code Notebook, vidljivost tokena, podršku za mrežni proxy i iskustvo instalacije.

### Za koga je ova grana?

Ako često razvijate u terminalu, trebate auditabilno ponašanje agenta ili koristite AI coding agente u Windows/PowerShell ili VS Code Notebook scenarijima, ova grana pruža potpunije iskustvo od upstream podrazumijevanih postavki.

### Zašto installer podrazumijevano ne koristi sudo?

Korisnička instalacija je sigurnija i lakša za upravljanje. Installer podrazumijevano piše u korisnički direktorij i odbija implicitni sudo. Koristite `sudo env ... --allow-sudo` samo kada eksplicitno instalirate u sistemski direktorij kao što je `/usr/local/bin`; također razmotrite `--no-modify-path` da izbjegnete da root mijenja korisničke profile.

### Šta ako stari opencode već postoji na sistemu?

Installer vjeruje samo ciljnoj instalacijskoj putanji. Čak i ako `/usr/local/bin/opencode` već ima istu verziju, navođenje `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` i dalje instalira u `~/.local/bin/opencode` i neće biti blokirano starim binarnim fajlom u PATH.

---

## Doprinosi

Pročitajte [vodič za doprinos](./CONTRIBUTING.md) prije slanja PR-a. Ako naziv vašeg projekta koristi `opencode`, navedite u njegovom README-u da to nije zvanični projekat OpenCode tima i da nije povezan s OpenCode timom.

---

## Zajednica

**Pridružite se našoj zajednici** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
