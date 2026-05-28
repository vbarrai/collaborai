import { randomUUID } from "crypto"
import type { App } from "@slack/bolt"
import type { Project, AutoAcceptRules } from "../protocol.js"

type RequestProjectsFn = (slackUserId: string, requestId: string) => Promise<{ projects: Project[]; autoAccept: AutoAcceptRules }>
type SendDaemonCmdFn = (slackUserId: string, requestId: string, args: string[]) => Promise<string>

function buildDaemonBlocks(projects: Project[], autoAccept: AutoAcceptRules): any[] {
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: "Config daemon" } },
    { type: "section", text: { type: "mrkdwn", text: "*Projets :*" } },
  ]

  if (projects.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_Aucun projet configuré._" } })
  }

  for (const project of projects) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${project.name}*  →  \`${project.path}\`` },
      accessory: {
        type: "button",
        action_id: "daemon_remove_project",
        text: { type: "plain_text", text: "Supprimer" },
        style: "danger",
        value: project.name,
        confirm: {
          title: { type: "plain_text", text: "Confirmer" },
          text: { type: "mrkdwn", text: `Supprimer le projet *${project.name}* ?` },
          confirm: { type: "plain_text", text: "Supprimer" },
          deny: { type: "plain_text", text: "Annuler" },
        },
      },
    })
  }

  blocks.push(
    {
      type: "actions",
      elements: [{
        type: "button",
        action_id: "daemon_add_project",
        text: { type: "plain_text", text: "+ Ajouter un projet" },
      }],
    },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*Auto-accept :*" } },
  )

  const acceptEntries = Object.entries(autoAccept.channels ?? {})
  if (acceptEntries.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_Aucune règle configurée._" } })
  }

  for (const [channelId, cfg] of acceptEntries) {
    const users = cfg.users.length === 0
      ? "tous"
      : cfg.users.map((u) => (u === "*" ? "tous" : `<@${u}>`)).join(", ")
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `<#${channelId}>  →  ${users}` },
      accessory: {
        type: "overflow",
        action_id: "daemon_accept_overflow",
        options: [
          { text: { type: "plain_text", text: "Ajouter un utilisateur" }, value: `add_user:${channelId}` },
          { text: { type: "plain_text", text: "Autoriser tout le monde" }, value: `all:${channelId}` },
          { text: { type: "plain_text", text: "Supprimer la règle" }, value: `remove:${channelId}` },
        ],
      },
    })
  }

  blocks.push({
    type: "actions",
    elements: [{
      type: "button",
      action_id: "daemon_add_accept",
      text: { type: "plain_text", text: "+ Ajouter une règle auto-accept" },
    }],
  })

  return blocks
}

const MODAL_TITLE = { type: "plain_text" as const, text: "Config daemon" }
const MODAL_CLOSE = { type: "plain_text" as const, text: "Fermer" }

async function refreshDaemonModal(
  client: any,
  viewId: string,
  userId: string,
  requestProjects: RequestProjectsFn,
  notice?: string,
) {
  const { projects, autoAccept } = await requestProjects(userId, randomUUID())
  const blocks = buildDaemonBlocks(projects, autoAccept)
  if (notice) {
    blocks.unshift({ type: "section", text: { type: "mrkdwn", text: notice } }, { type: "divider" })
  }
  await client.views.update({
    view_id: viewId,
    view: {
      type: "modal",
      callback_id: "daemon_config_modal",
      title: MODAL_TITLE,
      close: MODAL_CLOSE,
      private_metadata: userId,
      blocks,
    },
  })
}

export async function openDaemonModal(
  client: any,
  triggerId: string,
  userId: string,
  requestProjects: RequestProjectsFn,
) {
  const opened = await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "daemon_config_modal",
      title: MODAL_TITLE,
      close: MODAL_CLOSE,
      private_metadata: userId,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "_Chargement..._" } }],
    },
  })

  try {
    const { projects, autoAccept } = await requestProjects(userId, randomUUID())
    await client.views.update({
      view_id: opened.view!.id,
      view: {
        type: "modal",
        callback_id: "daemon_config_modal",
        title: MODAL_TITLE,
        close: MODAL_CLOSE,
        private_metadata: userId,
        blocks: buildDaemonBlocks(projects, autoAccept),
      },
    })
  } catch {
    await client.views.update({
      view_id: opened.view!.id,
      view: {
        type: "modal",
        callback_id: "daemon_config_modal",
        title: MODAL_TITLE,
        close: MODAL_CLOSE,
        private_metadata: userId,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: ":x: Daemon hors ligne ou non disponible." } }],
      },
    })
  }
}

