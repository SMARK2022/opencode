import { Wildcard } from "@/util/wildcard"

type Rule = {
  permission: string
  pattern: string
  // `auto` participates in the same last-match-wins evaluator as allow/ask/deny;
  // the Permission service decides later whether precheck, reviewer, or user
  // approval handles the matching request.
  action: "allow" | "deny" | "ask" | "auto"
}

export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const rules = rulesets.flat()
  const match = rules.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}
