<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="Logo OpenCode">
    </picture>
  </a>
</p>
<p align="center">Agent de codage IA open source — branche améliorée SMARK</p>
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

> **À propos de cette branche** : il s'agit de la branche améliorée `dev-smark` d'OpenCode (version actuelle `1.15.7`, tag de release CLI `v1.15.7-smark`). Elle est basée sur la branche amont `dev` et se concentre sur l'interaction TUI, la gestion des sessions, les statistiques de tokens, la compatibilité Windows/PowerShell, l'intégration VS Code Notebook, la prise en charge des proxys réseau et l'expérience d'installation.

---

## Installation Rapide

Utilisez l'installateur depuis la page des releases de la branche SMARK. Par défaut, il installe la dernière release et écrit le répertoire d'installation dans les profils shell existants.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Vérifiez après l'installation :

```bash
opencode --version
which opencode
```

Si le shell courant n'a pas encore rafraîchi PATH, rouvrez le terminal ou sourcez le profil indiqué dans le journal d'installation.

### Spécifier Le Répertoire D'installation

Les installations au niveau utilisateur sont recommandées dans `~/.local/bin`. La variable d'environnement doit être transmise au processus `bash` qui exécute l'installateur, pas seulement à `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

Pour dépanner, téléchargez d'abord le script puis exécutez-le :

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

Ne l'écrivez pas ainsi :

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Cela transmet seulement `OPENCODE_INSTALL_DIR` à `curl`, pas au processus `bash` qui exécute réellement l'installateur.

### Spécifier La Version

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

C'est la forme complète : `bash -s --` indique à `bash` de lire l'installateur depuis stdin et de transmettre `--version 1.15.7-smark` comme arguments de l'installateur. La version peut être `1.15.7-smark` ou la forme tag de release `v1.15.7-smark`.

### Comportement De L'installateur

| Scénario | Comportement |
| --- | --- |
| Répertoire d'installation par défaut | `$OPENCODE_INSTALL_DIR`, puis `$XDG_BIN_DIR`, puis `$HOME/.opencode/bin` |
| Même version déjà au chemin cible | Réinstalle et écrase, utile pour rafraîchir des binaires endommagés ou obsolètes |
| Même version ailleurs dans PATH | Affiche seulement un avis ; ne bloque pas l'installation dans le répertoire demandé |
| Écriture de PATH | Met à jour par défaut tous les profils pris en charge existants et évite les doublons |
| sudo | Refuse le démarrage avec `sudo` par défaut ; les installations système doivent passer explicitement `--allow-sudo` |
| macOS quarantine | Tente de supprimer l'attribut `com.apple.quarantine` après l'installation |
| checksum | Vérifie les assets téléchargés lorsque la release fournit `checksums.txt` |

### PATH Et Profils Shell

L'installateur détecte et met à jour les profils existants : `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*` et `~/.config/fish/config.fish`.

| Besoin | Commande |
| --- | --- |
| Ne pas modifier PATH | `bash /tmp/opencode-install --no-modify-path` |
| Écrire dans un seul profil | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Choisir le profil interactivement | `bash /tmp/opencode-install --interactive` |
| Installer dans un répertoire système | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

Si vous voulez que `~/.local/bin/opencode` ait priorité sur `/usr/local/bin/opencode`, assurez-vous que votre profil ordonne PATH ainsi :

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Autres Méthodes D'installation

Ces méthodes utilisent l'écosystème amont des gestionnaires de paquets. Si vous avez besoin du build de la branche SMARK, préférez l'installateur de release GitHub ci-dessus.

| Plateforme | Commande | Notes |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | Vous pouvez aussi utiliser `bun`, `pnpm` ou `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Tap amont, généralement mis à jour rapidement |
| macOS/Linux | `brew install opencode` | Formule Homebrew officielle, peut être en retard |
| Windows | `scoop install opencode` | Paquet Scoop |
| Windows | `choco install opencode` | Paquet Chocolatey |
| Arch Linux | `sudo pacman -S opencode` | Paquet stable |
| Arch Linux | `paru -S opencode-bin` | Dernier paquet binaire AUR |
| Tout système | `mise use -g opencode` | Gérer les versions d'outils avec mise |
| Nix | `nix run nixpkgs#opencode` | Peut aussi exécuter la version de développement depuis GitHub |

