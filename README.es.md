<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="OpenCode logo">
    </picture>
  </a>
</p>
<p align="center">Agente de programación con IA de código abierto — rama mejorada SMARK</p>
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

> **Acerca de esta rama**: Esta es la rama mejorada `dev-smark` de OpenCode (versión actual `1.15.6`, CLI release tag `v1.15.6-smark`). Está basada en la rama upstream `dev` y se centra en la interacción TUI, la gestión de sesiones, las estadísticas de tokens, la compatibilidad con Windows/PowerShell, la integración con VS Code Notebook, el soporte de proxy de red y la experiencia de instalación.

---

## Instalación rápida

Usa el instalador de la página de releases de la rama SMARK. Por defecto instala la release más reciente y escribe el directorio de instalación en los perfiles de shell existentes.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Verifica después de instalar:

```bash
opencode --version
which opencode
```

Si el shell actual todavía no ha actualizado PATH, vuelve a abrir la terminal o haz source del profile indicado en el log de instalación.

### Especificar directorio de instalación

Para instalaciones de usuario se recomienda `~/.local/bin`. La variable de entorno debe pasarse al proceso `bash` que ejecuta el installer, no solo a `curl`.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

Para diagnosticar problemas, descarga primero el script y luego ejecútalo:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

No lo escribas así:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

Eso solo pasa `OPENCODE_INSTALL_DIR` a `curl`, no al proceso `bash` que realmente ejecuta el installer.

