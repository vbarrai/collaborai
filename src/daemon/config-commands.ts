import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join, resolve } from "path"
import type { Project, AutoAcceptRules } from "../protocol.js"

const CONFIG_PATH = join(homedir(), ".collaborai", "daemon.config.json")

interface DaemonConfig {
  projects: Project[]
  autoAccept: AutoAcceptRules
}

function load(): DaemonConfig {
  if (!existsSync(CONFIG_PATH)) return { projects: [], autoAccept: { channels: {} } }
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) } catch { return { projects: [], autoAccept: { channels: {} } } }
}

function save(config: DaemonConfig) {
  mkdirSync(join(homedir(), ".collaborai"), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

export function handleDaemonConfigCmd(args: string[]): string {
  const [sub, ...rest] = args

  if (!sub || sub === "show") {
    const config = load()
    const projectLines = config.projects.length === 0
      ? "  _aucun_"
      : config.projects.map((p) => `  • \`${p.name}\`  →  \`${p.path}\``).join("\n")
    const acceptLines = Object.entries(config.autoAccept.channels).length === 0
      ? "  _aucun_"
      : Object.entries(config.autoAccept.channels).map(([ch, cfg]) => {
          const users = cfg.users.length === 0 ? "tous" : cfg.users.map((u) => u === "*" ? "tous" : `<@${u}>`).join(", ")
          return `  • <#${ch}>  →  ${users}`
        }).join("\n")
    return `*Daemon config*\n*Projets :*\n${projectLines}\n*Auto-accept :*\n${acceptLines}`
  }

  if (sub === "project") {
    const [action, name, ...pathParts] = rest
    const config = load()

    if (action === "add") {
      if (!name) return ":x: Usage : `config @you project add <nom> <path>`"
      const path = pathParts.length > 0 ? resolve(pathParts.join(" ")) : null
      if (!path) return ":x: Usage : `config @you project add <nom> <path>`"
      if (!existsSync(path)) return `:x: Dossier introuvable : \`${path}\``
      if (config.projects.find((p) => p.name === name)) return `:x: Projet \`${name}\` existe déjà.`
      config.projects.push({ name, path })
      save(config)
      return `:white_check_mark: Projet \`${name}\` ajouté → \`${path}\``
    }

    if (action === "remove") {
      if (!name) return ":x: Usage : `config @you project remove <nom>`"
      const before = config.projects.length
      config.projects = config.projects.filter((p) => p.name !== name)
      if (config.projects.length === before) return `:x: Projet \`${name}\` non trouvé.`
      save(config)
      return `:white_check_mark: Projet \`${name}\` supprimé.`
    }

    return ":x: Usage : `config @you project add/remove <nom> [<path>]`"
  }

  if (sub === "accept") {
    const [channelRaw, userRaw] = rest
    const channelId = channelRaw?.replace(/[<#>|]/g, "").split("|")[0]
    const userId = userRaw?.replace(/[<@>|]/g, "").split("|")[0] ?? "*"
    if (!channelId) return ":x: Usage : `config @you accept <channelId> [<userId|*>]`"
    const config = load()
    config.autoAccept.channels[channelId] ??= { users: [] }
    const users = config.autoAccept.channels[channelId].users
    if (!users.includes(userId)) users.push(userId)
    save(config)
    const display = userId === "*" ? "tous" : `<@${userId}>`
    return `:white_check_mark: Auto-accept : ${display} dans <#${channelId}>.`
  }

  if (sub === "deny") {
    const [channelRaw, userRaw] = rest
    const channelId = channelRaw?.replace(/[<#>|]/g, "").split("|")[0]
    const userId = userRaw?.replace(/[<@>|]/g, "").split("|")[0]
    if (!channelId || !userId) return ":x: Usage : `config @you deny <channelId> <userId>`"
    const config = load()
    if (!config.autoAccept.channels[channelId]) return `:x: Channel <#${channelId}> non trouvé.`
    config.autoAccept.channels[channelId].users = config.autoAccept.channels[channelId].users.filter((u) => u !== userId)
    save(config)
    return `:white_check_mark: <@${userId}> retiré de <#${channelId}>.`
  }

  return `:x: Commande inconnue. Disponibles :\n• \`config @you show\`\n• \`config @you project add <nom> <path>\`\n• \`config @you project remove <nom>\`\n• \`config @you accept <channelId> [userId|*]\`\n• \`config @you deny <channelId> <userId>\``
}
