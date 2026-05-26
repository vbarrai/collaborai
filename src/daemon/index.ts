import { WebSocket } from "ws"
import { spawn } from "child_process"
import { readFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { BrainMessage, DaemonMessage, Project, AutoAcceptRules } from "../protocol.js"
import { handleDaemonConfigCmd } from "./config-commands.js"

const BRAIN_URL = process.env.BRAIN_URL ?? "ws://localhost:8080"
const SLACK_USER_ID = process.env.SLACK_USER_ID ?? ""
const AUTH_TOKEN = process.env.WS_AUTH_TOKEN ?? "dev-secret"
const CONFIG_PATH = process.env.COLLABORAI_CONFIG ?? join(homedir(), ".collaborai", "daemon.config.json")

if (!SLACK_USER_ID) {
  console.error("SLACK_USER_ID is required")
  process.exit(1)
}

interface DaemonConfig {
  projects: Project[]
  autoAccept: AutoAcceptRules
}

function loadConfig(): DaemonConfig {
  const empty: DaemonConfig = { projects: [], autoAccept: { channels: {} } }

  if (!existsSync(CONFIG_PATH)) {
    console.warn(`[daemon] no config found at ${CONFIG_PATH}, using WORKING_DIR fallback`)
    const fallback = process.env.WORKING_DIR
    if (fallback) return { ...empty, projects: [{ name: "default", path: fallback }] }
    return empty
  }
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8")
    const config = JSON.parse(raw) as Partial<DaemonConfig>
    const result: DaemonConfig = {
      projects: config.projects ?? [],
      autoAccept: config.autoAccept ?? { channels: {} },
    }
    console.log(`[daemon] loaded ${result.projects.length} projects from ${CONFIG_PATH}`)
    return result
  } catch (e) {
    console.error("[daemon] failed to parse config:", e)
    return empty
  }
}

function send(ws: WebSocket, msg: DaemonMessage) {
  ws.send(JSON.stringify(msg))
}

function connect() {
  const ws = new WebSocket(BRAIN_URL)

  ws.on("open", () => {
    console.log(`[daemon] connected to brain at ${BRAIN_URL}`)
    send(ws, { type: "register", slackUserId: SLACK_USER_ID, token: AUTH_TOKEN })
  })

  ws.on("message", (raw) => {
    let msg: BrainMessage
    try {
      msg = JSON.parse(raw.toString()) as BrainMessage
    } catch {
      return
    }

    if (msg.type === "ping") {
      send(ws, { type: "pong" })
      return
    }

    if (msg.type === "list_projects") {
      const { projects, autoAccept } = loadConfig()
      send(ws, { type: "projects", requestId: msg.requestId, projects, autoAccept })
      return
    }

    if (msg.type === "config_cmd") {
      const text = handleDaemonConfigCmd(msg.args)
      send(ws, { type: "config_response", requestId: msg.requestId, text })
      return
    }

    if (msg.type === "task") {
      console.log(`[daemon] task ${msg.taskId} in ${msg.workingDir}: ${msg.prompt}`)
      runClaudeCode(ws, msg.taskId, msg.prompt, msg.workingDir)
    }
  })

  ws.on("close", () => {
    console.log("[daemon] disconnected, reconnecting in 5s...")
    setTimeout(connect, 5000)
  })

  ws.on("error", (err) => {
    console.error("[daemon] ws error:", err.message)
  })
}

function runClaudeCode(ws: WebSocket, taskId: string, prompt: string, workingDir: string) {
  const proc = spawn(
    "claude",
    ["-p", prompt, "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
    { cwd: workingDir, env: { ...process.env } }
  )

  proc.stdout.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter(Boolean)
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as {
          type: string
          message?: { content?: Array<{ type: string; text?: string }> }
          result?: string
        }
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              send(ws, { type: "stream", taskId, chunk: block.text })
            }
          }
        } else if (event.type === "result") {
          if (event.result) send(ws, { type: "stream", taskId, chunk: event.result })
        }
      } catch {
        send(ws, { type: "stream", taskId, chunk: line })
      }
    }
  })

  proc.stderr.on("data", (chunk: Buffer) => {
    console.error("[daemon] claude stderr:", chunk.toString())
  })

  proc.on("close", (code) => {
    if (code === 0) {
      send(ws, { type: "done", taskId })
    } else {
      send(ws, { type: "error", taskId, message: `claude exited with code ${code}` })
    }
  })

  proc.on("error", (err) => {
    send(ws, { type: "error", taskId, message: err.message })
  })
}

connect()