---

## Démarrage Rapide

```bash
cd <your-project>
opencode
```

Après le démarrage, décrivez directement une tâche, par exemple "explain this module architecture", "fix this error" ou "add tests for this feature". Dans la TUI, utilisez `Tab` pour changer d'agent et les outils intégrés pour lire/écrire des fichiers, exécuter des commandes, inspecter les diffs et gérer les sessions.

| Action | Description |
| --- | --- |
| `Tab` | Passer d'un agent disponible à l'autre |
| Liste des sessions | Voir l'historique et rechercher dans les titres et le contenu des messages |
| Aperçu de diff | Afficher les changements au style git diff avant et après les écritures de fichiers |
| Compactage manuel | Compacter proactivement le contexte dans les longues sessions pour libérer de l'espace de tokens |
| Outil Shell | Prend en charge l'annulation, la compression de sortie et la normalisation de la sortie PowerShell |

---

## Application De Bureau

La branche SMARK `dev-smark` publie actuellement uniquement des releases CLI, pas d'installateurs d'application de bureau. Pour l'application de bureau (BETA), utilisez [opencode.ai/download](https://opencode.ai/download) et les notes de release amont comme source de vérité ; ne traitez pas la page de release CLI SMARK comme une source d'installateurs desktop.

---

## Fonctionnalités Principales

Cette branche n'est pas seulement une pile de fonctionnalités ; elle transforme des points de douleur courants du développement en workflows observables, récupérables et multiplateformes.

| Domaine | Problème Résolu | Ce Que Vous Verrez |
| --- | --- | --- |
| Interaction TUI | Sorties longues, messages en streaming, diffs difficiles à lire | Rendu en direct, raisonnement repliable, aperçu de diff, mises à jour d'état instantanées |
| Gestion des sessions | Les longues sessions perdent le contexte et coûtent cher à récupérer | Recherche de sessions, filtres de chemin, compactage manuel, récupération après interruption, Session Warping |
| Statistiques de tokens | Difficile de savoir ce qui consomme le contexte | Tokens d'entrée/sortie, résultats d'outils, pièces jointes, détails des surcoûts de requête |
| Système d'outils | Les sorties de fichiers et de shell peuvent polluer le contexte | Sortie Read structurée, compression de sortie Shell, diff automatique Write |
| Provider | La configuration multi-compte, endpoint et modèle est complexe | Alias de provider, remplacement de version client, ClaudeCode provider |
| VSCode | Les scénarios Notebook ne peuvent pas être opérés fiablement par des agents CLI | Résumé, lecture, édition, exécution et lecture de sortie de cellules, gestion du kernel |
| Windows | PowerShell, encodage, chemins et CRLF sont sujets aux erreurs | Décodage CLIXML, corrections UTF-8, normalisation des chemins, préservation CRLF |
| Proxy réseau | La logique de proxy provider, plugin et fetch est dispersée | NetworkProxy gère HTTP_PROXY, HTTPS_PROXY, NO_PROXY de manière cohérente |
| Daemon | Les multi-instances, verrous, health checks et clients sont complexes | Server Lock, health checks, HttpApi, tickets PTY WebSocket |

### Expérience TUI Et Interaction

