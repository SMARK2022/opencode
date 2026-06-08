<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">Open source AI Coding Agent — ulepszona gałąź SMARK</p>
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

> **O tej gałęzi**: To ulepszona gałąź OpenCode `dev-smark` (bieżąca wersja `1.15.6`, tag wydania CLI `v1.15.6-smark`). Jest oparta na upstream `dev` i koncentruje się na interakcji TUI, zarządzaniu sesjami, statystykach tokenów, zgodności z Windows/PowerShell, integracji z VS Code Notebook, obsłudze proxy sieciowego i doświadczeniu instalacji.

---

## Szybka Instalacja

Użyj instalatora ze strony wydań gałęzi SMARK. Domyślnie instaluje najnowsze wydanie i zapisuje katalog instalacji w istniejących profilach shell.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Zweryfikuj po instalacji:

```bash
opencode --version
which opencode
```

Jeśli bieżący shell nie odświeżył PATH, otwórz terminal ponownie albo wykonaj source profilu wskazanego w logu instalacji.

### Określenie Katalogu Instalacji

Zalecane są instalacje na poziomie użytkownika w `~/.local/bin`. Zmienna środowiskowa musi zostać przekazana do procesu `bash`, który uruchamia instalator, a nie tylko do `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

Do rozwiązywania problemów najpierw pobierz skrypt, a potem go uruchom:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Nie zapisuj tego w ten sposób:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

To przekazuje `OPENCODE_INSTALL_DIR` tylko do `curl`, a nie do procesu `bash`, który faktycznie uruchamia instalator.

### Określenie Wersji

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.6-smark
```

To jest pełna forma: `bash -s --` mówi `bash`, aby odczytał instalator ze stdin i przekazał `--version 1.15.6-smark` jako argumenty instalatora. Wersją może być `1.15.6-smark` albo forma tagu wydania `v1.15.6-smark`.

### Zachowanie Instalatora

| Scenariusz | Zachowanie |
| --- | --- |
| Domyślny katalog instalacji | `$OPENCODE_INSTALL_DIR`, potem `$XDG_BIN_DIR`, potem `$HOME/.opencode/bin` |
| Ta sama wersja już w ścieżce docelowej | Ponowna instalacja i nadpisanie, przydatne do odświeżania uszkodzonych lub nieaktualnych plików binarnych |
| Ta sama wersja gdzie indziej w PATH | Wypisz tylko powiadomienie; nie blokuj instalacji do żądanego katalogu |
| Zapisywanie PATH | Domyślnie aktualizuje wszystkie istniejące obsługiwane profile i unika duplikatów wpisów |
| sudo | Domyślnie odmawia startu przez `sudo`; instalacje systemowe muszą jawnie przekazać `--allow-sudo` |
| macOS quarantine | Próbuje usunąć atrybut `com.apple.quarantine` po instalacji |
| checksum | Weryfikuje pobrane zasoby, gdy wydanie dostarcza `checksums.txt` |

### PATH I Profile Shell

Instalator wykrywa i aktualizuje istniejące profile: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*` i `~/.config/fish/config.fish`.

| Potrzeba | Polecenie |
| --- | --- |
| Nie modyfikuj PATH | `bash /tmp/opencode-install --no-modify-path` |
| Zapisz tylko jeden profil | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Wybierz profil interaktywnie | `bash /tmp/opencode-install --interactive` |
| Zainstaluj do katalogu systemowego | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

Jeśli chcesz, aby `~/.local/bin/opencode` miało priorytet przed `/usr/local/bin/opencode`, upewnij się, że profil porządkuje PATH tak:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Inne Metody Instalacji

Te metody używają upstreamowego ekosystemu menedżerów pakietów. Jeśli potrzebujesz buildu gałęzi SMARK, wybierz powyższy instalator z GitHub release.

| Platforma | Polecenie | Uwagi |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | Możesz też użyć `bun`, `pnpm` lub `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Upstream tap, zwykle szybko aktualizowany |
| macOS/Linux | `brew install opencode` | Oficjalna formuła Homebrew, może mieć opóźnienie |
| Windows | `scoop install opencode` | Pakiet Scoop |
| Windows | `choco install opencode` | Pakiet Chocolatey |
| Arch Linux | `sudo pacman -S opencode` | Pakiet stabilny |
| Arch Linux | `paru -S opencode-bin` | Najnowszy pakiet binarny AUR |
| Dowolny system | `mise use -g opencode` | Zarządzanie wersjami narzędzi przez mise |
| Nix | `nix run nixpkgs#opencode` | Można też uruchomić wersję deweloperską z GitHub |

