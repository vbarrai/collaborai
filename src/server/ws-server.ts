import { WebSocketServer, WebSocket } from "ws"
import { randomUUID } from "crypto"
import { register, unregister, getByUserId, registerClient, listAll } from "./registry.js"
import type {
  DaemonMessage,
  ClientMessage,
  ServerMessage,
  ServerToClientMessage,
  Project,
  AutoAcceptRules,
} from "../protocol.js"
import type { StreamSink } from "./frontend.js"

const AUTH_TOKEN = process.env.WS_AUTH_TOKEN ?? "dev-secret"
const CONFIRM_TIMEOUT_MS = 120_000

// taskId → where to send this task's output (Slack message or CLI relay).
const streamSinks = new Map<string, StreamSink>()

interface ProjectsResponse {
  projects: Project[]
  autoAccept: AutoAcceptRules
}
const pendingProjectRequests = new Map<string, (res: ProjectsResponse) => void>()
const pendingConfigRequests = new Map<string, (text: string) => void>()
const pendingConfirms = new Map<string, (accepted: boolean) => void>()

function sendClient(ws: WebSocket, msg: ServerToClientMessage): void {
  ws.send(JSON.stringify(msg))
}

export function startWsServer(port: number, authToken: string = AUTH_TOKEN): WebSocketServer {
  const wss = new WebSocketServer({ port })

  wss.on("connection", (ws) => {
    let clientId: string | null = null
    let registered = false

    ws.on("message", async (raw) => {
      let msg: (DaemonMessage | ClientMessage) & { role?: string; daemonId?: string; clientId?: string }
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (msg.type === "register") {
        if (msg.token !== authToken) {
          ws.close(1008, "invalid token")
          return
        }
        if (msg.role === "client" && msg.clientId) {
          clientId = msg.clientId
          registerClient(msg.clientId, ws)
          registered = true
        } else if (msg.daemonId) {
          register(msg.daemonId, ws)
          registered = true
        } else {
          ws.close(1008, "invalid registration")
        }
        return
      }

      if (!registered) {
        ws.close(1008, "not registered")
        return
      }

      // Client messages carry no daemon-only fields; route by message type.
      if (msg.type === "list_targets" || msg.type === "get_projects" || msg.type === "task_request") {
        await handleClientMessage(msg as ClientMessage, ws, clientId ?? "unknown")
        return
      }
      await handleDaemonMessage(msg as DaemonMessage)
    })

    ws.on("close", () => unregister(ws))
  })

  console.log(`[ws-server] listening on ws://0.0.0.0:${port}`)
  return wss
}

async function handleDaemonMessage(msg: DaemonMessage): Promise<void> {
  switch (msg.type) {
    case "pong":
      return
    case "config_response": {
      const resolve = pendingConfigRequests.get(msg.requestId)
      if (resolve) {
        pendingConfigRequests.delete(msg.requestId)
        resolve(msg.text)
      }
      return
    }
    case "projects": {
      const resolve = pendingProjectRequests.get(msg.requestId)
      if (resolve) {
        pendingProjectRequests.delete(msg.requestId)
        resolve({ projects: msg.projects, autoAccept: msg.autoAccept })
      }
      return
    }
    case "confirm_response": {
      const resolve = pendingConfirms.get(msg.taskId)
      if (resolve) {
        pendingConfirms.delete(msg.taskId)
        resolve(msg.accepted)
      }
      return
    }
    case "stream": {
      const sink = streamSinks.get(msg.taskId)
      if (sink) await sink.append(msg.chunk)
      return
    }
    case "done": {
      const sink = streamSinks.get(msg.taskId)
      if (sink) {
        await sink.finish()
        streamSinks.delete(msg.taskId)
      }
      return
    }
    case "error": {
      const sink = streamSinks.get(msg.taskId)
      if (sink) {
        await sink.error(msg.message)
        streamSinks.delete(msg.taskId)
      }
      return
    }
  }
}