| Capacité | Détails |
| --- | --- |
| Sortie en streaming | Les messages assistant et les fragments de raisonnement sont rendus incrémentalement, avec le temps écoulé affiché pendant le streaming |
| Affichage du raisonnement | Les longs raisonnements peuvent être repliés pour réduire l'espace écran utilisé |
| Aperçu de diff | Les écrasements de fichiers génèrent automatiquement une vue au style git diff avec le nombre de lignes ajoutées/supprimées |
| Liste des sessions | Affiche les résumés de messages récents et permet de rechercher par titre et contenu de message |
| Stabilité de mise en page | Barres de défilement, gestion de la largeur du terminal et largeur des caractères CJK plus fiables |
| Mode Shell | Fournit un bouton d'annulation, une icône personnalisée, un placeholder d'exemple et l'état d'achèvement en direct |

### Gestion Des Sessions Et Du Contexte

| Capacité | Détails |
| --- | --- |
| Récupération de session | Messages masqués, opérations d'annulation, vérifications de messages en attente et récupération d'erreur sont plus robustes |
| Contrôle d'interruption | Enregistre le nombre d'interruptions et l'heure de confirmation ; les interruptions de session parente se propagent aux sous-tâches |
| Compatibilité des chemins | Les chemins globaux de session Windows sont normalisés ; le stockage des sessions utilise des chemins relatifs |
| Compactage manuel | Les utilisateurs peuvent déclencher le compactage ; la sélection de compactage est asynchrone et signale les erreurs |
| Contexte Git | Injecte automatiquement la branche courante, le statut, les commits récents et les données liées avec un commutateur de configuration |

### Visibilité Des Tokens Et Des Coûts

| Entrée | Utilisation | Affichage |
| --- | --- | --- |
| TUI Context usage | Exécutez `/context` dans une session ou choisissez `Context usage` dans la palette de commandes | Affiche la fenêtre de contexte actuelle, le modèle, les tokens utilisés/disponibles et la grille de catégories Prompt/Conversation/Window |
| Context usage footer | Bas du panneau TUI | Avec l'utilisation de session, affiche `Input`, `Output`, `Reason`, `Cache W/R`, `Cost` ; sans utilisation cumulative, affiche `Used`, `Free`, `Usable`, `Buffer` |
| Colonne de coût de la liste des sessions | `opencode session list --cost` ou `opencode session list -c` | Ajoute les colonnes `Cost` et `Tokens` à la liste des sessions pour trouver rapidement les points chauds de coût |
| Détails d'une session | `opencode session info -s <Session_ID>` | Affiche `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` par provider/model |
| Statistiques globales | `opencode stats --models` | Résume le coût total, le coût moyen quotidien, les tokens moyens, l'utilisation des outils et l'utilisation des modèles |

Les statistiques internes préfèrent les données d'utilisation des requêtes et se rabattent sur les métadonnées de message pour les sessions plus anciennes. TUI Context usage estime aussi l'utilisation des instructions, skills, définitions d'outils, pièces jointes, résultats d'outils et résumés de compactage dans la fenêtre de contexte.

### Système D'outils

| Outil | Amélioration |
| --- | --- |
| Read | Métadonnées, stub, nombre de lignes lu par défaut, limites en octets, protection contre les fichiers de périphérique |
| Grep/Ripgrep | Limite le nombre maximal de fichiers et de résultats, avec des erreurs claires pour les recherches trop larges |
| Shell | bash, PowerShell et cmd utilisent séparément des prompts conscients du shell |
| Write | Génère automatiquement un diff lors de l'écrasement de fichiers afin que les utilisateurs puissent confirmer le changement réel |
| Permission | Les permissions de l'agent parent sont filtrées avant passage aux sous-tâches ; les vérifications de disponibilité des outils sont plus strictes |

### Provider Et Modèles

| Capacité | Description |
| --- | --- |
| Alias de provider | Configurer plusieurs comptes ou endpoints pour le même provider sous-jacent |
| Remplacement de version client | Adapter des providers personnalisés, des proxys de compatibilité et des endpoints API spéciaux |
| ClaudeCode provider | Prend en charge API Key, Base URL et les modes d'authentification dynamiques |
| Cloudflare AI Gateway | Corrections de routage ; le tool streaming est désactivé par défaut pour les modèles non Anthropic |

