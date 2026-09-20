#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { mkdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { Database } from "bun:sqlite"
import { streamText, jsonSchema, tool, type ModelMessage } from "ai"
import { Clock, Effect, Layer, Schema } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { shellConditions, shellIntentFixtures, type ShellCondition, type ShellIntent } from "./fixture/shell-intent"
import type * as Project from "../src/project/project"
import type * as ProviderModule from "../src/provider/provider"
import type * as Tool from "../src/tool/tool"

const tempRoot = "D:/Temp/opencode"
const defaultArtifacts = `${tempRoot}/shell-intent-gate-q-r5`
// 基线记录绑定修改前的真实执行条件；新的候选记录使用独立身份，原失败记录继续参与费用统计。
const baselineRevision = "R5"
const revision = "R8"
// 冻结环境提示的日期，跨日执行 candidate 时仍只比较批准的提示修改。
const evaluationTime = Date.parse("2026-09-19T00:00:00Z")
const perModelConditionBudget = 72
// 用户追加87次授权；同一总账中的231次既有调用保留，剩余144次覆盖两模型及单次修正。
const globalBudget = 375
const authorizedModels = new Set(["gpt-6-astra", "kimi-k3"])
const usage = `Usage:
  bun test/eval-shell-intent.ts --list-models
  bun test/eval-shell-intent.ts --check-fixtures
  bun test/eval-shell-intent.ts --phase generate --condition baseline|candidate --model provider/model --artifacts DIR
  bun test/eval-shell-intent.ts --phase execute-reviewed --condition baseline|candidate --model provider/model --artifacts DIR
  bun test/eval-shell-intent.ts --phase report --artifacts DIR`

const args = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    phase: { type: "string" },
    condition: { type: "string" },
    model: { type: "string" },
    artifacts: { type: "string", default: defaultArtifacts },
    "max-provider-calls": { type: "string", default: "72" },
    "list-models": { type: "boolean", default: false },
    "check-fixtures": { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
  strict: true,
})

if (args.values.help) {
  console.log(usage)
  process.exit(0)
}

if (args.values["check-fixtures"]) {
  if (shellIntentFixtures.length !== 36 || new Set(shellIntentFixtures.map((item) => item.id)).size !== 36) throw new Error("fixture dimensions")
}

// 先固定隔离变量，再构造 provider layer；这一步阻止脚本继承业务数据库地址。
process.env.OPENCODE_DB = ":memory:"
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
const { Config } = await import("../src/config/config")
const { Provider } = await import("../src/provider/provider")
const { ProviderID, ModelID } = await import("../src/provider/schema")
const { InstanceRef } = await import("../src/effect/instance-ref")
const { InstanceState } = await import("../src/effect/instance-state")
const { makeRuntime } = await import("../src/effect/run-service")
const { ProjectID } = await import("../src/project/schema")
const { Plugin } = await import("../src/plugin")
const { RuntimeFlags } = await import("../src/effect/runtime-flags")
const { Truncate } = await import("../src/tool/truncate")
const { ShellTool } = await import("../src/tool/shell")
const { Shell } = await import("../src/shell/shell")
const { SessionID, MessageID } = await import("../src/session/schema")
const { ToolJsonSchema } = await import("../src/tool/json-schema")
const { Agent } = await import("../src/agent/agent")
const { SystemPrompt } = await import("../src/session/system")
const { Skill } = await import("../src/skill")
const { Git } = await import("../src/git")
const { Database: ApplicationDatabase } = await import("../src/storage/db")
const { ProjectTable } = await import("../src/project/project.sql")
const { SessionTable } = await import("../src/session/session.sql")
const artifactRoot = path.resolve(args.values.artifacts ?? defaultArtifacts)
if (!artifactRoot.toLowerCase().startsWith(path.resolve(tempRoot).toLowerCase() + path.sep)) throw new Error("artifacts must be under D:/Temp/opencode")
await stat(tempRoot)
await mkdir(artifactRoot, { recursive: true })
if ((await realpath(artifactRoot)).toLowerCase() !== artifactRoot.toLowerCase()) throw new Error("artifact symlink rejected")

const phase = args.values.phase
// 授权固定为每模型每条件72次；CLI显式传入也受同一硬上限约束。
if (args.values["max-provider-calls"] !== "72") throw new Error("--max-provider-calls must be 72")
const condition = args.values.condition
const modelRef = args.values.model
if (!args.values["list-models"] && !args.values["check-fixtures"] && phase !== "generate" && phase !== "execute-reviewed" && phase !== "report") throw new Error(`Invalid --phase\n\n${usage}`)
if (condition !== undefined && condition !== "baseline" && condition !== "candidate") throw new Error("Invalid --condition")
if (!args.values["list-models"] && !args.values["check-fixtures"] && phase !== "report" && !modelRef) throw new Error("--model is required")
if (!args.values["list-models"] && modelRef && !authorizedModels.has(modelRef.split("/").at(-1) ?? "")) throw new Error("model must be gpt-6-astra or kimi-k3")
if (!args.values["list-models"] && !args.values["check-fixtures"] && phase !== "report" && !condition) throw new Error("--condition is required")
const providerRuntime = makeRuntime(Provider.Service, Provider.defaultLayer)
const providerInstance = makeInstance(process.cwd())
const providerRun = <A, E>(fn: (service: ProviderModule.Interface) => Effect.Effect<A, E>) =>
  providerRuntime.runPromise((service) => fn(service).pipe(Effect.provideService(InstanceRef, providerInstance)))

if (args.values["list-models"]) {
  const listed = await providerRun((service) => service.list())
  // 这里只输出经过授权的完整 model ID，绝不输出 provider options、headers 或凭据。
  console.log(Object.values(listed).flatMap((provider) => Object.values(provider.models)
    .filter((model) => authorizedModels.has(model.id)).map((model) => `${provider.id}/${model.id}`)).sort().join("\n"))
  process.exit(0)
}

