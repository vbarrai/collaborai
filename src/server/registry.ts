import type { WebSocket } from "ws"

interface DaemonEntry {
  ws: WebSocket
  slackUserId: string
  connectedAt: Date
}

const registry = new Map<string, DaemonEntry>()
const changeListeners: Array<() => void> = []

export function onRegistryChange(cb: () => void) {
  changeListeners.push(cb)
}

function notifyChange() {
  changeListeners.forEach((cb) => cb())
}

export function register(slackUserId: string, ws: WebSocket): void {
  registry.set(slackUserId, { ws, slackUserId, connectedAt: new Date() })
  console.log(`[registry] registered daemon for ${slackUserId} (total: ${registry.size})`)
  notifyChange()
}

export function unregister(ws: WebSocket): void {
  for (const [userId, entry] of registry) {
    if (entry.ws === ws) {
      registry.delete(userId)
      console.log(`[registry] unregistered daemon for ${userId}`)
      notifyChange()
      return
    }
  }
}

export function getByUserId(slackUserId: string): DaemonEntry | undefined {
  return registry.get(slackUserId)
}

export function listAll(): string[] {
  return [...registry.keys()]
}
