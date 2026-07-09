# 评测基线与 Benchmark Harness 设计

## 7.1 为什么必须先建评测，而不是先拼命改

做 agent 项目最危险的一件事，就是你非常容易“觉得它变好了”。  
更聪明的提示词、更复杂的上下文系统、更多的 agent 角色、更多的 hooks，看起来都像进步。但如果没有一套稳定的评测，你其实并不知道：

- 它是不是只是变贵了；
- 它是不是只是把原本一次完成的任务拆成了三次；
- 它是不是因为 compact 更频繁而导致任务成功率反而下降；
- 它是不是虽然答案更像“高级工程师”，但实际返工变多。

所以 benchmark harness 不是锦上添花，而是你整个项目能否健康演进的前提。

## 7.2 评测目标：不是只看 token，也不是只看任务完成

建议把评测分成三层。

### 第一层：任务结果层
- 是否完成任务
- 是否第一次就完成
- 是否引入明显回归
- 是否通过验证步骤
- 是否满足用户约束

### 第二层：过程成本层
- 总输入 token
- 总输出 token
- 总工具输出 token
- compact 次数
- tool budget 减少量
- 子代理数量与成本
- 总回合数

### 第三层：人工返工层
- 用户需要追加澄清的轮次
- 用户需要纠正的次数
- 用户需要自己手改的文件数
- 用户是否需要重置任务/重开新任务

## 7.3 任务集应该如何构建

建议至少构建四类任务集。

### 小修小补集
修一个明确报错、改一个 API 字段名、加一个参数、修一个测试。

### 中型重构集
提取公共逻辑、修改一组相关文件、加一层中间抽象、替换旧接口实现。

### 长任务探索集
用户只给高层目标，需要 explore + plan + build，需要读多个目录与配置，需要运行命令验证。

### 高噪声工具集
大量 grep/read/bash 输出，MCP 返回长文本，日志分析与错误定位。

## 7.4 对比维度设计

建议每条任务跑多组配置：

- 基线组：原始 OpenCode
- 对照组 A：OpenCode + Tool Result Budget
- 对照组 B：OpenCode + Tool Result Budget + Session Memory
- 对照组 C：OpenCode + Tool Result Budget + Session Memory + 角色化路由
- 对照组 D：OpenCode + 全部改造

## 7.5 Harness 需要记录什么

建议每次任务执行结束后记录一份 JSON：

- 任务 id
- 配置
- 模型映射
- 完成情况
- 输入输出 token
- 工具 token
- compact 次数
- tool budget 节省量
- 子代理数量
- follow-up 轮次
- manual corrections

## 7.6 如何衡量“返工也很实惠”

必须新增一个指标：

**Rework Efficiency =（最终完成所需总成本）/（第一次失败后的额外成本）**

如果一个方案第一次经常不完美，但二次修正极其廉价、结构也不乱，那它依然可能是好方案。

## 7.7 实施建议

- 从日志而不是 UI 抓数据
- 统一 replay 能力
- 先求稳定，再求规模

## 7.8 最终建议

benchmark harness 不是后话，而应该与第一批改造同步进行。

最推荐的顺序是：

1. 先给 OpenCode 增加基本 metrics 事件；
2. 再做 Tool Result Budget；
3. 再做 Session Memory；
4. 同时建立小规模 benchmark；
5. 然后用数据决定后续是否继续加 Micro-Compaction、复杂路由与更多 agent 角色。
