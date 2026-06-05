import { App } from "@slack/bolt"
import { randomUUID } from "crypto"
import { readFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { startWsServer, dispatchTask, requestProjects, shouldAutoAccept, sendDaemonConfigCmd } from "./ws-server.js"
import { listAll, onRegistryChange } from "./registry.js"
import { initStatus, refreshStatus } from "./status.js"
import { handleConfigCommand } from "./config-commands.js"
import { registerHomeHandlers } from "./home-tab.js"
import { openDaemonModal, registerDaemonModalHandlers } from "./daemon-modal.js"
import { loadServerSecrets } from "./secrets.js"
import type { StreamSink } from "./frontend.js"
import type { Project, AutoAcceptRules } from "../protocol.js"

const SLACK_MODE = process.argv.includes("--slack")
const WS_PORT = Number(process.env.WS_PORT ?? 8080)

async function main() {
  const secrets = await loadServerSecrets({ slack: SLACK_MODE })
  if (secrets.wsAuthToken) process.env.WS_AUTH_TOKEN = secrets.wsAuthToken
  const authToken = secrets.wsAuthToken ?? process.env.WS_AUTH_TOKEN ?? "dev-secret"

  if (!SLACK_MODE) {
    startWsServer(WS_PORT, authToken)
    console.log("[server] running in no-Slack mode — waiting for daemons and CLI clients")
    return
  }

  if (!secrets.slackBotToken || !secrets.slackAppToken) {
    console.error("[server] --slack requires SLACK_BOT_TOKEN and SLACK_APP_TOKEN (env or ~/.collaborai/secrets.json)")
    process.exit(1)
  }

  await runSlack(secrets.slackBotToken, secrets.slackAppToken, authToken)
}

async function runSlack(botToken: string, appToken: string, authToken: string) {
  const CONFIG_PATH = process.env.SERVER_CONFIG ?? join(homedir(), ".collaborai", "server.config.json")
  interface ChannelConfig { allowedSenders: string[] }
  interface ServerConfig { channels: Record<string, ChannelConfig> }
  const serverConfig: ServerConfig = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
    : { channels: {} }

  const app = new App({ token: botToken, appToken, socketMode: true })

  // Waiting for project selection (requester picks project)
  interface PendingTask {
    targetUserId: string
    prompt: string
    channel: string
    ts: string
    requesterId: string
    projects: Project[]
    autoAccept: AutoAcceptRules
    selectedIndex: number
  }
  const pendingTasks = new Map<string, PendingTask>()

  interface PendingConfirmation {
    targetUserId: string
    prompt: string
    workingDir: string
    channel: string
    ts: string
    requesterId: string
  }
  const pendingConfirmations = new Map<string, PendingConfirmation>()

  async function postMessage(channel: string, text: string, threadTs?: string): Promise<string> {
    const res = await app.client.chat.postMessage({
      channel,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    })
    return res.ts as string
  }

  async function updateMessage(channel: string, ts: string, text: string): Promise<void> {
    await app.client.chat.update({ channel, ts, text })
  }

  // Posts a placeholder and routes the task's output into the Slack message.
  async function dispatchSlack(
    daemonId: string,
    taskId: string,
    prompt: string,
    workingDir: string,
    channel: string,
    threadTs: string,
    requesterId: string
  ) {
    const placeholderTs = await postMessage(channel, "_Claude Code en cours..._", threadTs)
    let buffer = ""
    const sink: StreamSink = {
      append: async (chunk) => {
        buffer += chunk
        await updateMessage(channel, placeholderTs, `\`\`\`\n${buffer}\n\`\`\``)
      },
      finish: async () => {},
      error: async (message) => {
        await updateMessage(channel, placeholderTs, `:x: Erreur: ${message}`)
      },
    }
    const res = await dispatchTask(daemonId, taskId, prompt, workingDir, requesterId, sink)
    if (!res.ok) await updateMessage(channel, placeholderTs, `:warning: ${res.error}`)
  }

  startWsServer(WS_PORT, authToken)

  const onServerConfigChange = () => {
    if (existsSync(CONFIG_PATH)) {
      Object.assign(serverConfig, JSON.parse(readFileSync(CONFIG_PATH, "utf-8")))
    }
  }

  registerHomeHandlers(app, onServerConfigChange, (triggerId, userId, client) =>
    openDaemonModal(client, triggerId, userId, requestProjects)
  )

  registerDaemonModalHandlers(app, requestProjects, sendDaemonConfigCmd)

  const allowedChannels = Object.keys(serverConfig.channels)

  initStatus(
    allowedChannels,
    (channel, blocks, text) => app.client.chat.postMessage({ channel, blocks: blocks as any, text }).then((r) => r.ts as string),
    (channel, ts, blocks, text) => app.client.chat.update({ channel, ts, blocks: blocks as any, text }).then(() => {}),
    (channel, timestamp) => app.client.pins.add({ channel, timestamp }).then(() => {})
  )

  onRegistryChange(() => { refreshStatus().catch(console.error) })

  async function resolveProject(
    taskId: string,
    targetUserId: string,
    prompt: string,
    workingDir: string,
    channel: string,
    ts: string,
    requesterId: string,
    autoAccept: AutoAcceptRules
  ) {
    if (shouldAutoAccept(autoAccept, channel, requesterId)) {
      await dispatchSlack(targetUserId, taskId, prompt, workingDir, channel, ts, requesterId)
      return
    }

    pendingConfirmations.set(taskId, { targetUserId, prompt, workingDir, channel, ts, requesterId })

    await app.client.chat.postMessage({
      channel,
      thread_ts: ts,
      text: `<@${targetUserId}>, nouvelle demande de <@${requesterId}>`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `<@${targetUserId}>, *<@${requesterId}> te demande :*\n${prompt}\n_Projet : ${workingDir}_`,
          },
        },
        {
          type: "actions",
          elements: [
            { type: "button", action_id: "accept_task", text: { type: "plain_text", text: "✅ Accepter" }, style: "primary", value: taskId },
            { type: "button", action_id: "deny_task", text: { type: "plain_text", text: "❌ Refuser" }, style: "danger", value: taskId },
          ],
        },
      ] as any,
    })
  }

  async function handleMention(text: string, channel: string, ts: string, requesterId: string, botUserId: string) {
    const clean = text.replace(/<@[A-Z0-9]+>/g, "").trim()

    if (clean.toLowerCase().startsWith("config")) {
      const rest = clean.slice(6).trim()
      const mentionRegex = /<@(U[A-Z0-9]+)>/g
      const mentioned = [...text.matchAll(mentionRegex)].map((m) => m[1]).filter((id) => id !== botUserId)
      const connectedUsers = listAll()
      const daemonTarget = mentioned.find((u) => connectedUsers.includes(u))

      if (daemonTarget) {
        const args = rest.replace(/<@[A-Z0-9]+>/g, "").trim().split(/\s+/).filter(Boolean)
        try {
          const reply = await sendDaemonConfigCmd(daemonTarget, randomUUID(), args)
          await postMessage(channel, reply, ts)
        } catch (e) {
          await postMessage(channel, `:x: Impossible de joindre le daemon de <@${daemonTarget}> : ${(e as Error).message}`, ts)
        }
      } else {
        const { text: reply } = handleConfigCommand(rest)
        Object.assign(serverConfig, existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) : { channels: {} })
        await postMessage(channel, reply, ts)
      }
      return
    }

    const channelConfig = serverConfig.channels[channel]
    if (!channelConfig) return
    if (channelConfig.allowedSenders.length > 0 && !channelConfig.allowedSenders.includes(requesterId)) return

    const mentionRegex = /<@(U[A-Z0-9]+)>/g
    const mentions = [...text.matchAll(mentionRegex)].map((m) => m[1]).filter((id) => id !== botUserId)
    const connectedUsers = listAll()

    for (const userId of mentions) {
      if (!connectedUsers.includes(userId)) continue

      const prompt = clean
      const requestId = randomUUID()

      let projects: Project[]
      let autoAccept: AutoAcceptRules
      try {
        const res = await requestProjects(userId, requestId)
        projects = res.projects
        autoAccept = res.autoAccept
      } catch (e) {
        await postMessage(channel, `:warning: Impossible de récupérer les projets de <@${userId}> : ${(e as Error).message}`, ts)
        continue
      }

      if (projects.length === 0) {
        await postMessage(channel, `:warning: <@${userId}> n'a aucun projet configuré dans \`~/.collaborai/config.json\`.`, ts)
        continue
      }

      const matched = projects.find((p) => prompt.toLowerCase().includes(p.name.toLowerCase()))
      if (matched) {
        await resolveProject(randomUUID(), userId, prompt, matched.path, channel, ts, requesterId, autoAccept)
        continue
      }

      const taskId = randomUUID()
      pendingTasks.set(taskId, { targetUserId: userId, prompt, channel, ts, requesterId, projects, autoAccept, selectedIndex: 0 })

      await app.client.chat.postMessage({
        channel,
        thread_ts: ts,
        text: `Choisissez un projet pour <@${userId}>`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*<@${requesterId}> demande à <@${userId}> :*\n${prompt}` } },
          {
            type: "actions",
            block_id: `project_select_${taskId}`,
            elements: [
              {
                type: "static_select",
                action_id: "select_project",
                placeholder: { type: "plain_text", text: "Choisir un projet" },
                initial_option: { text: { type: "plain_text", text: projects[0].name }, value: "0" },
                options: projects.map((p, i) => ({ text: { type: "plain_text", text: p.name }, value: String(i) })),
              },
              { type: "button", action_id: "launch_task", text: { type: "plain_text", text: "Lancer" }, style: "primary", value: taskId },
            ],
          },
        ],
      })
    }
  }

  app.event("app_mention", async ({ event, client }) => {
    const botUserId = (await client.auth.test()).user_id as string
    await handleMention(event.text, event.channel, event.ts, event.user ?? "", botUserId)
  })

  app.message(async ({ message, client }) => {
    if (message.subtype || !("text" in message) || !message.text) return
    const botUserId = (await client.auth.test()).user_id as string
    await handleMention(message.text, message.channel, message.ts, message.user ?? "", botUserId)
  })

  app.action("select_project", async ({ action, body, ack }) => {
    await ack()
    const blockId = (body as any).actions[0].block_id
    const taskId = blockId.replace("project_select_", "")
    const task = pendingTasks.get(taskId)
    if (!task) return
    task.selectedIndex = Number((action as { selected_option?: { value: string } }).selected_option?.value ?? 0)
  })

  app.action("launch_task", async ({ action, body, ack, client }) => {
    await ack()
    const taskId = (action as { value: string }).value
    const task = pendingTasks.get(taskId)
    if (!task) return
    pendingTasks.delete(taskId)

    const project = task.projects[task.selectedIndex]
    const messageTs = (body as any).message?.ts
    if (messageTs) await client.chat.delete({ channel: task.channel, ts: messageTs })

    await resolveProject(taskId, task.targetUserId, task.prompt, project.path, task.channel, task.ts, task.requesterId, task.autoAccept)
  })

  app.action("accept_task", async ({ action, body, ack, client }) => {
    await ack()
    const taskId = (action as { value: string }).value
    const confirmation = pendingConfirmations.get(taskId)
    if (!confirmation) return
    pendingConfirmations.delete(taskId)

    const messageTs = (body as any).message?.ts
    if (messageTs) await client.chat.delete({ channel: confirmation.channel, ts: messageTs })

    await dispatchSlack(
      confirmation.targetUserId, taskId, confirmation.prompt, confirmation.workingDir,
      confirmation.channel, confirmation.ts, confirmation.requesterId
    )
  })

  app.action("deny_task", async ({ action, body, ack, client }) => {
    await ack()
    const taskId = (action as { value: string }).value
    const confirmation = pendingConfirmations.get(taskId)
    if (!confirmation) return
    pendingConfirmations.delete(taskId)

    const messageTs = (body as any).message?.ts
    if (messageTs) await client.chat.delete({ channel: confirmation.channel, ts: messageTs })

    await postMessage(confirmation.channel, `<@${confirmation.targetUserId}> a refusé la demande de <@${confirmation.requesterId}>.`, confirmation.ts)
  })

  await app.start()
  console.log("[server] running in Slack mode — waiting for daemons and Slack events")
  await refreshStatus()
}

main().catch((e) => {
  console.error("[server] fatal:", e)
  process.exit(1)
})
