<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="شعار OpenCode">
    </picture>
  </a>
</p>
<p align="center">AI Coding Agent مفتوح المصدر — فرع SMARK المحسن</p>
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

> **حول هذا الفرع**: هذا هو فرع OpenCode المحسن `dev-smark`، الإصدار الحالي `1.15.7` ووسم إصدار CLI هو `v1.15.7-smark`. يعتمد على فرع upstream `dev` ويركز على تحسين تفاعل TUI، وإدارة الجلسات، وإحصاءات token، وتوافق Windows/PowerShell، وتكامل VSCode Notebook، ووكيل الشبكة، وتجربة التثبيت.

---

## التثبيت السريع

يوصى باستخدام سكربت التثبيت من صفحة إصدارات فرع SMARK. يثبت أحدث release افتراضيا، ويكتب دليل التثبيت في shell profile الموجود.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

التحقق بعد التثبيت:

```bash
opencode --version
which opencode
```

إذا لم يقم shell الحالي بتحديث PATH بعد، أعد فتح الطرفية أو نفذ source للملف الشخصي كما توضحه سجلات التثبيت.

### تحديد دليل التثبيت

يوصى بتثبيت مستوى المستخدم في `~/.local/bin`. لاحظ أن متغير البيئة يجب أن يمرر إلى `bash` الذي يشغل installer في الجهة اليمنى، وليس إلى `curl` فقط.

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash
```

الصيغة الأنسب لتشخيص المشاكل هي تنزيل السكربت أولا ثم تشغيله:

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install -o /tmp/opencode-install
env OPENCODE_INSTALL_DIR="$HOME/.local/bin" bash /tmp/opencode-install
```

لا تكتبها هكذا:

```bash
OPENCODE_INSTALL_DIR="$HOME/.local/bin" curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | bash
```

هذه الصيغة تمرر `OPENCODE_INSTALL_DIR` إلى `curl` فقط، ولا تمرره إلى `bash` الذي يشغل سكربت التثبيت فعليا.

### تحديد الإصدار

```bash
curl -fsSL https://github.com/SMARK2022/opencode/releases/latest/download/install | \
  bash -s -- --version 1.15.7-smark
```

هذا هو الشكل الكامل: تعني `bash -s --` أن `bash` يقرأ installer من stdin ويمرر `--version 1.15.7-smark` كوسائط للـ installer. يمكن كتابة الإصدار كـ `1.15.7-smark` أو بصيغة release tag وهي `v1.15.7-smark`.

### سلوك سكربت التثبيت

| السيناريو | السلوك |
| --- | --- |
| دليل التثبيت الافتراضي | `$OPENCODE_INSTALL_DIR` ثم `$XDG_BIN_DIR` ثم `$HOME/.opencode/bin` |
| المسار الهدف يحتوي الإصدار نفسه | يعيد التثبيت فوقه لتحديث binary تالف أو قديم |
| PATH يحتوي الإصدار نفسه في موضع آخر | يطبع تلميحا فقط ولا يمنع التثبيت في الدليل المحدد |
| كتابة PATH | يحدث كل ملفات profile المدعومة الموجودة افتراضيا، ولا يكرر الإدخال |
| sudo | يرفض التشغيل عبر `sudo` افتراضيا؛ يحتاج تثبيت النظام إلى `--allow-sudo` صراحة |
| macOS quarantine | يحاول تلقائيا إزالة الخاصية `com.apple.quarantine` بعد التثبيت |
| checksum | إذا وفر release ملف `checksums.txt`، يتحقق من أصل التنزيل |

### PATH و shell profile

يتعرف سكربت التثبيت على ملفات profile الموجودة التالية ويحدثها: `.bashrc`، `.bash_profile`، `.profile`، `.zshrc`، `.zprofile`، `.zshenv`، `~/.config/bash/*`، `~/.config/zsh/*`، `~/.config/fish/config.fish`.

