import { describe, expect, test } from "bun:test"

const readmes = [
  {
    file: "README.md",
    // 安装标题是用户执行命令前的边界；数据库风险必须落在这个边界之前，才算真正的安装前提示。
    installHeading: "## 快速安装",
    concepts: {
      // 数据库风险提示同时锁定 `opencode.db` 文件名和 schema 语义，避免只写泛泛的“注意数据”而遗漏迁移核心。
      database: [/opencode\.db/i, /数据库[^\n]{0,40}schema|schema[^\n]{0,40}数据库/i],
      // 备份、回退和免责是三个独立承诺；拆开断言能防止后续删掉其中一个风险边界仍然误判通过。
      backup: [/备份/],
      rollback: [/迁移回|回退/, /上游|原分支|主分支/],
      disclaimer: [/不[^\n]{0,20}负责|自行[^\n]{0,20}承担/],
      // compaction 与 voice 都是用户可依赖的能力说明，不要求固定章节，只要求 README 中能被用户发现。
      compaction: [/compaction|上下文[^\n]{0,20}压缩|压缩[^\n]{0,20}上下文/i, /优化|改进|更稳|非同步|异步/],
      voice: [/voice|语音|录音/i, /转录|transcri/i],
      // MCP 入口需要同时说明外部项目和核心能力，避免只贴链接却没有解释为什么要安装它。
      mcp: [/chatgpt-browser-agent-smark/i, /ChatGPT[^\n]{0,20}ask|ask[^\n]{0,20}ChatGPT/i, /图片生成|image generation/i],
    },
  },
  {
    file: "docs/readme/README.en.md",
    // 三语种 README 结构保持一致，所以每份文档都用本地化安装标题切分“安装前”区域。
    installHeading: "## Quick Install",
    concepts: {
      // 英文版允许自然表达 `database schema` 或 `schema ... database`，避免把翻译锁死成单一句子。
      database: [/opencode\.db/i, /database[^\n]{0,40}schema|schema[^\n]{0,40}database/i],
      backup: [/backup/i],
      rollback: [/migrate[^\n]{0,40}back|roll[^\n]{0,20}back/i, /upstream|original branch|main branch/i],
      disclaimer: [/not[^\n]{0,40}responsible|own risk/i],
      compaction: [/compaction|compact[^\n]{0,20}context/i, /optimized|improved|more robust|asynchronous/i],
      voice: [/voice|speech|audio/i, /transcription|transcribe/i],
      mcp: [/chatgpt-browser-agent-smark/i, /ChatGPT[^\n]{0,20}ask|ask[^\n]{0,20}ChatGPT/i, /image generation/i],
    },
  },
  {
    file: "docs/readme/README.zht.md",
    // 繁中 README 是用户入口之一，不能只让简中/英文满足风险提示和可选 MCP 说明。
    installHeading: "## 快速安裝",
    concepts: {
      // 繁中断言覆盖“資料庫”与英文 `schema` 混排，这是当前 README 的既有术语风格。
      database: [/opencode\.db/i, /資料庫[^\n]{0,40}schema|schema[^\n]{0,40}資料庫/i],
      backup: [/備份/],
      rollback: [/遷移回|回退/, /上游|原分支|主分支/],
      disclaimer: [/不[^\n]{0,20}負責|自行[^\n]{0,20}承擔/],
      compaction: [/compaction|上下文[^\n]{0,20}壓縮|壓縮[^\n]{0,20}上下文/i, /優化|改進|更穩|非同步/],
      voice: [/voice|語音|錄音/i, /轉錄|transcri/i],
      mcp: [/chatgpt-browser-agent-smark/i, /ChatGPT[^\n]{0,20}ask|ask[^\n]{0,20}ChatGPT/i, /圖片生成|image generation/i],
    },
  },
]

describe("README branch onboarding", () => {
  for (const readme of readmes) {
    test(`${readme.file} warns before installation about database migration risk`, async () => {
      const content = await readReadme(readme.file)
      const installHeading = content.indexOf(readme.installHeading)

      // README 是用户安装前唯一会先看到的界面；风险提示必须在安装命令之前，避免用户先迁移数据库后才看到回退限制。
      expect(installHeading).toBeGreaterThan(0)
      const beforeInstall = content.slice(0, installHeading)
      expectConcept(beforeInstall, readme.concepts.database)
      expectConcept(beforeInstall, readme.concepts.backup)
      expectConcept(beforeInstall, readme.concepts.rollback)
      expectConcept(beforeInstall, readme.concepts.disclaimer)
    })

    test(`${readme.file} describes the session features users can rely on`, async () => {
      const content = await readReadme(readme.file)

      // 这里验证的是用户可发现的能力，而不是 README 的章节名或表格形状；后续重排文档时这些能力承诺仍应保留。
      expectConcept(content, readme.concepts.compaction)
      expectConcept(content, readme.concepts.voice)
    })

    test(`${readme.file} points optional MCP users to ChatGPT browser capabilities`, async () => {
      const content = await readReadme(readme.file)
      const mcpParagraph = paragraphContaining(content, "https://github.com/SMARK2022/chatgpt-browser-agent-smark")

      // MCP 是可选增强入口，测试只约束用户能从 README 找到桥接项目和核心能力，不限制具体小节位置。
      expect(mcpParagraph).toBeTruthy()
      expectConcept(mcpParagraph, readme.concepts.mcp)
      expectConcept(mcpParagraph, readme.concepts.voice)
    })
  }
})

async function readReadme(file: string) {
  // 测试文件位于 packages/opencode/test/docs；相对 repo root 读取可避免依赖当前 shell 的启动目录。
  return Bun.file(new URL(`../../../../${file}`, import.meta.url)).text()
}

function expectConcept(content: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    // 每个正则代表一个用户语义概念，而不是固定句子；这样翻译措辞可调整，但关键承诺不能消失。
    expect(content).toMatch(pattern)
  }
}

function paragraphContaining(content: string, text: string) {
  // README 可能使用 LF 或 CRLF；按空行切段能约束同一用户可读段落，同时不绑定标题层级或表格位置。
  return content.split(/\r?\n\r?\n/).find((paragraph) => paragraph.includes(text)) ?? ""
}
