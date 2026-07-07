import { WebSocket } from "ws"
import { spawn } from "child_process"
import { readFileSync, existsSync } from "fs"
import { homedir, hostname } from "os"
import { join } from "path"
import { createInterface } from "readline"
import type { ServerMessage, DaemonMessage, Project, AutoAcceptRules } from "../protocol.js"
import { handleDaemonConfigCmd } from "./config-commands.js"
import { shouldAutoAcceptRequester } from "./auto-accept.js"

const SERVER_URL = process.env.SERVER_URL ?? "ws://localhost:8080"
const AUTH_TOKEN = process.env.WS_AUTH_TOKEN ?? "dev-secret"
const CONFIG_PATH = process.env.COLLABORAI_CONFIG ?? join(homedir(), ".collaborai", "daemon.config.json")

interface DaemonConfig {
  daemonId?: string
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
      daemonId: config.daemonId,
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

// Identity precedence: config file → DAEMON_ID/SLACK_USER_ID env → hostname.
function resolveDaemonId(config: DaemonConfig): string {
  return (
    config.daemonId ||
    process.env.DAEMON_ID ||
    process.env.SLACK_USER_ID ||
    hostname()
  )
}

const DAEMON_ID = resolveDaemonId(loadConfig())

function send(ws: WebSocket, msg: DaemonMessage) {
  ws.send(JSON.stringify(msg))
}

function askYesNo(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close()
      resolve(/^(o|y|oui|yes)$/i.test(answer.trim()))
    })
  )
}

async function handleConfirm(ws: WebSocket, msg: Extract<ServerMessage, { type: "confirm_request" }>) {
  const { autoAccept } = loadConfig()

  if (shouldAutoAcceptRequester(autoAccept, msg.requesterId)) {
    console.log(`[daemon] auto-accepted task ${msg.taskId} from ${msg.requesterId}`)
    send(ws, { type: "confirm_response", taskId: msg.taskId, accepted: true })
    return
  }

  if (!process.stdin.isTTY) {
    console.warn(`[daemon] no TTY available, refusing task ${msg.taskId} from ${msg.requesterId}`)
    send(ws, { type: "confirm_response", taskId: msg.taskId, accepted: false })
    return
  }

  console.log("\n──────────────────────────────────────────")
  console.log(`Nouvelle demande de : ${msg.requesterId}`)
  console.log(`Projet : ${msg.workingDir}`)
  console.log(`Prompt : ${msg.prompt}`)
  console.log("──────────────────────────────────────────")
  const accepted = await askYesNo("Accepter ? [o/N] ")
  console.log(accepted ? "→ accepté" : "→ refusé")
  send(ws, { type: "confirm_response", taskId: msg.taskId, accepted })
}

function connect() {
  const ws = new WebSocket(SERVER_URL)

  ws.on("open", () => {
    console.log(`[daemon] connected to server at ${SERVER_URL} as "${DAEMON_ID}"`)
    send(ws, { type: "register", role: "daemon", daemonId: DAEMON_ID, token: AUTH_TOKEN })
  })

  ws.on("message", (raw) => {
    let msg: ServerMessage
    try {
      msg = JSON.parse(raw.toString()) as ServerMessage
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

    if (msg.type === "confirm_request") {
      handleConfirm(ws, msg)
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
    console.error("[daemon] ws error:", err.message || err)
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