| الحاجة | الأمر |
| --- | --- |
| عدم تعديل PATH | `bash /tmp/opencode-install --no-modify-path` |
| الكتابة إلى profile محدد فقط | `bash /tmp/opencode-install --path-profile "$HOME/.bash_profile"` |
| اختيار profile تفاعليا | `bash /tmp/opencode-install --interactive` |
| التثبيت في دليل نظام | `sudo env OPENCODE_INSTALL_DIR=/usr/local/bin bash /tmp/opencode-install --allow-sudo --no-modify-path` |

إذا أردت أن تكون `~/.local/bin/opencode` قبل `/usr/local/bin/opencode`، فتأكد أن ترتيب PATH في profile يشبه هذا:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### طرق تثبيت أخرى

هذه الطرق مناسبة لمن يستخدم منظومة مديري الحزم upstream. إذا كنت تحتاج إصدار فرع SMARK، فاستخدم GitHub release installer أعلاه أولا.

| المنصة | الأمر | الوصف |
| --- | --- | --- |
| Node.js | `npm i -g opencode-ai@latest` | يمكن أيضا استخدام `bun` و `pnpm` و `yarn` |
| macOS/Linux | `brew install anomalyco/tap/opencode` | upstream tap، وغالبا يحدث بسرعة |
| macOS/Linux | `brew install opencode` | Homebrew official formula، وقد يتأخر |
| Windows | `scoop install opencode` | حزمة Scoop |
| Windows | `choco install opencode` | حزمة Chocolatey |
| Arch Linux | `sudo pacman -S opencode` | حزمة مستقرة |
| Arch Linux | `paru -S opencode-bin` | أحدث binary من AUR |
| أي نظام | `mise use -g opencode` | إدارة إصدارات الأدوات عبر mise |
| Nix | `nix run nixpkgs#opencode` | يمكن أيضا تشغيل نسخة تطوير من مصدر GitHub |

---

## البدء السريع

```bash
cd <your-project>
opencode
```

بعد التشغيل يمكنك وصف المهمة مباشرة، مثل "اشرح معمارية هذا module" أو "أصلح هذا الخطأ" أو "أضف اختبارات لهذه الميزة". داخل TUI استخدم `Tab` للتبديل بين Agents، واستخدم الأدوات المدمجة لقراءة الملفات وكتابتها، وتشغيل الأوامر، وعرض diff، وإدارة الجلسات.

| الإجراء | الوصف |
| --- | --- |
| `Tab` | التبديل بين Agents المتاحة |
| قائمة الجلسات | عرض الجلسات السابقة والبحث في العناوين ومحتوى الرسائل |
| معاينة Diff | عرض تغييرات بأسلوب git diff قبل وبعد كتابة الملفات |
| الضغط اليدوي | ضغط السياق يدويا في الجلسات الطويلة لتحرير مساحة token |
| أداة Shell | تدعم الإلغاء، وضغط المخرجات، وتطبيع مخرجات PowerShell |

---

## تطبيق سطح المكتب