---

## Szybki Start

```bash
cd <your-project>
opencode
```

Po uruchomieniu opisz zadanie bezpośrednio, na przykład "explain this module architecture", "fix this error" albo "add tests for this feature". W TUI użyj `Tab`, aby przełączać agentów, i używaj wbudowanych narzędzi do odczytu/zapisu plików, uruchamiania poleceń, sprawdzania diffów i zarządzania sesjami.

| Akcja | Opis |
| --- | --- |
| `Tab` | Przełączanie między dostępnymi agentami |
| Lista sesji | Wyświetlanie historii oraz wyszukiwanie tytułów i treści wiadomości |
| Podgląd diff | Pokazuje zmiany w stylu git diff przed i po zapisach plików |
| Ręczna kompakcja | Proaktywna kompakcja kontekstu w długich sesjach, aby zwolnić miejsce na tokeny |
| Narzędzie Shell | Obsługuje anulowanie, kompresję wyjścia i normalizację wyjścia PowerShell |

---

## Aplikacja Desktopowa

Gałąź SMARK `dev-smark` obecnie publikuje tylko wydania CLI, a nie instalatory aplikacji desktopowej. Dla aplikacji desktopowej (BETA) użyj [opencode.ai/download](https://opencode.ai/download) i upstreamowych notatek wydania jako źródła prawdy; nie traktuj strony wydań SMARK CLI jako źródła instalatorów desktopowych.

---

## Główne Funkcje

Ta gałąź nie jest tylko zbiorem funkcji; zamienia typowe problemy programistyczne w obserwowalne, odzyskiwalne i wieloplatformowe przepływy pracy.

| Obszar | Rozwiązany Problem | Co Zobaczysz |
| --- | --- | --- |
| Interakcja TUI | Długie wyjście, strumieniowane wiadomości, trudne do czytania diffy | Renderowanie na żywo, zwijane rozumowanie, podgląd diff, natychmiastowe aktualizacje statusu |
| Zarządzanie sesjami | Długie sesje tracą kontekst i są kosztowne do odtworzenia | Wyszukiwanie sesji, filtry ścieżek, ręczna kompakcja, odzyskiwanie po przerwaniu, Session Warping |
| Statystyki tokenów | Trudno ustalić, co zużywa kontekst | Tokeny wejścia/wyjścia, wyniki narzędzi, załączniki, rozbicie narzutu żądań |
| System narzędzi | Wyjście plików i shell może zanieczyszczać kontekst | Strukturalne wyjście Read, kompresja wyjścia Shell, automatyczny diff Write |
| Provider | Konfiguracja wielu kont, endpointów i modeli jest złożona | Aliasy providerów, nadpisanie wersji klienta, ClaudeCode provider |
| VSCode | Scenariusze Notebook nie mogą być niezawodnie obsługiwane przez agentów CLI | Podsumowanie cell, odczyt, edycja, uruchamianie, odczyt wyjścia, zarządzanie kernelem |
| Windows | PowerShell, kodowanie, ścieżki i CRLF są podatne na błędy | Dekodowanie CLIXML, poprawki UTF-8, normalizacja ścieżek, zachowanie CRLF |
| Proxy sieciowe | Logika proxy dla providerów, pluginów i fetch jest rozproszona | NetworkProxy spójnie obsługuje HTTP_PROXY, HTTPS_PROXY, NO_PROXY |
| Daemon | Wiele instancji, blokady, health checki i klienci są złożone | Server Lock, health checki, HttpApi, bilety PTY WebSocket |

### TUI I Doświadczenie Interakcji

| Możliwość | Szczegóły |
| --- | --- |
| Wyjście strumieniowane | Wiadomości asystenta i fragmenty rozumowania renderują się przyrostowo, z pokazywanym czasem trwania podczas streamingu |
| Wyświetlanie rozumowania | Długie rozumowanie można zwinąć, aby zmniejszyć zużycie ekranu |
| Podgląd diff | Nadpisania plików automatycznie generują widok w stylu git diff z liczbą dodanych/usuniętych linii |
| Lista sesji | Pokazuje streszczenia ostatnich wiadomości i obsługuje wyszukiwanie po tytule oraz treści wiadomości |
| Stabilność układu | Bardziej niezawodne paski przewijania, obsługa szerokości terminala i szerokości znaków CJK |
| Tryb Shell | Zapewnia przycisk anulowania, niestandardową ikonę, przykładowy placeholder i status ukończenia na żywo |

### Zarządzanie Sesją I Kontekstem

| Możliwość | Szczegóły |
| --- | --- |
| Odzyskiwanie sesji | Ukryte wiadomości, operacje undo, kontrole oczekujących wiadomości i odzyskiwanie po błędach są solidniejsze |
| Kontrola przerwań | Rejestruje liczbę przerwań i czas potwierdzenia; przerwania sesji nadrzędnej propagują się do podzadań |
| Zgodność ścieżek | Globalne ścieżki sesji Windows są normalizowane; magazyn sesji używa ścieżek względnych |
| Ręczna kompakcja | Użytkownicy mogą wyzwolić kompakcję; wybór kompakcji jest asynchroniczny i raportuje błędy |
| Kontekst Git | Automatycznie wstrzykuje bieżącą gałąź, status, ostatnie commity i powiązane dane z przełącznikiem konfiguracji |

### Widoczność Tokenów I Kosztów

| Wejście | Użycie | Wyświetlanie |
| --- | --- | --- |
| TUI Context usage | Uruchom `/context` w sesji albo wybierz `Context usage` z palety poleceń | Pokazuje bieżące okno kontekstu, model, użyte/dostępne tokeny i siatkę kategorii Prompt/Conversation/Window |
| Context usage footer | Dół panelu TUI | Z użyciem sesji pokazuje `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`; bez skumulowanego użycia pokazuje `Used`, `Free`, `Usable`, `Buffer` |
| Kolumna kosztów listy sesji | `opencode session list --cost` albo `opencode session list -c` | Dodaje kolumny `Cost` i `Tokens` do listy sesji, aby szybko znajdować kosztowne miejsca |
| Szczegóły pojedynczej sesji | `opencode session info -s <Session_ID>` | Pokazuje `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` według provider/model |
| Statystyki globalne | `opencode stats --models` | Podsumowuje koszt całkowity, średni koszt dzienny, średnie tokeny, użycie narzędzi i użycie modeli |

Statystyki wewnętrzne preferują dane request usage i cofają się do metadanych wiadomości dla starszych sesji. TUI Context usage szacuje też zużycie instruction, skills, tool definitions, załączników, wyników narzędzi i compaction summary w oknie kontekstu.

### System Narzędzi

| Narzędzie | Ulepszenie |
| --- | --- |
| Read | Metadane, stub, domyślna liczba odczytywanych linii, limity bajtów, ochrona plików urządzeń |
| Grep/Ripgrep | Ogranicza maksymalną liczbę plików i wyników, z jasnymi błędami dla zbyt szerokich wyszukiwań |
| Shell | bash, PowerShell i cmd używają osobnych promptów świadomych shella |
| Write | Automatycznie generuje diff przy nadpisywaniu plików, aby użytkownicy mogli potwierdzić rzeczywistą zmianę |
| Permission | Uprawnienia agenta nadrzędnego są filtrowane przed przekazaniem do podzadań; kontrole dostępności narzędzi są ostrzejsze |

### Provider I Modele

| Możliwość | Opis |
| --- | --- |
| Aliasy providerów | Konfiguracja wielu kont lub endpointów dla tego samego bazowego providera |
| Nadpisanie wersji klienta | Dostosowanie niestandardowych providerów, proxy zgodności i specjalnych endpointów API |
| ClaudeCode provider | Obsługuje API Key, Base URL i dynamiczne tryby uwierzytelniania |
| Cloudflare AI Gateway | Poprawki routingu; tool streaming jest domyślnie wyłączony dla modeli innych niż Anthropic |

### Integracja Z VS Code Notebook

Przed użyciem narzędzi Notebook zainstaluj rozszerzenie VS Code [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). Wersja rozszerzenia pozostaje `1.15.5` i może nadal działać z SMARK CLI `1.15.6`; nie wymaga aktualizacji dla tej aktualizacji README CLI. Rozszerzenie tworzy lokalny uwierzytelniony bridge między VS Code/Jupyter Notebook i OpenCode CLI; bez instalacji lub połączenia CLI nie może niezawodnie odczytywać, edytować ani uruchamiać komórek notebooka.

Po starcie rozszerzenie otwiera lokalny bridge na `127.0.0.1:<random port>` i zapisuje manifest heartbeat w `~/.local/state/opencode/ide/<uuid>.json`. OpenCode automatycznie wybiera pasujący bridge VS Code według workspace i ścieżki notebooka. W konfiguracjach remote SSH, WSL lub container CLI musi działać po tej samej stronie, która ma dostęp do bridge.

| Narzędzie | Cel |
| --- | --- |
| `vscode_notebook_summary` | Pobiera stabilne ID `#VSC-*`, indeks wyświetlania, typ, język, stan wykonania, podsumowanie wyjścia, stan dirty i informacje runtime dla komórek notebooka |
| `vscode_notebook_source` | Odczytuje źródło notebooka z globalnymi wirtualnymi numerami linii 1-based; zwracana treść jest domyślnie ograniczona do 16KB |
| `vscode_notebook_edit` | Wstawia, edytuje lub usuwa komórki; obsługuje dokładną zamianę ciągów `oldCode/newCode` oraz przełączanie typu code/markdown |
| `vscode_notebook_run` | Uruchamia jedną komórkę kodu lub zakres stabilnych ID przez VS Code/Jupyter; wykonanie zakresu zatrzymuje się przy błędzie lub timeout |
| `vscode_notebook_output` | Odczytuje tekst, obrazy, HTML, JSON i inne wyjścia; duże wyjścia są zapisywane w `.opencode/cache/notebook-outputs/` i zwracane jako ścieżki artifact |
| `vscode_notebook_env` | Sprawdza kernel/runtime, wyzwala wybór kernela, restartuje kernel albo zapisuje notebook, gdy użytkownik jawnie o to poprosi |

Zalecany przepływ: użyj `vscode_notebook_summary`, aby pobrać bieżące ID komórki, `vscode_notebook_source`, aby odczytać docelową komórkę, `vscode_notebook_run`, aby zweryfikować po edycji, i `vscode_notebook_output`, aby sprawdzić wyniki. Nie traktuj indeksu wyświetlania `cN` jako stabilnego długoterminowego odniesienia; po wstawieniach, usunięciach lub zmianach typu użyj nowego ID `#VSC-*` zwróconego przez narzędzie albo ponownie uruchom summary.

### Obsługa Wieloplatformowa

| Problem Platformy | Obsługa |
| --- | --- |
| Kodowanie Windows | Automatyczne wykrywanie UTF-8/UTF-16LE i naprawa mojibake z pipe |
| PowerShell | Dekodowanie CLIXML, normalizacja stderr, naprawa wyjścia UTF-8 |
| Różnice ścieżek | Normalizacja wielkości liter, separatorów i globalnych ścieżek sesji |
| Zakończenia linii | Zachowanie oryginalnego stylu CRLF/LF przy stosowaniu patchy |
| WSL | Utrzymuje przewodniki migracji i buildów wieloplatformowych |

---

## Agents

OpenCode zawiera wiele wbudowanych agentów primary, między którymi można przełączać się klawiszem `Tab`. Domyślny agent może zostać nadpisany przez `default_agent`; subagents są wywoływane głównie przez dispatch zadań albo `@agent`.

| Agent | Typ | Model Uprawnień | Najlepsze Do |
| --- | --- | --- | --- |
| `build` | primary | Domyślny tryb developerski; uruchamia narzędzia zgodnie ze skonfigurowanymi uprawnieniami, pozwala na potwierdzanie pytań i wejście w plan | Implementacja funkcji, naprawianie błędów, uruchamianie testów, dostarczanie end-to-end |
| `interactive` | primary | Bardziej konserwatywny tryb interaktywny; `bash`, wykonanie notebooka i operacje środowiska notebooka pytają domyślnie | Zadania wymagające potwierdzenia kluczowych poleceń lub niższego ryzyka przypadkowych operacji |
| `auto` | primary | Włączany tylko po jawnym wyborze; `bash`, `edit` i dostęp shella do katalogów zewnętrznych przechodzą auto permission review | Automatyczny przegląd ryzyka shell/edycji bez przypadkowej zmiany domyślnego zachowania build |
| `decide` | primary | Wyłącza narzędzia i wydaje jednorazowy osąd z ograniczonego ostatniego kontekstu | Tańsze jednorazowe decyzje, kompromisy i wybory następnego kroku z modelem wysokiej wydajności |
| `plan` | primary | Blokuje narzędzia edycji i zmiany notebooka; pozwala pisać pliki planu i wyjść z planu | Analiza kodu, planowanie, przegląd ryzyka, projekt przed wykonaniem |
| `general` | subagent | Ogólny subagent; zabrania `todowrite`, poza tym przestrzega scalonej konfiguracji uprawnień | Złożone wyszukiwanie, wieloetapowy research, równoleglone zadania pomocnicze |
| `explore` | subagent | Pozwala tylko na wyszukiwanie, odczyt, listowanie, zapytania web i podobne narzędzia eksploracyjne | Szybkie lokalizowanie plików, symboli, łańcuchów wywołań, konfiguracji i dokumentacji |
| `scout` | subagent, experimental | Celuje w zewnętrzne dokumenty i źródła zależności; pozwala na odczyty managed repo cache | Sprawdzanie implementacji bibliotek zewnętrznych, klonowanie źródeł zależności, badanie zachowania zewnętrznych API |

`title`, `summary` i `compaction` to ukryci agenci systemowi do generowania tytułów, podsumowań i przepływów kompakcji, a nie codzienne cele ręcznego przełączania. Dowiedz się więcej o [Agents](https://opencode.ai/docs/agents).

---

## Dokumentacja

| Zasób | Link |
| --- | --- |
| Oficjalna dokumentacja | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Przewodnik współtworzenia | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## FAQ

### Czym to się różni od Claude Code?

Cel możliwości jest podobny, ale OpenCode koncentruje się na open source, użyciu terminal-first, niezależności od providerów, architekturze klient/serwer i rozszerzalnym systemie narzędzi. Gałąź SMARK dodatkowo wzmacnia Windows/PowerShell, VS Code Notebook, widoczność tokenów, obsługę proxy sieciowego i doświadczenie instalacji.

### Dla kogo jest ta gałąź?

Jeśli często programujesz w terminalu, potrzebujesz audytowalnego zachowania agentów albo używasz AI coding agents w scenariuszach Windows/PowerShell lub VS Code Notebook, ta gałąź zapewnia pełniejsze doświadczenie niż domyślne ustawienia upstream.

### Dlaczego instalator domyślnie nie używa sudo?

Instalacja na poziomie użytkownika jest bezpieczniejsza i łatwiejsza do zarządzania. Instalator domyślnie zapisuje do katalogu użytkownika i odmawia niejawnego sudo. Używaj `sudo env ... --allow-sudo` tylko wtedy, gdy jawnie instalujesz do katalogu systemowego, takiego jak `/usr/local/bin`; rozważ też `--no-modify-path`, aby uniknąć modyfikowania profili użytkownika przez root.

### Co jeśli stary opencode już istnieje w systemie?

Instalator ufa tylko docelowej ścieżce instalacji. Nawet jeśli `/usr/local/bin/opencode` ma już tę samą wersję, wskazanie `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` nadal instaluje do `~/.local/bin/opencode` i nie zostanie zablokowane przez stary plik binarny w PATH.

---

## Współtworzenie

Przeczytaj [przewodnik współtworzenia](./CONTRIBUTING.md) przed wysłaniem PR. Jeśli nazwa twojego projektu używa `opencode`, napisz w jego README, że nie jest to oficjalny projekt zespołu OpenCode i nie jest powiązany z zespołem OpenCode.

---

## Społeczność

**Dołącz do naszej społeczności** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
