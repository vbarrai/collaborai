import { readFileSync, writeFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { listAll } from "./registry.js"

const STATE_PATH = join(homedir(), ".collaborai", "status-messages.json")

type StatusState = Record<string, string> // channelId → messageTs

function loadState(): StatusState {
  if (!existsSync(STATE_PATH)) return {}
  try { return JSON.parse(readFileSync(STATE_PATH, "utf-8")) } catch { return {} }
}

function saveState(state: StatusState) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

function buildBlocks(): object[] {
  const users = listAll()
  const lines = users.length === 0
    ? "_Aucun Claude Code en ligne_"
    : users.map((u) => `🟢 <@${u}>`).join("\n")

  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Claude Code — en ligne*\n${lines}` },
    },
  ]
}

type PostFn = (channel: string, blocks: object[], text: string) => Promise<string>
type UpdateFn = (channel: string, ts: string, blocks: object[], text: string) => Promise<void>
type PinFn = (channel: string, ts: string) => Promise<void>

let _post: PostFn
let _update: UpdateFn
let _pin: PinFn
let _channels: string[] = []

export function initStatus(channels: string[], post: PostFn, update: UpdateFn, pin: PinFn) {
  _post = post
  _update = update
  _pin = pin
  _channels = channels
}

export async function refreshStatus() {
  if (!_post) return
  const state = loadState()
  const blocks = buildBlocks()
  const text = `Claude Code — en ligne : ${listAll().map((u) => `<@${u}>`).join(", ") || "aucun"}`

  for (const channel of _channels) {
    if (state[channel]) {
      try {
        await _update(channel, state[channel], blocks, text)
        continue
      } catch {
        // message deleted, post new
      }
    }
    const ts = await _post(channel, blocks, text)
    state[channel] = ts
    try { await _pin(channel, ts) } catch { /* ignore */ }
  }

  saveState(state)
}