### Intégration VS Code Notebook

Avant d'utiliser les outils Notebook, installez l'extension VS Code [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). La version de l'extension reste `1.15.5` et peut continuer à fonctionner avec SMARK CLI `1.15.7` ; elle n'a pas besoin d'une mise à niveau pour cette mise à jour du README CLI. L'extension crée un bridge local authentifié entre VS Code/Jupyter Notebook et l'OpenCode CLI ; sans installation ou connexion, le CLI ne peut pas lire, éditer ou exécuter fiablement les cellules de notebook.

Après le démarrage, l'extension ouvre un bridge local sur `127.0.0.1:<random port>` et écrit un manifeste heartbeat dans `~/.local/state/opencode/ide/<uuid>.json`. OpenCode sélectionne automatiquement le bridge VS Code correspondant selon le workspace et le chemin du notebook. Dans les configurations SSH distant, WSL ou conteneur, le CLI doit s'exécuter du même côté que celui qui peut accéder au bridge.

| Outil | Objectif |
| --- | --- |
| `vscode_notebook_summary` | Obtenir les ID stables `#VSC-*`, l'index affiché, le type, le langage, l'état d'exécution, le résumé de sortie, l'état dirty et les infos runtime des cellules notebook |
| `vscode_notebook_source` | Lire le source du notebook avec des numéros de ligne virtuels globaux 1-based ; le contenu renvoyé est limité à 16KB par défaut |
| `vscode_notebook_edit` | Insérer, éditer ou supprimer des cellules ; prend en charge le remplacement exact de chaîne `oldCode/newCode` et le changement de type code/markdown |
| `vscode_notebook_run` | Exécuter une cellule de code ou une plage d'ID stables via VS Code/Jupyter ; l'exécution de plage s'arrête en cas d'échec ou de timeout |
| `vscode_notebook_output` | Lire les sorties texte, image, HTML, JSON et autres ; les grandes sorties sont écrites dans `.opencode/cache/notebook-outputs/` et renvoyées comme chemins d'artefact |
| `vscode_notebook_env` | Inspecter le kernel/runtime, déclencher la sélection de kernel, redémarrer le kernel ou sauvegarder un notebook lorsque l'utilisateur le demande explicitement |

Flux recommandé : utilisez `vscode_notebook_summary` pour obtenir l'ID de cellule courant, `vscode_notebook_source` pour lire la cellule cible, `vscode_notebook_run` pour valider après modification et `vscode_notebook_output` pour inspecter les résultats. Ne traitez pas l'index affiché `cN` comme une référence stable à long terme ; après des insertions, suppressions ou changements de type, utilisez le nouvel ID `#VSC-*` renvoyé par l'outil ou relancez summary.

### Prise En Charge Multiplateforme

| Problème De Plateforme | Traitement |
| --- | --- |
| Encodage Windows | Détecte automatiquement UTF-8/UTF-16LE et répare le mojibake de pipe |
| PowerShell | Décodage CLIXML, normalisation stderr, réparation de sortie UTF-8 |
| Différences de chemins | Normalise la casse, les séparateurs et les chemins globaux de session |
| Fins de ligne | Préserve le style CRLF/LF original lors de l'application de patches |
| WSL | Maintient les guides de migration et de build multiplateforme |

---

## Agents

OpenCode inclut plusieurs agents primary intégrés que vous pouvez changer avec `Tab`. L'agent par défaut peut être remplacé avec `default_agent` ; les subagents sont principalement invoqués par dispatch de tâche ou `@agent`.

