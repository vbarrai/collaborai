import type { WebSocket } from "ws"

interface DaemonEntry {
  ws: WebSocket
  daemonId: string
  connectedAt: Date
}

interface ClientEntry {
  ws: WebSocket
  clientId: string
  connectedAt: Date
}

// Online daemons — the authority on which machines can execute tasks.
const registry = new Map<string, DaemonEntry>()
// Connected CLI clients — used to relay streams back to the requester.
const clients = new Map<string, ClientEntry>()
const changeListeners: Array<() => void> = []

export function onRegistryChange(cb: () => void) {
  changeListeners.push(cb)
}

function notifyChange() {
  changeListeners.forEach((cb) => cb())
}

export function register(daemonId: string, ws: WebSocket): void {
  registry.set(daemonId, { ws, daemonId, connectedAt: new Date() })
  console.log(`[registry] registered daemon for ${daemonId} (total: ${registry.size})`)
  notifyChange()
}

export function registerClient(clientId: string, ws: WebSocket): void {
  clients.set(clientId, { ws, clientId, connectedAt: new Date() })
  console.log(`[registry] registered client ${clientId} (total clients: ${clients.size})`)
}

// Removes whichever peer (daemon or client) owns this socket.
export function unregister(ws: WebSocket): void {
  for (const [daemonId, entry] of registry) {
    if (entry.ws === ws) {
      registry.delete(daemonId)
      console.log(`[registry] unregistered daemon for ${daemonId}`)
      notifyChange()
      return
    }
  }
  for (const [clientId, entry] of clients) {
    if (entry.ws === ws) {
      clients.delete(clientId)
      console.log(`[registry] unregistered client ${clientId}`)
      return
    }
  }
}

export function getByUserId(daemonId: string): DaemonEntry | undefined {
  return registry.get(daemonId)
}

export function getClient(clientId: string): ClientEntry | undefined {
  return clients.get(clientId)
}

export function listAll(): string[] {
  return [...registry.keys()]
}