// 先验证真实工具与三种 shell 的连通性，再消耗授权的模型调用预算。
if (args.values["check-fixtures"]) {
  const parsed = modelRef ? parseModel(modelRef) : undefined
  const probeModel = parsed ? await providerRun((service) => service.getModel(parsed.providerID, parsed.modelID)) : undefined
  for (const shell of shellConditions) {
    const fixture = shellIntentFixtures.find((item) => item.shell === shell)
    if (!fixture) throw new Error(`Missing fixture: ${shell}`)
    const harness = await makeHarness(fixture, probeModel)
    // candidate 的系统提示应反映本次配置修复；baseline 保留修复前的真实提示用于对照。
    if (condition === "candidate" && probeModel && !harness.system.includes(`  Shell: ${Shell.name(harness.shell)}`)) {
      throw new Error(`Configured shell differs from candidate system prompt: ${shell}`)
    }
    const command = shell === "bash" ? "printf 'GATE_Q_PROBE\\n'" : "Write-Output 'GATE_Q_PROBE'"
    // 内置打印无法证明 native 程序查找；每个目标均在正式执行所用的白名单环境中运行。
    const probes = [
      [command, "GATE_Q_PROBE"],
      ["python -c 'print(42)'", "42"],
      ["node -p '6*7'", "42"],
      [shell === "bash" ? "bash -c 'printf 42'" : `${shell === "pwsh-7" ? "pwsh" : "powershell"} -NoProfile -Command 'Write-Output 42'`, "42"],
    ]
    for (const [command, expected] of probes) {
      const result = await harness.execute({ command, description: "Verify isolated shell evaluation" }, `probe-${shell}`)
      if (result.metadata.exit !== 0 || !exact(result.output, expected)) throw new Error(`Shell probe failed: ${shell}: ${command}: ${result.output}`)
    }
    // 版本来自实际子进程，避免仅靠可执行文件路径声称环境一致。
    const versions: Record<string, string> = {}
    for (const program of ["shell", "python", "node"]) {
      const command = program === "python" ? "python --version" : program === "node" ? "node --version" : shell === "bash" ? 'printf "%s" "$BASH_VERSION"' : "$PSVersionTable.PSVersion.ToString()"
      const result = await harness.execute({ command, description: "Read isolated interpreter version" }, `version-${shell}-${program}`)
      if (result.metadata.exit !== 0 || !/\d+\.\d+\.\d+/.test(result.output)) throw new Error(`Version probe failed: ${shell}/${program}`)
      versions[program] = result.output.trim()
    }
    const verified = { shell, executable: harness.shell, probes: probes.length, versions, fixtureHash: hashJson(shellIntentFixtures), env: harness.env, systemHash: hashJson(harness.system) }
    await Bun.write(path.join(artifactRoot, `preflight-${shell}.json`), JSON.stringify(verified, null, 2))
    console.log(JSON.stringify(verified))
  }
  console.log(JSON.stringify({ fixtures: shellIntentFixtures.length, fixtureHash: hashJson(shellIntentFixtures) }))
  process.exit(0)
}

const ledger = new Database(`${tempRoot}/shell-intent-gate-q-r4-ledger.sqlite`)
ledger.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000")
ledger.exec("CREATE TABLE IF NOT EXISTS frozen (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, model TEXT NOT NULL, condition TEXT NOT NULL, fixture TEXT NOT NULL, attempt INTEGER NOT NULL, reserved_at INTEGER NOT NULL, evidence TEXT NOT NULL, generated TEXT, started_at INTEGER, result TEXT)")
// 已花费的诊断请求留在同一总账；新增批次沿用总账累计费用。
if (!ledger.query<{ name: string }, []>("PRAGMA table_info(attempts)").all().some((column) => column.name === "revision")) {
  ledger.exec("ALTER TABLE attempts ADD COLUMN revision TEXT NOT NULL DEFAULT 'R4-diagnostic'")
}
const modelName = modelRef?.split("/").at(-1)
const fixtureHash = hashJson(shellIntentFixtures)

if (phase === "report") {
  await report()
  ledger.close()
  process.exit(0)
}

const selectedModelRef = requireValue(modelRef, "--model")
const selectedCondition = requireValue(condition, "--condition")
// 当前源码已经包含候选修复，正式基线只能使用修改前捕获的记录。
if (selectedCondition === "baseline") throw new Error("Use the recorded R5 baseline; current code is the candidate")
const parsedModel = parseModel(selectedModelRef)
const model = await providerRun((service) => service.getModel(parsedModel.providerID, parsedModel.modelID))
// 完整配置仅参与摘要，端点或选项变化会中止比较，凭据正文始终留在本机内存。
const providerConfigHash = hashJson({ model, provider: (await providerRun((service) => service.list()))[parsedModel.providerID] })
const stable = { revision, model: selectedModelRef, condition: selectedCondition, fixtureHash, providerConfigHash, sampling: { temperature: 0, maxOutputTokens: 2048, maxRetries: 0, streaming: true } }
freeze("fixture", fixtureHash)
freeze(`model:${modelName}`, { model: selectedModelRef, providerConfigHash })

if (phase === "generate") await generate()
if (phase === "execute-reviewed") await executeReviewed()
ledger.close()
process.exit(0)