| Agent | Type | Modèle De Permission | Idéal Pour |
| --- | --- | --- | --- |
| `build` | primary | Mode de développement par défaut ; exécute les outils selon les permissions configurées, permet la confirmation par question et l'entrée en plan | Implémenter des fonctionnalités, corriger des bugs, exécuter des tests, livraison de bout en bout |
| `interactive` | primary | Mode interactif plus conservateur ; `bash`, l'exécution notebook et les opérations d'environnement notebook demandent par défaut | Tâches nécessitant confirmation pour les commandes clés ou moins de risque d'opérations accidentelles |
| `auto` | primary | Activé seulement lors d'une sélection explicite ; `bash`, `edit` et l'accès shell aux répertoires externes entrent dans l'auto permission review | Examiner automatiquement le risque shell/édition sans modifier accidentellement le comportement build par défaut |
| `decide` | primary | Désactive les outils et produit un jugement ponctuel depuis un contexte récent limité | Décisions ponctuelles à coût moindre, arbitrages et choix de prochaine étape avec un modèle haute performance |
| `plan` | primary | Interdit les outils d'édition et les changements notebook ; permet d'écrire des fichiers de plan et de quitter plan | Analyse de code, planification, revue des risques, conception avant exécution |
| `general` | subagent | Subagent général ; interdit `todowrite`, sinon suit la configuration de permissions fusionnée | Recherche complexe, recherche multi-étapes, tâches de support parallélisables |
| `explore` | subagent | Autorise seulement la recherche, la lecture, le listing, les requêtes web et les outils d'exploration similaires | Localiser rapidement fichiers, symboles, chaînes d'appel, config et docs |
| `scout` | subagent, experimental | Cible les docs externes et le source des dépendances ; autorise les lectures de cache repo géré | Inspecter l'implémentation de bibliothèques tierces, cloner le source de dépendances, rechercher le comportement d'API externes |

`title`, `summary` et `compaction` sont des agents système masqués pour la génération de titres, les résumés et les flux de compactage, pas des cibles de changement manuel quotidien. En savoir plus sur les [Agents](https://opencode.ai/docs/agents).

---

## Documentation

| Ressource | Lien |
| --- | --- |
| Docs officielles | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Guide de contribution | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## FAQ

### En quoi est-ce différent de Claude Code ?

La cible de capacités est similaire, mais OpenCode se concentre sur l'open source, l'usage terminal-first, l'indépendance vis-à-vis des providers, l'architecture client/server et un système d'outils extensible. La branche SMARK renforce en plus Windows/PowerShell, VS Code Notebook, la visibilité des tokens, la prise en charge des proxys réseau et l'expérience d'installation.

### À qui s'adresse cette branche ?

Si vous développez souvent dans le terminal, avez besoin d'un comportement d'agent auditable ou utilisez des agents de codage IA dans des scénarios Windows/PowerShell ou VS Code Notebook, cette branche fournit une expérience plus complète que les valeurs par défaut amont.

### Pourquoi l'installateur n'utilise-t-il pas sudo par défaut ?

L'installation au niveau utilisateur est plus sûre et plus facile à gérer. L'installateur écrit dans un répertoire utilisateur par défaut et refuse le sudo implicite. Utilisez seulement `sudo env ... --allow-sudo` lorsque vous installez explicitement dans un répertoire système comme `/usr/local/bin` ; envisagez aussi `--no-modify-path` pour éviter que root modifie les profils utilisateur.

### Et si un ancien opencode existe déjà sur le système ?

L'installateur ne fait confiance qu'au chemin d'installation cible. Même si `/usr/local/bin/opencode` a déjà la même version, spécifier `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` installe tout de même dans `~/.local/bin/opencode` et ne sera pas bloqué par un ancien binaire dans PATH.

---

## Contribuer

Lisez le [guide de contribution](./CONTRIBUTING.md) avant de soumettre une PR. Si le nom de votre propre projet utilise `opencode`, indiquez dans son README qu'il ne s'agit pas d'un projet officiel de l'équipe OpenCode et qu'il n'est pas affilié à l'équipe OpenCode.

---

## Communauté

**Rejoignez notre communauté** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
