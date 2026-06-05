import { WebSocket } from "ws"
import { randomUUID } from "crypto"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { createInterface } from "readline"
import { COLLABORAI_HOME, loadSecretsFile, writeSecretsFile } from "../server/secrets.js"
import type { ClientMessage, ServerToClientMessage, Project } from "../protocol.js"

const CLIENT_CONFIG_PATH = join(COLLABORAI_HOME, "client.json")

interface ClientConfig {
  serverUrl: string
  clientId: string
}

function loadClientConfig(): ClientConfig | null {
  if (!existsSync(CLIENT_CONFIG_PATH)) return null
  try {
    return JSON.parse(readFileSync(CLIENT_CONFIG_PATH, "utf-8")) as ClientConfig
  } catch {
    return null
  }
}

function saveClientConfig(config: ClientConfig): void {
  mkdirSync(dirname(CLIENT_CONFIG_PATH), { recursive: true })
  writeFileSync(CLIENT_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n")
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a.trim()) }))
}

async function runWizard(): Promise<{ config: ClientConfig; token: string }> {
  console.log("\n— Configuration du client CollaborAI —")
  const serverUrl = (await prompt("URL du serveur (ws://… ou wss://…) : ")) || "ws://localhost:8080"
  const clientId = (await prompt("Votre identifiant (ex. alice) : ")) || "client"
  const token = await prompt("WS_AUTH_TOKEN : ")

  const config: ClientConfig = { serverUrl, clientId }
  saveClientConfig(config)

  const secrets = loadSecretsFile()
  if (token) writeSecretsFile({ ...secrets, wsAuthToken: token })
  console.log(`✔ Configuration enregistrée dans ${CLIENT_CONFIG_PATH}\n`)
  return { config, token: token || secrets.wsAuthToken || "" }
}

function resolveToken(): string {
  return process.env.WS_AUTH_TOKEN ?? loadSecretsFile().wsAuthToken ?? "dev-secret"
}

interface Connection {
  ws: WebSocket
  send: (msg: ClientMessage) => void
  on: (handler: (msg: ServerToClientMessage) => void) => void
}

function connect(config: ClientConfig, token: string): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(config.serverUrl)
    const handlers: Array<(msg: ServerToClientMessage) => void> = []

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "register", role: "client", clientId: config.clientId, token } satisfies ClientMessage))
      resolve({
        ws,
        send: (msg) => ws.send(JSON.stringify(msg)),
        on: (handler) => handlers.push(handler),
      })
    })
    ws.on("message", (raw) => {
      let msg: ServerToClientMessage
      try { msg = JSON.parse(raw.toString()) } catch { return }
      handlers.forEach((h) => h(msg))
    })
    ws.on("error", (err) => reject(err))
  })
}

function once<T>(timeoutMs: number): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
    setTimeout(() => rej(new Error("timeout")), timeoutMs)
  })
  return { promise, resolve, reject }
}

async function cmdWho(config: ClientConfig, token: string) {
  const conn = await connect(config, token)
  const requestId = randomUUID()
  const waiter = once<string[]>(5000)
  conn.on((msg) => {
    if (msg.type === "targets" && msg.requestId === requestId) waiter.resolve(msg.daemonIds)
  })
  conn.send({ type: "list_targets", requestId })
  const daemonIds = await waiter.promise
  console.log(daemonIds.length ? "Daemons en ligne :\n" + daemonIds.map((d) => `  • ${d}`).join("\n") : "Aucun daemon en ligne.")
  conn.ws.close()
}

async function cmdAsk(config: ClientConfig, token: string, target: string, projectFlag: string | undefined, promptText: string) {
  const conn = await connect(config, token)

  // 1. fetch projects
  const reqProjects = randomUUID()
  const projWaiter = once<Project[]>(6000)
  conn.on((msg) => {
    if (msg.type === "projects" && msg.requestId === reqProjects) projWaiter.resolve(msg.projects)
    if (msg.type === "request_error" && msg.requestId === reqProjects) projWaiter.reject(new Error(msg.message))
  })
  conn.send({ type: "get_projects", requestId: reqProjects, targetDaemonId: target })
  const projects = await projWaiter.promise

  if (projects.length === 0) {
    console.error(`${target} n'a aucun projet configuré.`)
    conn.ws.close()
    process.exitCode = 1
    return
  }

  // 2. pick a project
  let project: Project | undefined
  if (projectFlag) project = projects.find((p) => p.name.toLowerCase() === projectFlag.toLowerCase())
  else if (projects.length === 1) project = projects[0]
  else if (process.stdin.isTTY) {
    console.log("Projets disponibles :")
    projects.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} (${p.path})`))
    const choice = Number(await prompt("Numéro du projet : "))
    project = projects[choice - 1]
  }
  if (!project) {
    console.error(`Projet introuvable. Utilisez --project parmi : ${projects.map((p) => p.name).join(", ")}`)
    conn.ws.close()
    process.exitCode = 1
    return
  }

  // 3. submit and stream
  const reqTask = randomUUID()
  const done = once<void>(10 * 60 * 1000)
  conn.on((msg) => {
    if (msg.type === "task_accepted" && msg.requestId === reqTask) console.error(`✔ Accepté (task ${msg.taskId})\n`)
    if (msg.type === "task_denied" && msg.requestId === reqTask) { console.error("✖ Demande refusée."); process.exitCode = 1; done.resolve() }
    if (msg.type === "request_error" && msg.requestId === reqTask) { console.error(`✖ ${msg.message}`); process.exitCode = 1; done.resolve() }
    if (msg.type === "stream") process.stdout.write(msg.chunk)
    if (msg.type === "done") { process.stdout.write("\n"); done.resolve() }
    if (msg.type === "error") { console.error(`\n✖ Erreur: ${msg.message}`); process.exitCode = 1; done.resolve() }
  })
  console.error(`Envoi à ${target} (projet ${project.name})…`)
  conn.send({ type: "task_request", requestId: reqTask, targetDaemonId: target, projectName: project.name, workingDir: project.path, prompt: promptText })
  await done.promise
  conn.ws.close()
}

function usage() {
  console.log(`Usage:
  collaborai who                                  liste les daemons en ligne
  collaborai ask <daemonId> [--project <nom>] <prompt>
  collaborai login                                (re)configure le client`)
}

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]

  if (command === "login") {
    await runWizard()
    return
  }

  let config = loadClientConfig()
  let token = resolveToken()
  if (!config) {
    if (!process.stdin.isTTY) {
      console.error("Client non configuré. Lancez `collaborai login` (terminal interactif requis).")
      process.exit(1)
    }
    const res = await runWizard()
    config = res.config
    token = res.token || resolveToken()
  }

  if (command === "who") {
    await cmdWho(config, token)
    return
  }

  if (command === "ask") {
    const rest = argv.slice(1)
    const target = rest.shift()
    if (!target) { usage(); process.exit(1) }
    let projectFlag: string | undefined
    const promptParts: string[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--project") { projectFlag = rest[++i] } else promptParts.push(rest[i])
    }
    const promptText = promptParts.join(" ")
    if (!promptText) { console.error("Prompt manquant."); process.exit(1) }
    await cmdAsk(config, token, target!, projectFlag, promptText)
    return
  }

  usage()
}

main().catch((e) => {
  console.error("[client] erreur:", e.message || e)
  process.exit(1)
})