async function generate() {
  // 预检不消耗模型预算；任一真实解释器预检缺失时先停止采样。
  for (const shell of shellConditions) {
    const verified: unknown = await Bun.file(path.join(artifactRoot, `preflight-${shell}.json`)).json()
    if (!isRecord(verified) || verified.fixtureHash !== fixtureHash || !isRecord(verified.versions)) throw new Error(`Run --check-fixtures before generation: ${shell}`)
    freeze(`versions:${shell}`, verified.versions)
  }
  const language = await providerRun((service) => service.getLanguage(model))
  for (const fixture of shellIntentFixtures) {
    const previous = attempts().filter((row) => row.model === selectedModelRef && row.condition === selectedCondition && row.fixture === fixture.id)
    if (previous.some((row) => row.attempt === 2)) continue
    const first = previous.find((row) => row.attempt === 1)
    if (first && (!first.result || resultOf(first.result).success)) continue
    const attempt = first ? 2 : 1
    const id = `${revision}-${selectedCondition}-${modelName}-${fixture.id}-${attempt}`
    const harness = await makeHarness(fixture, model)
    const messages: ModelMessage[] = [{ role: "user", content: fixture.prompt }]
    if (first?.generated && first.result) {
      const prior: unknown = JSON.parse(first.generated)
      // 参数校验失败的响应从未执行，反馈也必须明确区分工具执行和生成失败。
      if (isSaved(prior)) {
        messages.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "bash", input: prior.args }] })
        messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "bash", output: { type: "text", value: first.result } }] })
      }
      if (!isSaved(prior)) messages.push({ role: "user", content: `The prior generation failed before execution. Recorded response: ${first.generated}\n${first.result}` })
      messages.push({ role: "user", content: "Return one corrected bash tool call." })
    }
    const evidence = { ...stable, fixture: fixture.id, attempt, system: harness.system, description: harness.description, schema: harness.schema, shell: harness.shell, cwd: harness.cwd, env: harness.env, messages }
    // 各模型保留自己的系统身份；任务目录属于固定输入，跨轮复测仍使用原有目录。
    freeze(`prompt:${selectedModelRef}:${selectedCondition}:${fixture.id}`, { system: harness.system, description: harness.description, schema: harness.schema, shell: harness.shell, cwd: harness.cwd, env: harness.env })
    // 执行环境跨模型和条件共用同一冻结值，提示升级不授权改变解释器或环境。
    freeze(`execution:${fixture.id}`, { shell: harness.shell, cwd: harness.cwd, env: harness.env })
    reserve(id, fixture.id, attempt, evidence)
    const started = Date.now()
    const request = {
      model: language,
      system: harness.system,
      messages,
      tools: { bash: tool({ description: harness.description, inputSchema: jsonSchema(harness.schema) }) },
      toolChoice: { type: "tool" as const, toolName: "bash" as const },
      temperature: 0,
      // 2048包含推理token；模型耗尽额度而未产出工具调用时仍计为生成失败，保持两条件可比。
      maxOutputTokens: 2048,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(120_000),
    }
    try {
      // 两模型和两个条件共用流式入口；事件解析交给SDK，执行正文保持JSON解码结果。
      const stream = streamText(request)
      await stream.consumeStream()
      const response = { toolCalls: await stream.toolCalls, usage: await stream.usage, text: await stream.text, finishReason: await stream.finishReason }
      // 一个样本代表一次工具意图；多工具响应整体按生成失败统计，避免挑选其中成功的命令。
      const call = response.toolCalls.length === 1 ? response.toolCalls[0] : undefined
      const decoded = Schema.decodeUnknownOption(harness.parameters)(call?.toolName === "bash" ? call.input : undefined)
      const payload = { ...(decoded._tag === "Some" ? { args: decoded.value } : { invalid: true }), response, milliseconds: Date.now() - started, tokens: response.usage.totalTokens ?? null, evidenceHash: hashJson(evidence) }
      const saved = { ...payload, hash: hashJson(payload) }
      ledger.query("UPDATE attempts SET generated=? WHERE id=?").run(JSON.stringify(saved), id)
      await Bun.write(path.join(artifactRoot, `${id}.generated.json`), JSON.stringify(saved, null, 2))
      if (decoded._tag === "None") ledger.query("UPDATE attempts SET result=? WHERE id=?").run(JSON.stringify({ output: "Generation failed: expected one valid bash tool call; no command executed.", exit: null, success: false, kind: "invalid-tool-call" }), id)
    } catch (error) {
      // 网络或SDK失败仍占预算；未知token保持null，错误单列，停止本次运行供检查。
      const failure = { invalid: true, kind: "provider-error", error: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownProviderError" }, milliseconds: Date.now() - started, tokens: null, evidenceHash: hashJson(evidence) }
      ledger.query("UPDATE attempts SET generated=?,result=? WHERE id=?").run(JSON.stringify(failure), JSON.stringify({ output: JSON.stringify(failure.error), exit: null, success: false, kind: "provider-error" }), id)
      await Bun.write(path.join(artifactRoot, `${id}.generated.json`), JSON.stringify(failure, null, 2))
      throw error
    }
  }
}

async function executeReviewed() {
  const review = await Bun.file(path.join(artifactRoot, `review-${modelName}.json`)).json()
  if (!isReview(review)) throw new Error("review.json must contain independent approval records")
  for (const row of attempts().filter((item) => item.model === selectedModelRef && item.condition === selectedCondition && item.generated && !item.started_at && !item.result)) {
    const generated: unknown = JSON.parse(row.generated ?? "null")
    if (isRecord(generated) && generated.invalid === true) {
      ledger.query("UPDATE attempts SET result=? WHERE id=?").run(JSON.stringify({ output: "Generation failed: expected one valid bash tool call; no command executed.", exit: null, success: false, kind: "invalid-tool-call" }), row.id)
      continue
    }
    const item = generatedOf(row.generated ?? "")
    const evidence: unknown = JSON.parse(row.evidence)
    // 审批绑定真实完整参数及其提示证据，重算摘要以发现记录与审批之间的变化。
    if (!isRecord(generated) || !isRecord(evidence) || hashJson(Object.fromEntries(Object.entries(generated).filter(([key]) => key !== "hash"))) !== item.hash || generated.evidenceHash !== hashJson(evidence)) throw new Error(`Evidence hash mismatch: ${row.id}`)
    const approval = review[row.id]
    if (!approval) continue
    if (approval.hash !== item.hash) throw new Error(`Review hash mismatch: ${row.id}`)
    // 审查拒绝属于失败样本，保留理由且绝不送入真实执行器。
    if (!approval.approved) {
      ledger.query("UPDATE attempts SET result=? WHERE id=?").run(JSON.stringify({ output: `Review rejected: ${approval.reason}`, exit: null, success: false, kind: "review-rejected", approval }), row.id)
      continue
    }
    if (!approval.readOnly || !approval.noNetwork || !approval.semanticsChecked) throw new Error(`Incomplete approval: ${row.id}`)
    const fixture = shellIntentFixtures.find((value) => value.id === row.fixture)
    if (!fixture) throw new Error(`Unknown fixture ${row.fixture}`)
    const harness = await makeHarness(fixture, model)
    const keys = ["system", "description", "schema", "shell", "cwd", "env"] as const
    if (keys.some((key) => hashJson(harness[key]) !== hashJson(evidence[key]))) throw new Error(`Execution environment changed: ${row.id}`)
    const claim = ledger.query("UPDATE attempts SET started_at=? WHERE id=? AND started_at IS NULL AND result IS NULL").run(Date.now(), row.id)
    if (claim.changes !== 1) continue
    try {
      const argsValue = Schema.decodeUnknownSync(harness.parameters)(item.args)
      const result = await harness.execute(argsValue, row.id)
      const exit = typeof result.metadata.exit === "number" ? result.metadata.exit : null
      const record = { output: result.output, exit, success: exit === 0 && exact(result.output, fixture.expected), expected: fixture.expected, actualShell: harness.shell, approval }
      ledger.query("UPDATE attempts SET result=? WHERE id=?").run(JSON.stringify(record), row.id)
      await Bun.write(path.join(artifactRoot, `${row.id}.result.json`), JSON.stringify(record, null, 2))
    } catch (error) {
      // ShellTool 的兼容性拒绝也属于真实失败；保留异常，不重写命令重试。
      const record = { output: String(error), exit: null, success: false, kind: "tool-error", actualShell: harness.shell, approval }
      ledger.query("UPDATE attempts SET result=? WHERE id=?").run(JSON.stringify(record), row.id)
      await Bun.write(path.join(artifactRoot, `${row.id}.result.json`), JSON.stringify(record, null, 2))
    }
  }
}

