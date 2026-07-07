import type { AutoAcceptRules } from "../protocol.js"

// No-Slack auto-accept: a task is auto-accepted if the requester is explicitly
// listed, or if the list contains the wildcard "*" (anyone holding the token).
export function shouldAutoAcceptRequester(rules: AutoAcceptRules, requesterId: string): boolean {
  const requesters = rules.requesters
  if (!requesters || requesters.length === 0) return false
  return requesters.includes("*") || requesters.includes(requesterId)
}
