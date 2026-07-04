export * as ConfigExperimental from "./experimental"

import { Schema } from "effect"
import { Catalog } from "../catalog"
import { NonNegativeInt } from "../schema"
import { Policy as PolicyV2 } from "../policy"

// Each core domain exports the policy actions it supports. Adding an action to
// this union makes it valid in authored config while keeping Policy generic.
export const PolicyAction = Schema.Union([Catalog.PolicyActions])

export class Policy extends Schema.Class<Policy>("ConfigV2.Experimental.Policy")({
  ...PolicyV2.Info.fields,
  action: PolicyAction,
}) {}

export class Experimental extends Schema.Class<Experimental>("ConfigV2.Experimental")({
  policies: Policy.pipe(Schema.Array, Schema.optional),
  // 两代 runner 使用相同开关与自动续跑上限，默认保持关闭。
  goals: Schema.optional(Schema.Boolean),
  goal_max_turns: Schema.optional(NonNegativeInt),
  // 子代理配置禁令在派生上限后生效，两代不能只在工具展示中隐藏。
  primary_tools: Schema.Array(Schema.String).pipe(Schema.optional),
}) {}