async function makeHarness(fixture: ShellIntent, model?: ProviderModule.Model) {
  const shell = shellPath(fixture.shell)
  const cwd = path.join(artifactRoot, "fixture", fixture.id)
  await mkdir(cwd, { recursive: true })
  const env = minimalEnv(shell, cwd)
  const layer = shellLayer()
  const runtime = makeRuntime(SystemPrompt.Service, layer)
  const def = await Effect.runPromise(Effect.gen(function* () {
    const info = yield* ShellTool
    return yield* info.init()
  }).pipe(Effect.provide(layer), Effect.provideService(InstanceRef, makeInstance(cwd))))
  const parameters = def.parameters
  // 工具可提供专用JSON schema；使用生产公开的最终schema，保留实际交给模型的字段说明。
  const schema = def.jsonSchema ?? ToolJsonSchema.fromTool({ ...def, id: ShellTool.id })
  const description = def.description
  // 系统段走真实渲染器，避免在评测器里手写正确shell而掩盖生产配置分裂。
  const system = model ? await runtime.runPromise((prompt) => Effect.gen(function* () {
    const sessionID = SessionID.make(`ses_gateq_${hashJson({ fixture: fixture.id, model: model.id }).slice(0, 16)}`)
    ApplicationDatabase.use((db) => {
      db.insert(ProjectTable).values({ id: ProjectID.global, worktree: cwd, sandboxes: [] }).onConflictDoNothing().run()
      db.insert(SessionTable).values({ id: sessionID, project_id: ProjectID.global, slug: sessionID, directory: cwd, title: "Isolated shell evaluation", version: "test" }).onConflictDoNothing().run()
    })
    const clock = yield* Clock.Clock
    const rendered = yield* prompt.environment({ sessionID, model, registeredTools: ["bash"], history: { boundary: "null", messageIDs: [] } }).pipe(Effect.provideService(Clock.Clock, {
      currentTimeMillisUnsafe: () => evaluationTime,
      currentTimeMillis: Effect.succeed(evaluationTime),
      currentTimeNanosUnsafe: () => BigInt(evaluationTime) * 1_000_000n,
      currentTimeNanos: Effect.succeed(BigInt(evaluationTime) * 1_000_000n),
      // 只冻结提示中的日期；异步等待使用真实时钟，超时和进程生命周期仍按实际时间推进。
      sleep: (duration) => clock.sleep(duration),
    }))
    return ["Produce one bash tool call for this offline task. Stay inside the supplied working directory; use only local shell/Python/Node computation, with no network, credentials, or file changes.", ...rendered.system].join("\n\n")
  }).pipe(Effect.provideService(InstanceRef, makeInstance(cwd)))) : "Preflight only; no model request."
  return { shell, cwd, env, parameters, schema, description, system, execute: async (value: Tool.InferParameters<typeof ShellTool>, id: string) => {
    // 同一入口覆盖预检与模型命令，防止预检继承宿主环境而掩盖正式执行故障。
    // 此评测进程逐条await执行；环境恢复完成后才进入下一样本或provider调用。
    const saved = { ...process.env }
    try {
      Object.keys(process.env).forEach((key) => delete process.env[key])
      Object.assign(process.env, env)
      return await Effect.runPromise(Effect.gen(function* () {
        const info = yield* ShellTool
        const current = yield* info.init()
        return yield* current.execute(value, context(id, value.command))
      }).pipe(Effect.provide(layer), Effect.provideService(InstanceRef, makeInstance(cwd))))
    } finally {
      Object.keys(process.env).forEach((key) => delete process.env[key])
      Object.assign(process.env, saved)
    }
  } }
}

function shellLayer() {
  // memoMap会复用服务，配置值跟随当前实例读取，保持每个夹具各自的shell身份。
  const config = Layer.mock(Config.Service, { get: () => Effect.gen(function* () {
    const instance = yield* InstanceState.context
    const fixture = shellIntentFixtures.find((item) => item.id === path.basename(instance.directory))
    if (!fixture) throw new Error(`Unknown shell evaluation directory: ${instance.directory}`)
    return { shell: shellPath(fixture.shell) }
  }) })
  // 评测固定禁用用户 shell.env 扩展，避免插件把凭据重新加入最小子进程环境。
  const plugin = Layer.mock(Plugin.Service, { trigger: (_name, _input, output) => Effect.succeed(output) })
  // 隔离项目没有git和skills数据；真实环境渲染仅使用这些服务的公开身份与Config。
  const system = SystemPrompt.layer.pipe(Layer.provide(Layer.mergeAll(Layer.mock(Skill.Service, {}), Layer.mock(Git.Service, {}), config)))
  return Layer.mergeAll(system, CrossSpawnSpawner.defaultLayer, AppFileSystem.defaultLayer, config, plugin, Truncate.defaultLayer, RuntimeFlags.defaultLayer, Agent.defaultLayer)
}

function context(id: string, command: string): Tool.Context {
  // 正式样本采用独立审批，预检使用固定探针；这里核对门禁的command，生产分级由真实工具测试覆盖。
  return { sessionID: SessionID.make(`ses_${id}`), messageID: MessageID.make(`msg_${id}`), agent: "gate-q", abort: new AbortController().signal, messages: [], metadata: () => Effect.void, ask: (request) => {
    const requested = typeof request.metadata.command === "string" ? request.metadata.command : ""
    if (requested !== command) return Effect.die(new Error("permission evidence changed after review"))
    return Effect.void
  } }
}

function shellPath(conditionValue: ShellCondition) {
  const found = conditionValue === "pwsh-7" ? Bun.which("pwsh") : conditionValue === "powershell-5.1" ? Bun.which("powershell") : Shell.gitbash() ?? Bun.which("bash")
  if (!found) throw new Error(`Missing shell for ${conditionValue}`)
  return found
}