export function registerDaemonModalHandlers(
  app: App,
  requestProjects: RequestProjectsFn,
  sendCmd: SendDaemonCmdFn,
) {
  app.action("daemon_remove_project", async ({ body, action, client, ack }) => {
    await ack()
    const projectName = (action as any).value as string
    const userId = (body as any).user.id
    const viewId = (body as any).view?.id
    try {
      await sendCmd(userId, randomUUID(), ["project", "remove", projectName])
      await refreshDaemonModal(client, viewId, userId, requestProjects)
    } catch (e) {
      console.error("[daemon-modal] remove_project error:", e)
    }
  })

  app.action("daemon_add_project", async ({ body, client, ack }) => {
    await ack()
    const userId = (body as any).user.id
    const parentViewId = (body as any).view?.id
    console.log("[daemon-modal] daemon_add_project: userId=%s parentViewId=%s", userId, parentViewId)
    try {
      await client.views.push({
        trigger_id: (body as any).trigger_id,
        view: {
          type: "modal",
          callback_id: "daemon_add_project_modal",
          title: { type: "plain_text", text: "Ajouter un projet" },
          submit: { type: "plain_text", text: "Ajouter" },
          close: { type: "plain_text", text: "Annuler" },
          private_metadata: JSON.stringify({ userId, parentViewId }),
          blocks: [
            {
              type: "input",
              block_id: "name_block",
              label: { type: "plain_text", text: "Nom du projet" },
              element: {
                type: "plain_text_input",
                action_id: "name_input",
                placeholder: { type: "plain_text", text: "mon-api" },
              },
            },
            {
              type: "input",
              block_id: "path_block",
              label: { type: "plain_text", text: "Chemin absolu" },
              element: {
                type: "plain_text_input",
                action_id: "path_input",
                placeholder: { type: "plain_text", text: "/home/dev/mon-api" },
              },
            },
          ],
        },
      })
    } catch (e) {
      console.error("[daemon-modal] push add_project modal error:", e)
    }
  })

  app.view("daemon_add_project_modal", async ({ view, client, ack }) => {
    await ack()
    const { userId, parentViewId } = JSON.parse(view.private_metadata)
    const name = view.state.values.name_block.name_input.value ?? ""
    const path = view.state.values.path_block.path_input.value ?? ""
    console.log("[daemon-modal] add_project submit: userId=%s name=%s path=%s parentViewId=%s", userId, name, path, parentViewId)
    try {
      const result = await sendCmd(userId, randomUUID(), ["project", "add", name, path])
      console.log("[daemon-modal] add_project result:", result)
      const notice = result.includes(":x:") ? result : undefined
      await refreshDaemonModal(client, parentViewId, userId, requestProjects, notice)
    } catch (e) {
      console.error("[daemon-modal] add_project error:", e)
    }
  })

  app.action("daemon_accept_overflow", async ({ body, action, client, ack }) => {
    await ack()
    const selected = (action as any).selected_option?.value as string
    if (!selected) return
    const [cmd, channelId] = selected.split(":")
    const userId = (body as any).user.id
    const viewId = (body as any).view?.id

    if (cmd === "all") {
      await sendCmd(userId, randomUUID(), ["accept", channelId, "*"])
      await refreshDaemonModal(client, viewId, userId, requestProjects)
      return
    }

    if (cmd === "remove") {
      await sendCmd(userId, randomUUID(), ["unaccept", channelId])
      await refreshDaemonModal(client, viewId, userId, requestProjects)
      return
    }

    if (cmd === "add_user") {
      await client.views.push({
        trigger_id: (body as any).trigger_id,
        view: {
          type: "modal",
          callback_id: "daemon_add_user_accept_modal",
          title: { type: "plain_text", text: "Ajouter un accès" },
          submit: { type: "plain_text", text: "Ajouter" },
          close: { type: "plain_text", text: "Annuler" },
          private_metadata: JSON.stringify({ userId, channelId, parentViewId: viewId }),
          blocks: [{
            type: "input",
            block_id: "user_block",
            label: { type: "plain_text", text: `Utilisateur autorisé pour <#${channelId}>` },
            element: {
              type: "users_select",
              action_id: "user_select",
              placeholder: { type: "plain_text", text: "Choisir un utilisateur" },
            },
          }],
        },
      })
    }
  })

  app.view("daemon_add_user_accept_modal", async ({ view, client, ack }) => {
    await ack()
    const { userId, channelId, parentViewId } = JSON.parse(view.private_metadata)
    const selectedUser = view.state.values.user_block.user_select.selected_user
    if (!selectedUser) return
    await sendCmd(userId, randomUUID(), ["accept", channelId, selectedUser])
    await refreshDaemonModal(client, parentViewId, userId, requestProjects)
  })

  app.action("daemon_add_accept", async ({ body, client, ack }) => {
    await ack()
    const userId = (body as any).user.id
    const parentViewId = (body as any).view?.id
    await client.views.push({
      trigger_id: (body as any).trigger_id,
      view: {
        type: "modal",
        callback_id: "daemon_add_accept_modal",
        title: { type: "plain_text", text: "Ajouter auto-accept" },
        submit: { type: "plain_text", text: "Ajouter" },
        close: { type: "plain_text", text: "Annuler" },
        private_metadata: JSON.stringify({ userId, parentViewId }),
        blocks: [
          {
            type: "input",
            block_id: "channel_block",
            label: { type: "plain_text", text: "Channel" },
            element: {
              type: "channels_select",
              action_id: "channel_select",
              placeholder: { type: "plain_text", text: "Choisir un channel" },
            },
          },
          {
            type: "input",
            block_id: "user_block",
            optional: true,
            label: { type: "plain_text", text: "Utilisateur (laisser vide = tout le monde)" },
            element: {
              type: "users_select",
              action_id: "user_select",
              placeholder: { type: "plain_text", text: "Tous les membres" },
            },
          },
        ],
      },
    })
  })

  app.view("daemon_add_accept_modal", async ({ view, client, ack }) => {
    await ack()
    const { userId, parentViewId } = JSON.parse(view.private_metadata)
    const channelId = view.state.values.channel_block.channel_select.selected_channel ?? ""
    const selectedUser = view.state.values.user_block.user_select.selected_user ?? "*"
    if (!channelId) return
    await sendCmd(userId, randomUUID(), ["accept", channelId, selectedUser])
    await refreshDaemonModal(client, parentViewId, userId, requestProjects)
  })
}