async function handleClientMessage(msg: ClientMessage, ws: WebSocket, clientId: string): Promise<void> {
  switch (msg.type) {
    case "list_targets":
      sendClient(ws, { type: "targets", requestId: msg.requestId, daemonIds: listAll() })
      return

    case "get_projects": {
      try {
        const res = await requestProjects(msg.targetDaemonId, randomUUID())
        sendClient(ws, { type: "projects", requestId: msg.requestId, projects: res.projects })
      } catch (e) {
        sendClient(ws, { type: "request_error", requestId: msg.requestId, message: (e as Error).message })
      }
      return
    }

    case "task_request": {
      const taskId = randomUUID()
      const target = getByUserId(msg.targetDaemonId)
      if (!target) {
        sendClient(ws, { type: "request_error", requestId: msg.requestId, message: `daemon ${msg.targetDaemonId} non connecté` })
        return
      }

      // The daemon owns the accept/deny decision (auto-accept rules or TTY prompt).
      // requesterId is the registered client identity, so daemon-side auto-accept
      // rules keyed by requester actually match.
      let accepted: boolean
      try {
        accepted = await requestConfirm(msg.targetDaemonId, taskId, msg.prompt, msg.workingDir, clientId)
      } catch (e) {
        sendClient(ws, { type: "request_error", requestId: msg.requestId, message: `confirmation: ${(e as Error).message}` })
        return
      }

      if (!accepted) {
        sendClient(ws, { type: "task_denied", requestId: msg.requestId })
        return
      }

      sendClient(ws, { type: "task_accepted", requestId: msg.requestId, taskId })
      streamSinks.set(taskId, makeRelaySink(ws, taskId))

      const task: ServerMessage = {
        type: "task",
        taskId,
        prompt: msg.prompt,
        workingDir: msg.workingDir,
        requesterId: clientId,
      }
      target.ws.send(JSON.stringify(task))
      return
    }
  }
}

// Relays a daemon's stream/done/error straight to the originating CLI client.
function makeRelaySink(ws: WebSocket, taskId: string): StreamSink {
  return {
    append: async (chunk) => sendClient(ws, { type: "stream", taskId, chunk }),
    finish: async () => sendClient(ws, { type: "done", taskId }),
    error: async (message) => sendClient(ws, { type: "error", taskId, message }),
  }
}

export function requestProjects(daemonId: string, requestId: string): Promise<ProjectsResponse> {
  return new Promise((resolve, reject) => {
    const entry = getByUserId(daemonId)
    if (!entry) {
      reject(new Error("daemon not connected"))
      return
    }

    const timeout = setTimeout(() => {
      pendingProjectRequests.delete(requestId)
      reject(new Error("timeout waiting for project list"))
    }, 5000)

    pendingProjectRequests.set(requestId, (res) => {
      clearTimeout(timeout)
      resolve(res)
    })

    const msg: ServerMessage = { type: "list_projects", requestId }
    entry.ws.send(JSON.stringify(msg))
  })
}

// Asks the target daemon to accept or refuse a task; resolves with its decision.
export function requestConfirm(
  daemonId: string,
  taskId: string,
  prompt: string,
  workingDir: string,
  requesterId: string
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const entry = getByUserId(daemonId)
    if (!entry) {
      reject(new Error("daemon not connected"))
      return
    }

    const timeout = setTimeout(() => {
      pendingConfirms.delete(taskId)
      reject(new Error("timeout waiting for confirmation"))
    }, CONFIRM_TIMEOUT_MS)

    pendingConfirms.set(taskId, (accepted) => {
      clearTimeout(timeout)
      resolve(accepted)
    })

    const msg: ServerMessage = { type: "confirm_request", taskId, prompt, workingDir, requesterId }
    entry.ws.send(JSON.stringify(msg))
  })
}

// Sends a task to a daemon and routes its output into the given sink (Slack mode).
export async function dispatchTask(
  daemonId: string,
  taskId: string,
  prompt: string,
  workingDir: string,
  requesterId: string,
  sink: StreamSink
): Promise<{ ok: boolean; error?: string }> {
  const entry = getByUserId(daemonId)
  if (!entry) return { ok: false, error: "daemon not connected" }

  streamSinks.set(taskId, sink)
  const task: ServerMessage = { type: "task", taskId, prompt, workingDir, requesterId }
  entry.ws.send(JSON.stringify(task))
  return { ok: true }
}

export function sendDaemonConfigCmd(daemonId: string, requestId: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const entry = getByUserId(daemonId)
    if (!entry) {
      reject(new Error("daemon not connected"))
      return
    }

    const timeout = setTimeout(() => {
      pendingConfigRequests.delete(requestId)
      reject(new Error("timeout"))
    }, 10000)

    pendingConfigRequests.set(requestId, (text) => {
      clearTimeout(timeout)
      resolve(text)
    })

    const msg: ServerMessage = { type: "config_cmd", requestId, args }
    entry.ws.send(JSON.stringify(msg))
  })
}

// Slack-mode auto-accept (channel-based). Used by the Slack front-end only.
export function shouldAutoAccept(rules: AutoAcceptRules, channel: string, senderId: string): boolean {
  const channelRules = rules.channels?.[channel]
  if (!channelRules) return false
  return channelRules.users.includes("*") || channelRules.users.includes(senderId)
}