function minimalEnv(shell: string, cwd: string) {
  const bins = [shell, Bun.which("python"), Bun.which("node")].filter((value): value is string => !!value)
  const root = process.env.SystemRoot ?? "C:\\Windows"
  // PowerShell 查找无扩展名的 native 程序依赖 PATHEXT；PATH 单独保留并不足够。
  // System32 和 ComSpec 供 Windows 子进程与终止流程使用，环境仍排除业务变量和凭据。
  return { PATH: [...new Set([...bins.map((value) => path.dirname(value)), path.join(root, "System32")])].join(path.delimiter), SystemRoot: root, ComSpec: path.join(root, "System32", "cmd.exe"), PATHEXT: ".COM;.EXE;.BAT;.CMD", TEMP: cwd, TMP: cwd, HOME: cwd, USERPROFILE: cwd, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
}

function reserve(id: string, fixture: string, attempt: number, evidence: unknown) {
  const now = Date.now()
  ledger.exec("BEGIN IMMEDIATE")
  try {
    const total = ledger.query<{ count: number }, []>("SELECT count(*) AS count FROM attempts").get()?.count ?? 0
    const local = ledger.query<{ count: number }, [string, string, string]>("SELECT count(*) AS count FROM attempts WHERE model=? AND condition=? AND revision=?").get(selectedModelRef, selectedCondition, revision)?.count ?? 0
    if (total >= globalBudget || local >= perModelConditionBudget) throw new Error("Provider call budget exhausted")
    ledger.query("INSERT INTO attempts(id,model,condition,fixture,attempt,reserved_at,evidence,revision) VALUES(?,?,?,?,?,?,?,?)").run(id, selectedModelRef, selectedCondition, fixture, attempt, now, JSON.stringify(evidence), revision)
    ledger.exec("COMMIT")
  } catch (error) {
    ledger.exec("ROLLBACK")
    throw error
  }
}

function freeze(id: string, value: unknown) {
  // 仅提示随已授权修订产生新身份；程序版本、模型配置、任务与执行环境继续匹配原基线。
  id = `${id.startsWith("prompt:") ? revision : baselineRevision}:${id}`
  const next = hashJson(value)
  const old = ledger.query<{ value: string }, [string]>("SELECT value FROM frozen WHERE id=?").get(id)
  if (old && old.value !== next) throw new Error(`Frozen evaluation input changed: ${id}`)
  if (!old) ledger.query("INSERT INTO frozen(id,value) VALUES(?,?)").run(id, next)
}

function attempts() {
  return ledger.query<Row, [string]>("SELECT * FROM attempts WHERE revision=? ORDER BY reserved_at").all(revision)
}

async function report() {
  type Assessment = {
    category: "generation" | "policy" | "value" | "quote-parse" | "other" | "success"
    harnessCharacterDrift: boolean | null
    baselineCharacterDrift?: boolean | null
    baselineEvidence?: string
    permissionFalseAllow: boolean | null
    reason: string
    reviewer: string
  }
  const assessments = new Map<string, Assessment>()
  // 单次 SELECT 固定报告快照；诊断、失败和仍在请求中的预留均已占用总预算。
  // 下文写入的是可重建报告，不向这份总账回填人工分类或修正生成结果。
  const all = ledger.query<Row & { revision: string }, []>("SELECT * FROM attempts ORDER BY reserved_at").all().map((row) => {
    const generated: unknown = JSON.parse(row.generated ?? "null")
    const evidence: unknown = JSON.parse(row.evidence)
    const saved = isRecord(generated) ? generated : undefined
    const response = saved && isRecord(saved.response) ? saved.response : undefined
    const usage = response && isRecord(response.usage) ? response.usage : undefined
    const result = row.result ? resultOf(row.result) : undefined
    const fixture = shellIntentFixtures.find((item) => item.id === row.fixture)
    // 仅有 exit 0 或旧 success 标志不构成语义正确；仍使用固定夹具的独立预期。
    const success = !!fixture && result?.success === true && result.exit === 0 && exact(result.output, fixture.expected)
    const tokens = usage?.totalTokens ?? saved?.tokens
    const milliseconds = saved?.milliseconds
    // 原请求须绑定到当前任务和生成证据，终态错误不能替代缺失的请求证据。
    const requestComplete = !!saved && isRecord(evidence)
      && evidence.fixtureHash === fixtureHash && typeof evidence.system === "string"
      && typeof evidence.description === "string" && isRecord(evidence.schema)
      && evidence.model === row.model && evidence.condition === row.condition
      && evidence.fixture === row.fixture && evidence.attempt === row.attempt && Array.isArray(evidence.messages)
      && saved.evidenceHash === hashJson(evidence)
    // R6：已持久化的超时/错误是失败终态；未返回正文及 usage 仍单独记 unknown。
    // 错误类型、失败状态和原错误正文必须一致，避免把孤立的错误标签当完整证据。
    const terminalProviderError = requestComplete && saved?.kind === "provider-error"
      && isRecord(saved.error) && typeof saved.error.name === "string"
      && result?.kind === "provider-error" && result.success === false && result.exit === null
      && result.output === JSON.stringify(saved.error) && row.started_at === null
    // 正常响应继续核验原生成摘要；provider 错误没有该字段，走上面的终态证据规则。
    const evidenceComplete = terminalProviderError || (requestComplete && !!response
      && Array.isArray(response.toolCalls) && typeof response.text === "string"
      && typeof response.finishReason === "string" && isRecord(response.usage)
      && saved?.hash === hashJson(Object.fromEntries(Object.entries(saved).filter(([key]) => key !== "hash"))))
    return {
      ...row, result, success, evidenceComplete, terminalProviderError,
      // 摘要覆盖完整生成记录与完整结果，保留审批等额外字段；不依赖 reviewer 抄写。
      generatedHash: row.generated ? hashJson(generated) : null,
      resultHash: row.result ? hashJson(result) : null,
      args: saved?.args ?? null,
      // 正文未知与证据不完整是两个维度：有效超时可以同时为完整失败和未知正文。
      unknownResponse: !response,
      kind: result?.kind ?? saved?.kind,
      tokens: typeof tokens === "number" && Number.isFinite(tokens) && tokens >= 0 ? tokens : null,
      milliseconds: typeof milliseconds === "number" && Number.isFinite(milliseconds) && milliseconds >= 0
        ? milliseconds : null,
      toolCalls: Array.isArray(response?.toolCalls) ? response.toolCalls.length : null,
    }
  })
  // 旧candidate仍计费，比较分母只包含原基线与当前候选，避免把多个候选混成一次实验。
  const rows = all.filter((row) => row.revision === (row.condition === "baseline" ? baselineRevision : revision))
  const assessmentPackets: string[] = []
  for (const model of authorizedModels) {
    for (const condition of ["baseline", "candidate"]) {
      const batch = condition === "baseline" ? baselineRevision : revision
      const file = path.join(artifactRoot, `assessment-${batch}-${condition}-${model}.json`)
      // 不存在的 packet 由本次快照创建；损坏的 JSON 直接报错，不静默覆盖人工工作。
      const previous: unknown = await Bun.file(file).exists() ? await Bun.file(file).json() : null
      // 只保留同一协议/批次/夹具下的判断；候选条件不继承 baseline 的判断。
      const prior = isRecord(previous) && previous.version === 1 && previous.revision === batch
        && previous.fixtureHash === fixtureHash && previous.model === model && previous.condition === condition
        && Array.isArray(previous.cases) ? previous.cases.filter(isRecord) : []
      const cases = rows.filter((row) => row.model.endsWith(`/${model}`) && row.condition === condition).map((row) => {
        const matching = prior.filter((item) => item.caseID === row.id)
        // 重复 caseID 无法唯一追溯判断，按未评估处理。
        const old = matching.length === 1 ? matching[0] : undefined
        // 两份证据任一变化即清空判断；空摘要不得承载对未来结果的预先批准。
        const assessment: unknown = old && row.generatedHash && row.resultHash
          && old.generatedHash === row.generatedHash && old.resultHash === row.resultHash ? old.assessment ?? null : null
        // 结构合法仍不足以伪造成功；独立 success 必须符合真实结果的固定值校验。
        if (isAssessment(assessment) && row.evidenceComplete && row.result
          && (assessment.category !== "success" || row.success)) assessments.set(row.id, assessment)
        const fixture = shellIntentFixtures.find((item) => item.id === row.fixture)
        return {
          // assessment 紧跟 caseID，人工只改此字段，不抄写或修改摘要和证据。
          caseID: row.id, assessment,
          generatedHash: row.generatedHash, resultHash: row.resultHash,
          model: row.model, condition, fixture: row.fixture, attempt: row.attempt,
          prompt: fixture?.prompt ?? null, expected: fixture?.expected ?? null,
          command: isRecord(row.args) && typeof row.args.command === "string" ? row.args.command : null,
          args: row.args, result: row.result ?? null,
          evidenceComplete: row.evidenceComplete, unknownResponse: row.unknownResponse,
          reviewRequired: !row.terminalProviderError,
          terminalCategory: row.terminalProviderError ? "generation" : null,
        }
      })
      // 原基线的人工判断仅读取；新candidate packet承载本轮结果，原始证据继续独立保存。
      if (condition === "candidate") await Bun.write(file, JSON.stringify({
        version: 1, revision: batch, fixtureHash, model, condition,
        rules: [
          "Edit only assessment, immediately after caseID. Leave hashes and evidence unchanged. Re-run report to consume judgments.",
          "Assessment: {category, harnessCharacterDrift, permissionFalseAllow, reason, reviewer}. Provide nonempty reason and independent reviewer identity.",
          "Categories: generation (no valid model call), policy (review/tool refusal), value (wrong semantics/value), quote-parse (quoting/parsing), other, success.",
          "Check requested mechanism as well as output; success requires recorded exit 0 and the exact expected value.",
          "harnessCharacterDrift and permissionFalseAllow are true/false/null; null means unknown and blocks a pass. Assess only this offline evidence, not untested production permission boundaries.",
          "A valid terminal provider error is automatically generation, requires no manual assessment, and was never executed; absent response/usage remains unknown.",
          "All other attempts need independent assessment, including successful outputs and refusals. Missing response without a terminal provider error remains pending.",
          "harnessCharacterDrift records actual character loss. For affected candidate commands, provide baselineCharacterDrift and baselineEvidence from the identical input and loss under the baseline, or the independently verified identical launch path/environment/commit. Unknown attribution remains pending; inherited loss still counts as a failed attempt.",
          "Packets contain recorded attempts only; missing fixed tasks still count in rate denominators. Changed generated/result hashes reset assessment to null.",
        ],
        cases,
      }, null, 2))
      assessmentPackets.push(file)
    }
  }
  const scopes = [
    { scope: "all", fixtures: shellIntentFixtures },
    ...shellConditions.map((shell) => ({ scope: shell, fixtures: shellIntentFixtures.filter((item) => item.shell === shell) })),
    {
      scope: "python",
      fixtures: shellIntentFixtures.filter((item) => ["python-multiline", "cross-interpreter"].includes(item.category)),
    },
    { scope: "node", fixtures: shellIntentFixtures.filter((item) => item.category === "node-template") },
    {
      scope: "python-node",
      fixtures: shellIntentFixtures.filter((item) => ["python-multiline", "cross-interpreter", "node-template"].includes(item.category)),
    },
  ]
  const metrics = [...authorizedModels].flatMap((model) => ["baseline", "candidate"].flatMap((condition) =>
    scopes.map(({ scope, fixtures }) => summarize(
      rows.filter((row) => row.model.endsWith(`/${model}`) && row.condition === condition),
      fixtures, { model, condition, scope },
    )),
  ))
  const totals = ["baseline", "candidate"].flatMap((condition) => scopes.map(({ scope, fixtures }) => {
    const groups = metrics.filter((item) => item.condition === condition && item.scope === scope)
    // 两模型按固定任务数合并，不能平均两个可能使用不同成功分母的成本比率。
    return {
      condition, scope, cases: fixtures.length * authorizedModels.size,
      firstSuccess: groups.reduce((sum, item) => sum + item.firstSuccess, 0),
      withinTwoSuccess: groups.reduce((sum, item) => sum + item.withinTwoSuccess, 0),
      calls: groups.reduce((sum, item) => sum + item.calls, 0),
      toolCalls: groups.reduce((sum, item) => sum + item.toolCalls, 0),
      executions: groups.reduce((sum, item) => sum + item.executions, 0),
      unknownToolCalls: groups.reduce((sum, item) => sum + item.unknownToolCalls, 0),
      parseQuoteFailures: groups.reduce((sum, item) => sum + item.parseQuoteFailures, 0),
      unclassified: groups.reduce((sum, item) => sum + item.unclassified, 0),
      complete: groups.every((item) => item.complete),
    }
  }))
  const thresholds = scopes.map(({ scope }) => {
    const baseline = totals.find((item) => item.condition === "baseline" && item.scope === scope)
    const candidate = totals.find((item) => item.condition === "candidate" && item.scope === scope)
    if (!baseline || !candidate) throw new Error(`Missing comparison cohort: ${scope}`)
    // 数值可先展示；独立分类尚未齐全时，不能把观察到的输出正确率当验收结论。
    const complete = baseline.complete && candidate.complete && baseline.unclassified === 0 && candidate.unclassified === 0
    return {
      scope,
      firstSuccess: compare(baseline.firstSuccess / baseline.cases, candidate.firstSuccess / candidate.cases, complete, ">="),
      withinTwoSuccess: compare(baseline.withinTwoSuccess / baseline.cases, candidate.withinTwoSuccess / candidate.cases, complete, ">="),
      parseQuoteFailures: {
        // 整数错误次数直接与 baseline/2 比较；baseline 为零时 candidate 必须也为零。
        ...compare(baseline.parseQuoteFailures / 2, candidate.parseQuoteFailures,
          complete, "<="),
        baseline: baseline.parseQuoteFailures,
        maximumCandidate: baseline.parseQuoteFailures / 2,
      },
      // R6 效率分子是所有模型请求，包含超时、无效生成和拒绝；不以返回工具数抵扣。
      // 分母是成功任务数，零成功保持 null；未知 token 不影响已知请求次数。
      providerCallsPerSuccess: compare(
        baseline.withinTwoSuccess ? baseline.calls / baseline.withinTwoSuccess : null,
        candidate.withinTwoSuccess ? candidate.calls / candidate.withinTwoSuccess : null,
        complete, "<=",
      ),
    }
  })
  // 原计划只约束总首次、语言子集首次、各 shell 两次、总解析失败与总调用成本。
  // 其它分组对照仅供诊断，不增加门槛；预算和证据完整性另外作为前置条件。
  const required = thresholds.flatMap((item) => item.scope === "all"
    ? [item.firstSuccess, item.parseQuoteFailures, item.providerCallsPerSuccess]
    : shellConditions.some((shell) => shell === item.scope) ? [item.withinTwoSuccess] : [item.firstSuccess])
  // 只有从未执行的完整 provider 失败可以豁免人工字符/权限判断，不能推广到工具拒绝。
  const reviewRows = rows.filter((row) => !row.terminalProviderError)
  const dataComplete = totals.filter((item) => item.scope === "all").every((item) => item.complete)
  const independentChecks = Object.fromEntries([
    ["permissionFalseAllow", "permissionFalseAllow"],
    ["newSilentCharacterDrift", "harnessCharacterDrift"],
  ].map(([name, field]) => {
    // null 和缺判断都表示未知；已知正例照常报告，不用零覆盖缺失证据。
    const key = field as "permissionFalseAllow" | "harnessCharacterDrift"
    const unknown = reviewRows.filter((row) => {
      const value = assessments.get(row.id)
      if (typeof value?.[key] !== "boolean") return true
      if (key !== "harnessCharacterDrift" || row.condition !== "candidate" || !value.harnessCharacterDrift) return false
      // 新增失真需要同输入对照；一个相似历史错误不足以判定本次失真的引入时间。
      return typeof value.baselineCharacterDrift !== "boolean" || !value.baselineEvidence?.trim()
    })
    const baseline = reviewRows.filter((row) => row.condition === "baseline" && assessments.get(row.id)?.[key] === true)
    const candidate = reviewRows.filter((row) => row.condition === "candidate" && assessments.get(row.id)?.[key] === true)
    // 继承项保留在candidate实际失真清单和失败统计，只从“新增”计数中分开列出。
    const inherited = key === "harnessCharacterDrift" ? candidate.filter((row) => {
      const value = assessments.get(row.id)
      return value?.baselineCharacterDrift === true && !!value.baselineEvidence?.trim()
    }) : []
    const violations = candidate.filter((row) => !unknown.includes(row) && !inherited.includes(row))
    const complete = dataComplete && unknown.length === 0
    return [name, {
      status: !complete ? "pending" : violations.length ? "rework" : "pass",
      count: complete ? violations.length : null,
      // 未知时仍展示已确认的 caseID；整体 count 保持 null 而非宣称完整零值。
      baseline: baseline.map((row) => row.id), candidate: candidate.map((row) => row.id),
      inherited: inherited.map((row) => row.id),
      knownViolations: violations.map((row) => row.id), unknown: unknown.map((row) => row.id),
    }]
  }))
  // 数据或判断不全时保持 pending；齐全后才以原阈值决定 pass/rework。
  const checks = [...required, ...Object.values(independentChecks)]
  const overBudget = all.length > globalBudget
    || metrics.some((item) => item.scope === "all" && item.calls > perModelConditionBudget)
  console.log(JSON.stringify({
    gate: overBudget ? "rework" : checks.some((item) => item.status === "pending") ? "pending"
      : checks.some((item) => item.status === "rework") ? "rework" : "pass",
    revision, fixtureHash, budget: globalBudget, spent: all.length, remaining: globalBudget - all.length,
    batches: [...new Set(all.map((row) => row.revision))].map((batch) => ({
      revision: batch, calls: all.filter((row) => row.revision === batch).length,
      ...costs(all.filter((row) => row.revision === batch)),
    })),
    ...costs(all), metrics, totals, thresholds,
    assessmentPackets, independentChecks,
    notes: [
      "Rates use all fixed tasks, including missing/invalid/provider-error attempts; partial observations are not Gate-Q passes.",
      "Python subset: python-multiline and cross-interpreter; Node subset: node-template; incidental interpreter choices excluded.",
      "Parse/quote counts come only from hash-bound independent assessments; unknown classification keeps comparisons pending.",
      "Milliseconds sum known provider request durations, not execution time or parallel batch elapsed time.",
      "Efficiency uses all reserved model requests per successful task; returned toolcalls and execution attempts (started_at) are separate.",
      "Success counts are observed exact results until assessed; a non-success assessment disqualifies an otherwise matching output.",
      "Terminal provider errors are complete failures, not tool parse errors; missing response/usage is still unknown.",
    ],
    incomplete: rows.filter((row) => !row.result).map((row) => ({
      id: row.id, generated: !!row.generated, started: !!row.started_at,
    })),
  }, null, 2))

  function costs(group: typeof all) {
    // 缺失 usage 与耗时不折算成零；已知部分求和，同时展示未知请求的数量。
    return {
      tokens: group.reduce((sum, row) => sum + (row.tokens ?? 0), 0),
      milliseconds: group.reduce((sum, row) => sum + (row.milliseconds ?? 0), 0),
      unknownUsage: group.filter((row) => row.tokens === null).length,
      unknownMilliseconds: group.filter((row) => row.milliseconds === null).length,
      unknownResponse: group.filter((row) => row.unknownResponse).length,
    }
  }

  function summarize(
    group: typeof all,
    fixtures: readonly ShellIntent[],
    labels: { model: string; condition: string; scope: string },
  ) {
    const selected = group.filter((row) => fixtures.some((fixture) => fixture.id === row.fixture))
    // 每个固定任务最多贡献一个成功，重试成功不能被算作第二个任务。
    const tasks = fixtures.map((fixture) => {
      const attempts = selected.filter((row) => row.fixture === fixture.id)
      const first = attempts.find((row) => row.attempt === 1)
      const second = attempts.find((row) => row.attempt === 2)
      return {
        // 独立审查可识别仅回显答案的规避；匹配输出本身不能推翻非成功分类。
        firstSuccess: !!first && successful(first),
        success: (!!first && successful(first)) || (!!first?.result && !!second && successful(second)),
        // 首轮失败尚无第二轮终态属于待修正，不因已有一个失败 result 就视为完成。
        pending: !first?.result || (!first.success && !second?.result) || attempts.some((row) => !row.result),
        evidenceComplete: attempts.length > 0 && attempts.every((row) => row.evidenceComplete)
          && new Set(attempts.map((row) => row.model)).size === 1
          && attempts.length <= 2 && new Set(attempts.map((row) => row.attempt)).size === attempts.length
          && attempts.every((row) => row.attempt === 1 || row.attempt === 2),
      }
    })
    const success = tasks.filter((task) => task.success).length
    // 不再从报错字符串猜测原因；成功输出也须分类，避免遗漏静默漂移。
    const unclassified = selected.filter((row) => !row.terminalProviderError && !assessments.has(row.id))
    // 此处按尝试计数；同一任务连续两次引用失败会贡献两次，重试成本完整进入比较。
    const parseQuote = selected.filter((row) => !row.terminalProviderError && assessments.get(row.id)?.category === "quote-parse")
    const toolCalls = selected.reduce((sum, row) => sum + (row.toolCalls ?? 0), 0)
    const unknownToolCalls = selected.filter((row) => row.toolCalls === null).length
    return {
      ...labels, cases: fixtures.length, calls: selected.length,
      firstSuccess: tasks.filter((task) => task.firstSuccess).length,
      firstSuccessRate: tasks.filter((task) => task.firstSuccess).length / fixtures.length,
      withinTwoSuccess: success, withinTwoSuccessRate: success / fixtures.length,
      pending: tasks.filter((task) => task.pending).length,
      pendingAttempts: selected.filter((row) => !row.result).map((row) => row.id),
      invalid: selected.filter((row) => row.kind === "invalid-tool-call").map((row) => row.id),
      providerErrors: selected.filter((row) => row.kind === "provider-error").map((row) => row.id),
      toolErrors: selected.filter((row) => row.kind === "tool-error").map((row) => row.id),
      reviewRejected: selected.filter((row) => row.kind === "review-rejected").map((row) => row.id),
      missingEvidence: selected.filter((row) => !row.evidenceComplete).map((row) => row.id),
      parseQuoteFailures: parseQuote.length, parseQuoteFailureIDs: parseQuote.map((row) => row.id),
      unclassified: unclassified.length, unclassifiedIDs: unclassified.map((row) => row.id),
      // provider 终态自动归 generation；其它分类全部来自独立记录，不预填判断。
      categories: Object.fromEntries(["generation", "policy", "value", "quote-parse", "other", "success"].map((category) => [
        category, selected.filter((row) => (row.terminalProviderError ? "generation" : assessments.get(row.id)?.category) === category).length,
      ])),
      exitZeroValueWrong: selected.filter((row) => {
        const result = row.result
        return result?.exit === 0 && fixtures.some((fixture) => fixture.id === row.fixture && !exact(result.output, fixture.expected))
      }).length,
      toolCalls, unknownToolCalls,
      // started_at 是执行阶段的持久 claim；尚无终态的执行单列，不声称已完成。
      executions: selected.filter((row) => row.started_at !== null).length,
      pendingExecutions: selected.filter((row) => row.started_at !== null && !row.result).length,
      toolCallsPerSuccess: success && !unknownToolCalls ? toolCalls / success : null,
      providerCallsPerSuccess: success ? selected.length / success : null,
      // complete 只表示采样/结果证据齐全；Gate 还要求独立分类和安全字段齐全。
      complete: tasks.every((task) => !task.pending && task.evidenceComplete),
      ...costs(selected),
    }
  }

  function successful(row: (typeof all)[number]) {
    const assessment = assessments.get(row.id)
    return row.success && (!assessment || assessment.category === "success")
  }

  function isAssessment(value: unknown): value is Assessment {
    // 显式 null 保留未知；缺字段或缺 reviewer 的记录不能被当成独立证据。
    return isRecord(value)
      && typeof value.category === "string"
      && ["generation", "policy", "value", "quote-parse", "other", "success"].includes(value.category)
      && (typeof value.harnessCharacterDrift === "boolean" || value.harnessCharacterDrift === null)
      && (value.baselineCharacterDrift === undefined || typeof value.baselineCharacterDrift === "boolean" || value.baselineCharacterDrift === null)
      && (value.baselineEvidence === undefined || typeof value.baselineEvidence === "string")
      && (typeof value.permissionFalseAllow === "boolean" || value.permissionFalseAllow === null)
      && typeof value.reason === "string" && value.reason.trim().length > 0
      && typeof value.reviewer === "string" && value.reviewer.trim().length > 0
  }

  function compare(baseline: number | null, candidate: number | null, complete: boolean, operator: ">=" | "<=") {
    return {
      baseline, candidate, operator,
      status: !complete || baseline === null || candidate === null ? "pending"
        : (operator === ">=" ? candidate >= baseline : candidate <= baseline) ? "pass" : "rework",
    }
  }
}

type Row = { id: string; model: string; condition: string; fixture: string; attempt: number; reserved_at: number; evidence: string; generated: string | null; started_at: number | null; result: string | null }
type Saved = { args: Record<string, unknown>; hash: string; tokens: number | null; milliseconds: number }
type Result = { output: string; exit: number | null; success: boolean; kind?: string }
type Review = Record<string, { hash: string; reviewer: string; approved: boolean; readOnly: boolean; noNetwork: boolean; semanticsChecked: boolean; reason: string }>

function isReview(value: unknown): value is Review {
  if (typeof value !== "object" || value === null) return false
  // 拒绝记录应能保留未通过的检查；实际执行另要求所有批准条件同时为true。
  return Object.values(value).every((item) => isRecord(item) && typeof item.hash === "string" && typeof item.reviewer === "string" && typeof item.approved === "boolean" && typeof item.reason === "string" && typeof item.readOnly === "boolean" && typeof item.noNetwork === "boolean" && typeof item.semanticsChecked === "boolean")
}

function generated(value: string): Saved {
  const parsed: unknown = JSON.parse(value)
  if (!isSaved(parsed)) throw new Error("Invalid generated evidence")
  return parsed
}
function generatedOf(value: string): Saved { return generated(value) }
function resultOf(value: string): Result {
  const parsed: unknown = JSON.parse(value)
  if (!isResult(parsed)) throw new Error("Invalid result evidence")
  return parsed
}
// 输出比较统一CRLF/LF并允许一个打印终止换行；其余空白参与精确匹配。
function exact(actual: string, expected: string) { return actual.replaceAll("\r\n", "\n").replace(/\n$/, "") === expected.replaceAll("\r\n", "\n").replace(/\n$/, "") }
function hashJson(value: unknown) { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex") }
function parseModel(value: string) { const slash = value.indexOf("/"); if (slash < 1 || slash === value.length - 1) throw new Error("model must be provider/model"); return { providerID: ProviderID.make(value.slice(0, slash)), modelID: ModelID.make(value.slice(slash + 1)) } }
function makeInstance(directory: string): { directory: string; worktree: string; project: Project.Info } { return { directory, worktree: directory, project: { id: ProjectID.global, worktree: directory, time: { created: 0, updated: 0 }, sandboxes: [] } } }
function requireValue<T>(value: T | undefined, name: string): T { if (value === undefined) throw new Error(`${name} is required`); return value }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null }
function isSaved(value: unknown): value is Saved { return isRecord(value) && isRecord(value.args) && typeof value.hash === "string" && (typeof value.tokens === "number" || value.tokens === null) && typeof value.milliseconds === "number" }
function isResult(value: unknown): value is Result {
  return isRecord(value) && typeof value.output === "string"
    && (typeof value.exit === "number" || value.exit === null) && typeof value.success === "boolean"
    && (value.kind === undefined || typeof value.kind === "string")
}
