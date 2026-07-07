import { test } from "node:test"
import assert from "node:assert/strict"
import { AddressInfo } from "net"
import { WebSocket } from "ws"
import { startWsServer } from "./ws-server.js"
import { shouldAutoAcceptRequester } from "../daemon/auto-accept.js"
import type { ServerMessage, DaemonMessage, ServerToClientMessage, ClientMessage, AutoAcceptRules } from "../protocol.js"

const TOKEN = "test-token"

// A scripted daemon that speaks the protocol so we can exercise the server's
// no-Slack flow end to end without the real `claude` CLI. It decides accept/deny
// with the REAL auto-accept helper against the requesterId the server forwards,
// so a wrong requesterId wiring would make these tests fail.
function fakeDaemon(url: string, daemonId: string, rules: AutoAcceptRules): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "register", role: "daemon", daemonId, token: TOKEN } satisfies DaemonMessage))
      resolve(ws)
    })
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage
      if (msg.type === "list_projects") {
        ws.send(JSON.stringify({
          type: "projects",
          requestId: msg.requestId,
          projects: [{ name: "app", path: "/tmp/app" }],
          autoAccept: rules,
        } satisfies DaemonMessage))
      } else if (msg.type === "confirm_request") {
        const accepted = shouldAutoAcceptRequester(rules, msg.requesterId)
        ws.send(JSON.stringify({ type: "confirm_response", taskId: msg.taskId, accepted } satisfies DaemonMessage))
      } else if (msg.type === "task") {
        ws.send(JSON.stringify({ type: "stream", taskId: msg.taskId, chunk: "hello " } satisfies DaemonMessage))
        ws.send(JSON.stringify({ type: "stream", taskId: msg.taskId, chunk: "world" } satisfies DaemonMessage))
        ws.send(JSON.stringify({ type: "done", taskId: msg.taskId } satisfies DaemonMessage))
      }
    })
  })
}

function fakeClient(url: string, clientId: string): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "register", role: "client", clientId, token: TOKEN } satisfies ClientMessage))
      resolve(ws)
    })
  })
}

function collect(ws: WebSocket, until: (m: ServerToClientMessage) => boolean, timeoutMs = 4000): Promise<ServerToClientMessage[]> {
  return new Promise((resolve, reject) => {
    const out: ServerToClientMessage[] = []
    const timer = setTimeout(() => reject(new Error("timeout: " + JSON.stringify(out))), timeoutMs)
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerToClientMessage
      out.push(msg)
      if (until(msg)) {
        clearTimeout(timer)
        resolve(out)
      }
    })
  })
}

const send = (ws: WebSocket, msg: ClientMessage) => ws.send(JSON.stringify(msg))

test("full no-Slack flow: get_projects → task_request → stream → done", async () => {
  const wss = startWsServer(0, TOKEN)
  const port = (wss.address() as AddressInfo).port
  const url = `ws://localhost:${port}`

  // daemon auto-accepts requester "cli-1" specifically — proves requesterId is the
  // registered client identity, not the per-request UUID.
  const daemon = await fakeDaemon(url, "alice", { channels: {}, requesters: ["cli-1"] })
  const client = await fakeClient(url, "cli-1")

  // list_targets
  const targetsP = collect(client, (m) => m.type === "targets")
  send(client, { type: "list_targets", requestId: "r0" })
  const targets = await targetsP
  const targetsMsg = targets.find((m) => m.type === "targets")
  assert.deepEqual(targetsMsg && "daemonIds" in targetsMsg ? targetsMsg.daemonIds : [], ["alice"])

  // get_projects
  const projectsP = collect(client, (m) => m.type === "projects")
  send(client, { type: "get_projects", requestId: "r1", targetDaemonId: "alice" })
  const projectsMsgs = await projectsP
  const projects = projectsMsgs.find((m) => m.type === "projects")
  assert.ok(projects && "projects" in projects && projects.projects[0].name === "app")

  // task_request → expect accepted + stream + done
  const taskP = collect(client, (m) => m.type === "done")
  send(client, { type: "task_request", requestId: "r2", targetDaemonId: "alice", projectName: "app", workingDir: "/tmp/app", prompt: "hi" })
  const events = await taskP

  assert.ok(events.some((m) => m.type === "task_accepted"))
  const streamed = events.filter((m) => m.type === "stream").map((m) => (m as { chunk: string }).chunk).join("")
  assert.equal(streamed, "hello world")
  assert.ok(events.some((m) => m.type === "done"))

  daemon.close()
  client.close()
  wss.close()
})

test("denied task: daemon refuses → client gets task_denied", async () => {
  const wss = startWsServer(0, TOKEN)
  const port = (wss.address() as AddressInfo).port
  const url = `ws://localhost:${port}`

  // daemon only auto-accepts "someone-else", so requester "cli-2" is refused
  // (no TTY in tests → falls through to deny).
  const daemon = await fakeDaemon(url, "bob", { channels: {}, requesters: ["someone-else"] })
  const client = await fakeClient(url, "cli-2")

  const deniedP = collect(client, (m) => m.type === "task_denied")
  send(client, { type: "task_request", requestId: "r3", targetDaemonId: "bob", projectName: "app", workingDir: "/tmp/app", prompt: "hi" })
  const events = await deniedP
  assert.ok(events.some((m) => m.type === "task_denied"))
  assert.ok(!events.some((m) => m.type === "stream"))

  daemon.close()
  client.close()
  wss.close()
})

test("unknown target → request_error", async () => {
  const wss = startWsServer(0, TOKEN)
  const port = (wss.address() as AddressInfo).port
  const url = `ws://localhost:${port}`

  const client = await fakeClient(url, "cli-3")
  const errP = collect(client, (m) => m.type === "request_error")
  send(client, { type: "task_request", requestId: "r4", targetDaemonId: "ghost", projectName: "app", workingDir: "/tmp/app", prompt: "hi" })
  const events = await errP
  assert.ok(events.some((m) => m.type === "request_error"))

  client.close()
  wss.close()
})
