import { readFileSync, writeFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type { App } from "@slack/bolt"

const CONFIG_PATH = join(homedir(), ".collaborai", "server.config.json")

interface ChannelConfig { allowedSenders: string[] }
interface ServerConfig { channels: Record<string, ChannelConfig> }

function load(): ServerConfig {
  if (!existsSync(CONFIG_PATH)) return { channels: {} }
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) } catch { return { channels: {} } }
}

function save(config: ServerConfig) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

function buildHomeBlocks(config: ServerConfig): any[] {
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: "CollaborAI — Server Config" } },
    { type: "section", text: { type: "mrkdwn", text: "*Channels autorisés :*" } },
  ]

  const entries = Object.entries(config.channels)
  if (entries.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_Aucun channel configuré._" } })
  }

  for (const [channelId, cfg] of entries) {
    const senders = cfg.allowedSenders.length === 0
      ? "tous"
      : cfg.allowedSenders.map((u) => `<@${u}>`).join(", ")
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `<#${channelId}>  —  ${senders}` },
      accessory: {
        type: "overflow",
        action_id: "server_channel_overflow",
        options: [
          { text: { type: "plain_text", text: "Gérer les utilisateurs" }, value: `manage:${channelId}` },
          { text: { type: "plain_text", text: "Supprimer le channel" }, value: `remove:${channelId}` },
        ],
      },
    })
  }

  blocks.push(
    { type: "divider" },
    {
      type: "actions",
      elements: [{
        type: "button",
        action_id: "server_add_channel",
        text: { type: "plain_text", text: "+ Ajouter un channel" },
      }],
    },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*Configuration de votre daemon :*" } },
    {
      type: "actions",
      elements: [{
        type: "button",
        action_id: "open_daemon_config",
        text: { type: "plain_text", text: "Ouvrir ma config daemon" },
        style: "primary",
      }],
    },
  )

  return blocks
}

export async function publishHome(client: any, userId: string) {
  const config = load()
  await client.views.publish({
    user_id: userId,
    view: { type: "home", blocks: buildHomeBlocks(config) },
  })
}

export function registerHomeHandlers(
  app: App,
  onConfigChange: () => void,
  openDaemonConfig: (triggerId: string, userId: string, client: any) => Promise<void>,
) {
  app.event("app_home_opened", async ({ event, client }) => {
    await publishHome(client, event.user)
  })

  app.action("server_add_channel", async ({ body, client, ack }) => {
    await ack()
    await client.views.open({
      trigger_id: (body as any).trigger_id,
      view: {
        type: "modal",
        callback_id: "server_add_channel_modal",
        title: { type: "plain_text", text: "Ajouter un channel" },
        submit: { type: "plain_text", text: "Ajouter" },
        close: { type: "plain_text", text: "Annuler" },
        private_metadata: (body as any).user.id,
        blocks: [{
          type: "input",
          block_id: "channel_block",
          label: { type: "plain_text", text: "Channel" },
          element: {
            type: "channels_select",
            action_id: "channel_select",
            placeholder: { type: "plain_text", text: "Choisir un channel" },
          },
        }],
      },
    })
  })

  app.view("server_add_channel_modal", async ({ body, view, client, ack }) => {
    await ack()
    const channelId = view.state.values.channel_block.channel_select.selected_channel
    if (!channelId) return
    const config = load()
    config.channels[channelId] ??= { allowedSenders: [] }
    save(config)
    onConfigChange()
    await publishHome(client, body.user.id)
  })

  app.action("server_channel_overflow", async ({ body, action, client, ack }) => {
    await ack()
    const selected = (action as any).selected_option?.value as string
    if (!selected) return
    const [cmd, channelId] = selected.split(":")
    const userId = (body as any).user.id

    if (cmd === "remove") {
      const config = load()
      delete config.channels[channelId]
      save(config)
      onConfigChange()
      await publishHome(client, userId)
      return
    }

    if (cmd === "manage") {
      const config = load()
      const cfg = config.channels[channelId]
      if (!cfg) return
      await client.views.open({
        trigger_id: (body as any).trigger_id,
        view: {
          type: "modal",
          callback_id: "server_manage_users_modal",
          title: { type: "plain_text", text: "Gérer les accès" },
          submit: { type: "plain_text", text: "Sauvegarder" },
          close: { type: "plain_text", text: "Annuler" },
          private_metadata: JSON.stringify({ channelId, userId }),
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: `*<#${channelId}>* — utilisateurs autorisés.\n_Laisser vide = tout le monde._` },
            },
            {
              type: "input",
              block_id: "users_block",
              optional: true,
              label: { type: "plain_text", text: "Utilisateurs autorisés" },
              element: {
                type: "multi_users_select",
                action_id: "users_select",
                placeholder: { type: "plain_text", text: "Tous les membres" },
                ...(cfg.allowedSenders.length > 0 ? { initial_users: cfg.allowedSenders } : {}),
              },
            },
          ],
        },
      })
    }
  })

  app.view("server_manage_users_modal", async ({ body, view, client, ack }) => {
    await ack()
    const { channelId, userId } = JSON.parse(view.private_metadata)
    const selectedUsers = view.state.values.users_block.users_select.selected_users ?? []
    const config = load()
    if (config.channels[channelId]) {
      config.channels[channelId].allowedSenders = selectedUsers
      save(config)
      onConfigChange()
    }
    await publishHome(client, userId)
  })

  app.action("open_daemon_config", async ({ body, client, ack }) => {
    await ack()
    await openDaemonConfig((body as any).trigger_id, (body as any).user.id, client)
  })
}
