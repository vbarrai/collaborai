import { WebSocketServer, WebSocket } from "ws"
import { register, unregister, getByUserId } from "./registry.js"
import type { DaemonMessage, ServerMessage, Project, AutoAcceptRules } from "../protocol.js"

const AUTH_TOKEN = process.env.WS_AUTH_TOKEN ?? "dev-secret"

const streamingMessages = new Map<string, { channel: string; ts: string; buffer: string }>()

interface ProjectsResponse {
  projects: Project[]
  autoAccept: AutoAcceptRules
}
const pendingProjectRequests = new Map<string, (res: ProjectsResponse) => void>()
const pendingConfigRequests = new Map<string, (text: string) => void>()

type SlackPostFn = (channel: string, text: string, threadTs?: string) => Promise<string>
type SlackUpdateFn = (channel: string, ts: string, text: string) => Promise<void>

export function startWsServer(
  port: number,
  postMessage: SlackPostFn,
  updateMessage: SlackUpdateFn
): WebSocketServer {
  const wss = new WebSocketServer({ port })

  wss.on("connection", (ws) => {
    let userId: string | null = null

    ws.on("message", async (raw) => {
      let msg: DaemonMessage
      try {
        msg = JSON.parse(raw.toString()) as DaemonMessage
      } catch {
        return
      }

      if (msg.type === "register") {
        if (msg.token !== AUTH_TOKEN) {
          ws.close(1008, "invalid token")
          return
        }
        userId = msg.slackUserId
        register(userId, ws)
        return
      }

      if (!userId) {
        ws.close(1008, "not registered")
        return
      }

      if (msg.type === "pong") return

      if (msg.type === "config_response") {
        const resolve = pendingConfigRequests.get(msg.requestId)
        if (resolve) {
          pendingConfigRequests.delete(msg.requestId)
          resolve(msg.text)
        }
        return
      }

      if (msg.type === "projects") {
        const resolve = pendingProjectRequests.get(msg.requestId)
        if (resolve) {
          pendingProjectRequests.delete(msg.requestId)
          resolve({ projects: msg.projects, autoAccept: msg.autoAccept })
        }
        return
      }

      if (msg.type === "stream") {
        const state = streamingMessages.get(msg.taskId)
        if (!state) return
        state.buffer += msg.chunk
        await updateMessage(state.channel, state.ts, `\`\`\`\n${state.buffer}\n\`\`\``)
        return
      }

      if (msg.type === "done") {
        streamingMessages.delete(msg.taskId)
        return
      }

      if (msg.type === "error") {
        const state = streamingMessages.get(msg.taskId)
        if (state) {
          await updateMessage(state.channel, state.ts, `:x: Erreur: ${msg.message}`)
          streamingMessages.delete(msg.taskId)
        }
        return
      }
    })

    ws.on("close", () => {
      if (userId) unregister(ws)
    })
  })

  console.log(`[ws-server] listening on ws://localhost:${port}`)
  return wss
}

export function requestProjects(slackUserId: string, requestId: string): Promise<ProjectsResponse> {
  return new Promise((resolve, reject) => {
    const entry = getByUserId(slackUserId)
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

export async function dispatchTask(
  slackUserId: string,
  taskId: string,
  prompt: string,
  workingDir: string,
  channel: string,
  threadTs: string,
  requesterId: string,
  postMessage: SlackPostFn
): Promise<void> {
  const entry = getByUserId(slackUserId)

  if (!entry) {
    await postMessage(channel, `:warning: <@${slackUserId}> n'a pas de daemon connecté.`, threadTs)
    return
  }

  const placeholderTs = await postMessage(channel, "_Claude Code en cours..._", threadTs)
  streamingMessages.set(taskId, { channel, ts: placeholderTs, buffer: "" })

  const task: ServerMessage = { type: "task", taskId, prompt, workingDir, channel, ts: threadTs, requesterId }
  entry.ws.send(JSON.stringify(task))
}

export function sendDaemonConfigCmd(slackUserId: string, requestId: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const entry = getByUserId(slackUserId)
    if (!entry) { reject(new Error("daemon not connected")); return }

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

export function shouldAutoAccept(rules: AutoAcceptRules, channel: string, senderId: string): boolean {
  const channelRules = rules.channels?.[channel]
  if (!channelRules) return false
  return channelRules.users.includes("*") || channelRules.users.includes(senderId)
}