### Especificar versión

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.6-smark
```

Esta es la forma completa: `bash -s --` indica a `bash` que lea el installer desde stdin y pase `--version 1.15.6-smark` como argumentos del installer. La versión puede ser `1.15.6-smark` o la forma de release tag `v1.15.6-smark`.

### Comportamiento del installer

| Escenario | Comportamiento |
| --- | --- |
| Directorio de instalación predeterminado | `$OPENCODE_INSTALL_DIR`, luego `$XDG_BIN_DIR`, luego `$HOME/.opencode/bin` |
| Misma versión ya presente en la ruta de destino | Reinstala y sobrescribe, útil para refrescar binarios dañados u obsoletos |
| Misma versión en otro lugar de PATH | Solo imprime un aviso; no bloquea la instalación en el directorio solicitado |
| Escritura de PATH | Por defecto actualiza todos los perfiles existentes compatibles y evita entradas duplicadas |
| sudo | Rechaza el inicio con `sudo` por defecto; las instalaciones del sistema deben pasar `--allow-sudo` explícitamente |
| macOS quarantine | Intenta eliminar el atributo `com.apple.quarantine` después de instalar |
| checksum | Verifica los assets descargados cuando la release proporciona `checksums.txt` |

### PATH y perfiles de shell

El installer detecta y actualiza perfiles existentes: `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.zprofile`, `.zshenv`, `~/.config/bash/*`, `~/.config/zsh/*` y `~/.config/fish/config.fish`.

| Necesidad | Comando |
| --- | --- |
| No modificar PATH | `bash /tmp/opencode-install --no-modify-path` |
| Escribir solo un profile | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| Elegir profile interactivamente | `bash /tmp/opencode-install --interactive` |
| Instalar en un directorio del sistema | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

Si quieres que `~/.local/bin/opencode` tenga prioridad sobre `/usr/local/bin/opencode`, asegúrate de que tu profile ordene PATH así:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Otros métodos de instalación

Estos métodos usan el ecosistema upstream de gestores de paquetes. Si necesitas la build de la rama SMARK, prefiere el GitHub release installer anterior.

| Plataforma | Comando | Notas |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | También puedes usar `bun`, `pnpm` o `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | Tap upstream, normalmente se actualiza rápido |
| macOS/Linux | `brew install opencode` | Fórmula oficial de Homebrew, puede ir con retraso |
| Windows | `scoop install opencode` | Paquete Scoop |
| Windows | `choco install opencode` | Paquete Chocolatey |
| Arch Linux | `sudo pacman -S opencode` | Paquete estable |
| Arch Linux | `paru -S opencode-bin` | Paquete binario AUR más reciente |
| Cualquier sistema | `mise use -g opencode` | Gestiona versiones de herramientas con mise |
| Nix | `nix run nixpkgs#opencode` | También puede ejecutar la versión de desarrollo desde GitHub |

---

## Inicio rápido

```bash
cd <your-project>
opencode
```

Después de iniciar, describe una tarea directamente, como "explica la arquitectura de este módulo", "corrige este error" o "agrega tests para esta funcionalidad". En la TUI, usa `Tab` para cambiar de agente y las herramientas integradas para leer/escribir archivos, ejecutar comandos, inspeccionar diffs y gestionar sesiones.

| Acción | Descripción |
| --- | --- |
| `Tab` | Cambiar entre los agentes disponibles |
| Lista de sesiones | Ver historial y buscar títulos y contenido de mensajes |
| Vista previa de diff | Mostrar cambios con estilo git diff antes y después de escrituras de archivos |
| Compactación manual | Compactar proactivamente el contexto en sesiones largas para liberar espacio de tokens |
| Herramienta Shell | Soporta cancelación, compresión de salida y normalización de salida de PowerShell |

---

## Aplicación de escritorio

La rama SMARK `dev-smark` actualmente solo publica releases de CLI, no instaladores de aplicación de escritorio. Para la aplicación de escritorio (BETA), usa [opencode.ai/download](https://opencode.ai/download) y las notas de release upstream como fuente de verdad; no trates la página de releases de SMARK CLI como fuente de instaladores de escritorio.

---

## Funciones principales

Esta rama no es solo una acumulación de funciones; convierte dolores frecuentes del desarrollo real en flujos de trabajo observables, recuperables y multiplataforma.

| Área | Problema que resuelve | Lo que verás |
| --- | --- | --- |
| Interacción TUI | Salida larga, mensajes streaming, diffs difíciles de leer | Renderizado en vivo, razonamiento plegable, vista previa de diff, actualizaciones de estado instantáneas |
| Gestión de sesiones | Las sesiones largas pierden contexto y son costosas de recuperar | Búsqueda de sesiones, filtros de ruta, compactación manual, recuperación de interrupciones, Session Warping |
| Estadísticas de tokens | Es difícil saber qué consume contexto | Tokens de entrada/salida, resultados de herramientas, adjuntos, desglose de sobrecarga de requests |
| Sistema de herramientas | La salida de archivos y shell puede contaminar el contexto | Salida Read estructurada, compresión de salida Shell, diff automático de Write |
| Provider | La configuración multi-cuenta, endpoint y modelo es compleja | Alias de provider, sobrescritura de versión de cliente, ClaudeCode provider |
| VSCode | Los escenarios Notebook no pueden ser operados de forma fiable por agentes CLI | Resumen de celdas, lectura, edición, ejecución, lectura de salida, gestión de kernel |
| Windows | PowerShell, codificación, rutas y CRLF son propensos a errores | Decodificación CLIXML, correcciones UTF-8, normalización de rutas, preservación de CRLF |
| Proxy de red | La lógica de proxy para provider, plugin y fetch está dispersa | NetworkProxy maneja HTTP_PROXY, HTTPS_PROXY, NO_PROXY de forma consistente |
| Daemon | Múltiples instancias, locks, health checks y clientes son complejos | Server Lock, health checks, HttpApi, tickets PTY WebSocket |

### Experiencia TUI e interacción

| Capacidad | Detalles |
| --- | --- |
| Salida streaming | Los mensajes del asistente y fragmentos de razonamiento se renderizan incrementalmente, mostrando el tiempo transcurrido durante streaming |
| Visualización de razonamiento | El razonamiento largo se puede plegar para reducir uso de pantalla |
| Vista previa de diff | Las sobrescrituras de archivos generan automáticamente una vista con estilo git diff y conteos de líneas añadidas/eliminadas |
| Lista de sesiones | Muestra resúmenes de mensajes recientes y permite buscar por título y contenido de mensajes |
| Estabilidad de layout | Barras de desplazamiento, manejo de ancho de terminal y ancho de caracteres CJK más fiables |
| Modo Shell | Proporciona botón de cancelación, icono personalizado, placeholder de ejemplo y estado de finalización en vivo |

### Gestión de sesión y contexto

| Capacidad | Detalles |
| --- | --- |
| Recuperación de sesión | Mensajes ocultos, operaciones de undo, comprobaciones de mensajes pendientes y recuperación de errores son más robustos |
| Control de interrupciones | Registra conteos de interrupción y tiempo de confirmación; las interrupciones de sesión padre se propagan a subtareas |
| Compatibilidad de rutas | Las rutas de sesión globales de Windows se normalizan; el almacenamiento de sesiones usa rutas relativas |
| Compactación manual | Los usuarios pueden activar compactación; la selección de compactación es asíncrona e informa errores |
| Contexto Git | Inyecta automáticamente rama actual, estado, commits recientes y datos relacionados con un interruptor de configuración |

### Visibilidad de tokens y costes

| Entrada | Uso | Visualización |
| --- | --- | --- |
| TUI Context usage | Ejecuta `/context` en una sesión o elige `Context usage` desde la paleta de comandos | Muestra la ventana de contexto actual, modelo, tokens usados/disponibles y la cuadrícula de categorías Prompt/Conversation/Window |
| Context usage footer | Parte inferior del panel TUI | Con uso de sesión, muestra `Input`, `Output`, `Reason`, `Cache W/R`, `Cost`; sin uso acumulado, muestra `Used`, `Free`, `Usable`, `Buffer` |
| Columna de coste de lista de sesiones | `opencode session list --cost` o `opencode session list -c` | Agrega las columnas `Cost` y `Tokens` a la lista de sesiones para encontrar rápidamente hotspots de coste |
| Detalles de una sola sesión | `opencode session info -s <Session_ID>` | Muestra `Calls`, `Input`, `Cache Write`, `Cache Read`, `Output`, `Cost` por provider/model |
| Estadísticas globales | `opencode stats --models` | Resume coste total, coste promedio diario, tokens promedio, uso de herramientas y uso de modelos |

Las estadísticas internas prefieren datos de request usage y recurren a metadatos de mensajes para sesiones antiguas. TUI Context usage también estima el uso de instructions, skills, tool definitions, adjuntos, resultados de herramientas y compaction summary en la ventana de contexto.

### Sistema de herramientas

| Herramienta | Mejora |
| --- | --- |
| Read | Metadatos, stub, conteo de líneas de lectura predeterminado, límites de bytes, protección de archivos de dispositivo |
| Grep/Ripgrep | Limita el máximo de archivos y conteos de resultados, con errores claros para búsquedas demasiado amplias |
| Shell | bash, PowerShell y cmd usan prompts conscientes de cada shell por separado |
| Write | Genera automáticamente un diff al sobrescribir archivos para que los usuarios puedan confirmar el cambio real |
| Permission | Los permisos de agente padre se filtran antes de pasarse a subtareas; las comprobaciones de disponibilidad de herramientas son más estrictas |

### Provider y modelos

| Capacidad | Descripción |
| --- | --- |
| Alias de provider | Configura múltiples cuentas o endpoints para el mismo provider subyacente |
| Sobrescritura de versión de cliente | Adapta providers personalizados, proxies de compatibilidad y endpoints API especiales |
| ClaudeCode provider | Soporta API Key, Base URL y modos de autenticación dinámica |
| Cloudflare AI Gateway | Correcciones de routing; tool streaming está deshabilitado por defecto para modelos no Anthropic |

### Integración con VS Code Notebook

Antes de usar herramientas Notebook, instala la extensión de VS Code [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). La versión de la extensión permanece en `1.15.5` y puede seguir funcionando con SMARK CLI `1.15.6`; no necesita una actualización para este cambio de README de CLI. La extensión crea un bridge local autenticado entre VS Code/Jupyter Notebook y OpenCode CLI; sin instalarla o conectarla, la CLI no puede leer, editar ni ejecutar celdas de notebook de forma fiable.

Después de iniciar, la extensión abre un bridge local en `127.0.0.1:<random port>` y escribe un manifest con heartbeat en `~/.local/state/opencode/ide/<uuid>.json`. OpenCode selecciona automáticamente el bridge de VS Code que coincide por workspace y ruta de notebook. En configuraciones remotas SSH, WSL o contenedores, la CLI debe ejecutarse en el mismo lado que puede acceder al bridge.

| Herramienta | Propósito |
| --- | --- |
| `vscode_notebook_summary` | Obtener IDs `#VSC-*` estables, índice visual, tipo, lenguaje, estado de ejecución, resumen de salida, estado dirty e información de runtime para celdas de notebook |
| `vscode_notebook_source` | Leer código fuente de notebook con números de línea virtuales globales basados en 1; el contenido devuelto está limitado a 16KB por defecto |
| `vscode_notebook_edit` | Insertar, editar o eliminar celdas; soporta reemplazo exacto de strings `oldCode/newCode` y cambio de tipo code/markdown |
| `vscode_notebook_run` | Ejecutar una celda code o un rango de IDs estables mediante VS Code/Jupyter; la ejecución por rango se detiene ante fallo o timeout |
| `vscode_notebook_output` | Leer texto, imagen, HTML, JSON y otras salidas; las salidas grandes se escriben en `.opencode/cache/notebook-outputs/` y se devuelven como rutas de artifact |
| `vscode_notebook_env` | Inspeccionar kernel/runtime, activar selección de kernel, reiniciar kernel o guardar un notebook cuando el usuario lo solicite explícitamente |

Flujo recomendado: usa `vscode_notebook_summary` para obtener el ID de celda actual, `vscode_notebook_source` para leer la celda objetivo, `vscode_notebook_run` para validar después de editar y `vscode_notebook_output` para inspeccionar resultados. No trates el índice visual `cN` como referencia estable a largo plazo; después de inserciones, eliminaciones o cambios de tipo, usa el nuevo ID `#VSC-*` devuelto por la herramienta o ejecuta summary otra vez.

### Soporte multiplataforma

| Problema de plataforma | Manejo |
| --- | --- |
| Codificación de Windows | Detecta automáticamente UTF-8/UTF-16LE y repara mojibake de pipes |
| PowerShell | Decodificación CLIXML, normalización de stderr, reparación de salida UTF-8 |
| Diferencias de rutas | Normaliza mayúsculas/minúsculas, separadores y rutas de sesión globales |
| Finales de línea | Preserva el estilo CRLF/LF original al aplicar patches |
| WSL | Mantiene guías de migración y build multiplataforma |

---

## Agents

OpenCode incluye varios primary agents integrados que se pueden cambiar con `Tab`. El agent predeterminado puede sobrescribirse con `default_agent`; los subagents se invocan principalmente mediante despacho de tareas o `@agent`.

| Agent | Tipo | Modelo de permisos | Ideal para |
| --- | --- | --- | --- |
| `build` | primary | Modo de desarrollo predeterminado; ejecuta herramientas según los permisos configurados, permite confirmación con preguntas y entrar en plan | Implementar funcionalidades, corregir bugs, ejecutar tests, entrega end-to-end |
| `interactive` | primary | Modo interactivo más conservador; `bash`, ejecución de notebook y operaciones de entorno de notebook preguntan por defecto | Tareas que necesitan confirmación para comandos clave o menor riesgo de operaciones accidentales |
| `auto` | primary | Se habilita solo cuando se selecciona explícitamente; `bash`, `edit` y acceso a directorios externos de shell entran en auto permission review | Revisar automáticamente el riesgo de shell/edición sin cambiar accidentalmente el comportamiento predeterminado de build |
| `decide` | primary | Deshabilita herramientas y emite un juicio único desde contexto reciente limitado | Decisiones puntuales de menor coste, tradeoffs y elección de próximos pasos con un modelo de alto rendimiento |
| `plan` | primary | No permite herramientas de edición ni cambios de notebook; permite escribir archivos de plan y salir de plan | Análisis de código, planificación, revisión de riesgos, diseño previo a la ejecución |
| `general` | subagent | Subagent general; prohíbe `todowrite`, por lo demás sigue la configuración de permisos fusionada | Búsqueda compleja, investigación de varios pasos, tareas de apoyo paralelizables |
| `explore` | subagent | Permite solo búsqueda, lectura, listado, consultas web y herramientas de exploración similares | Localizar rápidamente archivos, símbolos, cadenas de llamadas, configuración y documentación |
| `scout` | subagent, experimental | Orientado a docs externas y código fuente de dependencias; permite lecturas de cache de repo gestionada | Inspeccionar implementaciones de bibliotecas de terceros, clonar código fuente de dependencias, investigar comportamiento de APIs externas |

`title`, `summary` y `compaction` son agentes de sistema ocultos para generación de títulos, resúmenes y flujos de compactación, no objetivos de cambio manual diario. Más información sobre [Agents](https://opencode.ai/docs/agents).

---

## Documentación

| Recurso | Enlace |
| --- | --- |
| Documentación oficial | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| Guía de contribución | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## FAQ

### ¿En qué se diferencia de Claude Code?

El objetivo de capacidades es similar, pero OpenCode se centra en código abierto, uso terminal-first, independencia de provider, arquitectura cliente/servidor y un sistema de herramientas extensible. La rama SMARK refuerza además Windows/PowerShell, VS Code Notebook, visibilidad de tokens, soporte de proxy de red y experiencia de instalación.

### ¿Para quién es esta rama?

Si desarrollas a menudo en la terminal, necesitas comportamiento auditable del agente o usas agentes de programación con IA en escenarios Windows/PowerShell o VS Code Notebook, esta rama ofrece una experiencia más completa que los valores predeterminados upstream.

### ¿Por qué el installer no usa sudo por defecto?

La instalación a nivel de usuario es más segura y fácil de gestionar. El installer escribe en un directorio de usuario por defecto y rechaza sudo implícito. Usa `sudo env ... --allow-sudo` solo cuando instales explícitamente en un directorio del sistema como `/usr/local/bin`; considera también `--no-modify-path` para evitar que root modifique perfiles de usuario.

### ¿Qué pasa si ya existe un opencode antiguo en el sistema?

El installer solo confía en la ruta de instalación objetivo. Aunque `/usr/local/bin/opencode` ya tenga la misma versión, especificar `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` todavía instala en `~/.local/bin/opencode` y no será bloqueado por un binario antiguo en PATH.

---

## Contribuir

Lee la [guía de contribución](./CONTRIBUTING.md) antes de enviar un PR. Si el nombre de tu propio proyecto usa `opencode`, indica en su README que no es un proyecto oficial del equipo de OpenCode y que no está afiliado al equipo de OpenCode.

---

## Comunidad

**Únete a nuestra comunidad** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