فرع SMARK `dev-smark` ينشر حاليا CLI فقط، ولا ينشر حزم تثبيت لتطبيق سطح المكتب. إذا احتجت نسخة سطح المكتب (BETA)، فاعتمد على [opencode.ai/download](https://opencode.ai/download) وملاحظات إصدار upstream؛ لا تعتبر صفحة إصدارات SMARK CLI مصدرا لحزم desktop.

---

## الميزات الأساسية

يركز هذا الفرع على تحويل آلام التطوير المتكررة إلى workflows قابلة للملاحظة والاستعادة والعمل عبر المنصات، وليس مجرد تكديس الميزات.

| الاتجاه | المشكلة التي يحلها | ما ستراه |
| --- | --- | --- |
| تفاعل TUI | المخرجات الطويلة، والرسائل المتدفقة، وصعوبة قراءة diff | عرض فوري، reasoning قابل للطي، معاينة diff، وتحديثات حالة مباشرة |
| إدارة الجلسات | الجلسات الطويلة تفقد السياق وتكلفة الاستعادة عالية | بحث الجلسات، تصفية المسارات، ضغط يدوي، استعادة من الانقطاع، Session Warping |
| إحصاءات Token | عدم معرفة ما يستهلك السياق | عرض مفصل لـ input/output token، نتائج الأدوات، المرفقات، وتكلفة الطلب |
| نظام الأدوات | قراءة/كتابة الملفات ومخرجات shell قد تلوث السياق | مخرجات Read منظمة، ضغط مخرجات Shell، و diff تلقائي في Write |
| Provider | تعقيد إعداد حسابات ونقاط نهاية ونماذج متعددة | Provider aliases، تجاوز إصدار العميل، و ClaudeCode provider |
| VSCode | لا يستطيع CLI Agent التعامل موثوقا مع Notebook | ملخص cell، القراءة، التحرير، التنفيذ، قراءة المخرجات، وإدارة kernel |
| Windows | مشاكل PowerShell والترميز والمسارات و CRLF | فك CLIXML، إصلاح UTF-8، تطبيع المسارات، والحفاظ على CRLF |
| وكيل الشبكة | منطق proxy متفرق بين provider و plugin و fetch | NetworkProxy يوحد معالجة HTTP_PROXY و HTTPS_PROXY و NO_PROXY |
| Daemon | تعدد النسخ، locks، health checks، واتصالات العملاء معقدة | Server Lock، health checks، HttpApi، وتذاكر PTY WebSocket |

### TUI وتجربة التفاعل

| القدرة | التفاصيل |
| --- | --- |
| المخرجات المتدفقة | عرض تدريجي لرسائل assistant ومقاطع reasoning، وإظهار الوقت المنقضي أثناء streaming |
| عرض reasoning | معاينة قابلة للطي للـ reasoning الطويل لتقليل استهلاك الشاشة |
| معاينة diff | إنشاء عرض بأسلوب git diff تلقائيا عند استبدال ملف، مع إحصاءات الأسطر المضافة والمحذوفة |
| قائمة الجلسات | عرض ملخص أحدث الرسائل، ودعم البحث حسب العنوان ومحتوى الرسائل |
| استقرار التخطيط | معالجة أوثق لشريط التمرير، وعرض الطرفية، وعرض أحرف CJK |
| وضع Shell | يوفر زر إلغاء، وأيقونات مخصصة، ونصوص placeholder، وحالة إكمال فورية |

### إدارة الجلسة والسياق

| القدرة | التفاصيل |
| --- | --- |
| استعادة الجلسة | منطق أكثر ثباتا للرسائل المخفية، و undo، وفحص الرسائل المعلقة، واستعادة الأخطاء |
| التحكم في المقاطعة | تسجيل عدد المقاطعات ووقت التأكيد، وانتشار مقاطعة الجلسة الأب إلى subtasks |
| توافق المسارات | تطبيع مسارات الجلسات العالمية على Windows، وتخزين الجلسات بمسارات نسبية |
| الضغط اليدوي | يمكن للمستخدم تشغيل الضغط يدويا، مع معالجة اختيار الضغط بشكل غير متزامن وتنبيهات أخطاء |
| سياق Git | حقن تلقائي للفرع الحالي والحالة وآخر commits، مع خيار إعداد |

### رؤية Token والتكلفة

| المدخل | طريقة الاستخدام | ما يعرضه |
| --- | --- | --- |
| TUI Context usage | نفذ `/context` داخل الجلسة، أو اختر `Context usage` من command palette | يعرض نافذة السياق الحالية، والنموذج، و token المستخدمة/المتاحة، وشبكة تصنيف Prompt/Conversation/Window |
| Context usage footer | أسفل لوحة TUI | عند وجود استخدام جلسة يعرض `Input` و `Output` و `Reason` و `Cache W/R` و `Cost`؛ وعند عدم وجود استخدام متراكم يعرض `Used` و `Free` و `Usable` و `Buffer` |
| عمود تكلفة قائمة الجلسات | `opencode session list --cost` أو `opencode session list -c` | يضيف عمودي `Cost` و `Tokens` إلى session list لتحديد مواضع التكلفة بسرعة |
| تفاصيل جلسة واحدة | `opencode session info -s <Session_ID>` | يعرض `Calls` و `Input` و `Cache Write` و `Cache Read` و `Output` و `Cost` حسب provider/model |
| الإحصاءات العامة | `opencode stats --models` | يلخص التكلفة الإجمالية، ومتوسط التكلفة اليومي، ومتوسط token، واستخدام الأدوات والنماذج |

تقرأ الإحصاءات الداخلية بيانات request usage أولا؛ وعند غيابها في الجلسات الأقدم، ترجع إلى metadata الرسائل. كما تقدر TUI Context usage استهلاك instruction و skills و tool definitions والمرفقات ونتائج الأدوات و compaction summary من نافذة السياق.

### نظام الأدوات

| الأداة | التحسين |
| --- | --- |
| Read | metadata، stub، عدد الأسطر الافتراضي، حدود bytes، وحماية device files |
| Grep/Ripgrep | حدود قصوى لعدد الملفات والنتائج، وخطأ واضح عند اتساع البحث أكثر من اللازم |
| Shell | prompts مخصصة حسب shell لكل من bash و PowerShell و cmd |
| Write | إنشاء diff تلقائيا عند استبدال الملفات لمساعدة المستخدم على تأكيد التعديل الفعلي |
| الصلاحيات | صلاحيات agent الأب تصفى قبل تمريرها إلى subtasks، وفحص توفر الأدوات أصبح أكثر صرامة |

### Provider والنماذج

| القدرة | الوصف |
| --- | --- |
| Provider aliases | إعداد عدة حسابات أو endpoints لنفس provider الأساسي |
| تجاوز إصدار العميل | التكيف مع provider مخصص، و proxies متوافقة، ونقاط API خاصة |
| ClaudeCode provider | دعم API Key و Base URL وأنماط مصادقة ديناميكية |
| Cloudflare AI Gateway | إصلاح routing، وتعطيل tool streaming افتراضيا للنماذج غير Anthropic |

### تكامل VS Code Notebook

قبل استخدام أدوات Notebook، ثبت إضافة VS Code [SMARK2022.opencode-ide-bridge](https://marketplace.visualstudio.com/items?itemName=SMARK2022.opencode-ide-bridge). يبقى إصدار الإضافة الحالي `1.15.5` ويمكنه العمل مع SMARK CLI `1.15.7`، ولا يحتاج إلى ترقية بسبب تحديث README الخاص بالـ CLI. تنشئ الإضافة bridge محليا موثقا بين VS Code/Jupyter Notebook و OpenCode CLI؛ وعند عدم تثبيتها أو عدم اتصالها، لا يستطيع CLI قراءة أو تحرير أو تنفيذ notebook cells بشكل موثوق.

بعد بدء الإضافة تفتح bridge محلية على `127.0.0.1:<random port>` وتكتب manifest مع heartbeat إلى `~/.local/state/opencode/ide/<uuid>.json`. يختار OpenCode تلقائيا VS Code bridge المطابق حسب workspace ومسار notebook؛ وفي سيناريوهات remote SSH أو WSL أو containers يجب أن يعمل CLI في نفس جانب البيئة القادر على الوصول إلى تلك bridge.

| الأداة | الاستخدام |
| --- | --- |
| `vscode_notebook_summary` | الحصول على ID ثابت بشكل `#VSC-*` للـ notebook cell، ورقم العرض، والنوع، واللغة، وحالة التنفيذ، وملخص المخرجات، وحالة dirty، ومعلومات runtime |
| `vscode_notebook_source` | قراءة مصدر notebook بصفحات عبر أرقام أسطر افتراضية global و 1-based، مع حد افتراضي للمحتوى 16KB |
| `vscode_notebook_edit` | إدراج أو تعديل أو حذف cell، مع دعم استبدال نصي دقيق عبر `oldCode/newCode`، ودعم تبديل نوع code/markdown |
| `vscode_notebook_run` | تنفيذ code cell واحد أو نطاق ID ثابت عبر VS Code/Jupyter؛ يتوقف تنفيذ النطاق عند أول فشل أو timeout |
| `vscode_notebook_output` | قراءة مخرجات النصوص والصور و HTML و JSON؛ وتكتب المخرجات الكبيرة إلى `.opencode/cache/notebook-outputs/` وتعيد مسار artifact |
| `vscode_notebook_env` | عرض kernel/runtime، وتشغيل اختيار kernel، وإعادة تشغيل kernel، أو حفظ notebook عند طلب المستخدم صراحة |

التدفق الموصى به: استخدم `vscode_notebook_summary` أولا للحصول على cell ID الحالي، ثم `vscode_notebook_source` لقراءة cell الهدف، وبعد التعديل استخدم `vscode_notebook_run` للتحقق، وأخيرا `vscode_notebook_output` لعرض النتائج. لا تعتبر رقم العرض `cN` مرجعا مستقرا طويل الأمد؛ بعد الإدراج أو الحذف أو تبديل النوع استخدم ID الجديد `#VSC-*` الذي تعيده الأداة أو أعد تشغيل summary.

### الدعم عبر المنصات

| مشكلة المنصة | المعالجة |
| --- | --- |
| ترميز Windows | اكتشاف UTF-8/UTF-16LE تلقائيا وإصلاح نصوص pipe المشوهة |
| PowerShell | فك CLIXML، وتطبيع stderr، وإصلاح مخرجات UTF-8 |
| اختلاف المسارات | تطبيع موحد لحالة الأحرف والفواصل ومسارات الجلسات العالمية |
| نهايات الأسطر | الحفاظ على نمط CRLF/LF الأصلي عند تطبيق patch |
| WSL | الحفاظ على إرشادات migration والبناء عبر المنصات |

---

## Agents

يتضمن OpenCode عدة primary agent مدمجة يمكن التبديل بينها بسرعة باستخدام `Tab`. يمكن تجاوز agent الافتراضي عبر إعداد `default_agent`؛ وتستدعى subagents أساسا عبر تفويض المهام أو صيغة `@agent`.

| Agent | النوع | نموذج الصلاحيات | الأنسب لـ |
| --- | --- | --- | --- |
| `build` | primary | وضع تطوير افتراضي، يشغل الأدوات حسب الصلاحيات المهيأة، ويسمح بتأكيد الأسئلة والدخول إلى plan | تنفيذ الميزات، إصلاح bug، تشغيل الاختبارات، والتسليم الكامل |
| `interactive` | primary | وضع تفاعلي أكثر تحفظا؛ يسأل افتراضيا قبل `bash` وتنفيذ notebook وعمليات بيئة notebook | مهام تطوير تحتاج تأكيد المستخدم للأوامر المهمة وتقليل مخاطر التشغيل الخاطئ |
| `auto` | primary | لا يفعل إلا عند اختياره صراحة؛ تدخل `bash` و `edit` والوصول إلى أدلة خارجية عبر shell في auto permission review | مراجعة مخاطر shell/edit تلقائيا مع تجنب تغيير سلوك build الافتراضي بالصدفة |
| `decide` | primary | يعطل الأدوات، ويعطي حكما لمرة واحدة اعتمادا على سياق حديث محدود | استخدام نموذج عالي الأداء لقرار واحد أقل تكلفة، أو مفاضلة خطط، أو تحديد الخطوة التالية |
| `plan` | primary | يمنع أدوات التحرير وتغييرات notebook، ويسمح بكتابة ملفات plan والخروج من plan | تحليل الكود، وضع خطة، فرز المخاطر، والتخطيط قبل التنفيذ |
| `general` | subagent | subagent عام، يمنع `todowrite`، والباقي يتبع إعداد الصلاحيات المدمج | بحث معقد، ودراسات متعددة الخطوات، ومهام مساعدة قابلة للتقسيم بالتوازي |
| `explore` | subagent | يسمح فقط بأدوات البحث والقراءة والlisting واستعلامات web | تحديد الملفات والرموز وسلاسل الاستدعاء والإعدادات والوثائق بسرعة |
| `scout` | subagent، تجريبي | موجه للوثائق الخارجية ومصدر التبعيات، ويسمح بقراءة managed repo cache | البحث في تنفيذ مكتبات طرف ثالث، واستنساخ مصدر التبعيات، ودراسة سلوك APIs خارجية |

`title` و `summary` و `compaction` هي agents نظام مخفية لتوليد العناوين والتلخيص والضغط، وليست أهداف تبديل يدوية يومية. تعرف أكثر على [Agents](https://opencode.ai/docs/agents).

---

## الوثائق

| المورد | الرابط |
| --- | --- |
| الوثائق الرسمية | https://opencode.ai/docs |
| Release | https://github.com/SMARK2022/opencode/releases |
| دليل المساهمة | [CONTRIBUTING.md](./CONTRIBUTING.md) |

---

## الأسئلة الشائعة

### ما الفرق بينه وبين Claude Code؟

يتشابه الهدف الوظيفي، لكن OpenCode يركز على كونه مفتوح المصدر، وأولوية الطرفية، والاستقلال عن provider، ومعمارية client/server، ونظام أدوات قابل للتوسعة. يعزز فرع SMARK فوق ذلك Windows/PowerShell و VSCode Notebook ورؤية Token ووكيل الشبكة وتجربة التثبيت.

### لمن يناسب هذا الفرع؟

إذا كنت تطور كثيرا داخل الطرفية، وتحتاج سلوك Agent قابلا للتدقيق، أو تحتاج AI coding agent في Windows/PowerShell أو VSCode Notebook، فهذا الفرع يقدم تجربة أكمل من upstream الافتراضي.

### لماذا لا يستخدم سكربت التثبيت sudo افتراضيا؟

التثبيت على مستوى المستخدم أكثر أمانا وأسهل إدارة. يكتب سكربت التثبيت افتراضيا في دليل المستخدم ويرفض sudo الضمني. لا تحتاج `sudo env ... --allow-sudo` إلا عندما تختار صراحة التثبيت في دليل نظام مثل `/usr/local/bin`، ويوصى حينها باستخدام `--no-modify-path` لتجنب تعديل root لملف profile الخاص بالمستخدم.

### ماذا يحدث إذا كان النظام يحتوي opencode قديما؟

يعتمد سكربت التثبيت على مسار التثبيت الهدف فقط. حتى إذا كان `/usr/local/bin/opencode` يحتوي الإصدار نفسه، فعند تحديد `OPENCODE_INSTALL_DIR="$HOME/.local/bin"` سيظل السكربت يثبت إلى `~/.local/bin/opencode` ولن يوقفه binary قديم موجود في PATH.

---

## المساهمة

اقرأ [دليل المساهمة](./CONTRIBUTING.md) قبل إرسال PR. إذا استخدمت `opencode` في اسم مشروعك، فأوضح في README أن المشروع ليس مشروعا رسميا من فريق OpenCode ولا يرتبط بفريق OpenCode.

---

## المجتمع

**انضم إلى مجتمعنا** [Feishu](https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=738j8655-cd59-4633-a30a-1124e0096789&qr_code=true) | [Discord](https://discord.gg/opencode) | [X.com](https://x.com/opencode)
