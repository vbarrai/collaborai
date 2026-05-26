import { readFileSync, writeFileSync, existsSync } from "fs"
import { homedir } from "os"
import { join } from "path"

const CONFIG_PATH = join(homedir(), ".collaborai", "brain.config.json")

interface ChannelConfig { allowedSenders: string[] }
interface BrainConfig { channels: Record<string, ChannelConfig> }

function load(): BrainConfig {
  if (!existsSync(CONFIG_PATH)) return { channels: {} }
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) } catch { return { channels: {} } }
}

function save(config: BrainConfig) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}

export interface CommandResult {
  text: string
}

// Parses "config ..." commands and returns a response text
// Supported:
//   config show
//   config channel add <channelId>
//   config channel remove <channelId>
//   config allow <userId> <channelId>
//   config deny <userId> <channelId>
export function handleConfigCommand(args: string): CommandResult {
  const parts = args.trim().split(/\s+/)
  const sub = parts[0]

  if (sub === "show" || !sub) {
    const config = load()
    if (Object.keys(config.channels).length === 0) {
      return { text: "_Aucun channel configuré._" }
    }
    const lines = Object.entries(config.channels).map(([ch, cfg]) => {
      const senders = cfg.allowedSenders.length === 0
        ? "tous"
        : cfg.allowedSenders.map((u) => `<@${u}>`).join(", ")
      return `• <#${ch}>  →  ${senders}`
    })
    return { text: `*Brain config — channels autorisés :*\n${lines.join("\n")}` }
  }

  if (sub === "channel") {
    const action = parts[1]
    const channelRaw = parts[2]
    const channelId = channelRaw?.replace(/[<#>]/g, "").split("|")[0]

    if (!channelId) return { text: ":x: Usage : `config channel add <channelId>` ou `config channel remove <channelId>`" }

    const config = load()

    if (action === "add") {
      config.channels[channelId] = config.channels[channelId] ?? { allowedSenders: [] }
      save(config)
      return { text: `:white_check_mark: Channel <#${channelId}> ajouté (tous les membres autorisés).` }
    }

    if (action === "remove") {
      if (!config.channels[channelId]) return { text: `:x: Channel <#${channelId}> non trouvé.` }
      delete config.channels[channelId]
      save(config)
      return { text: `:white_check_mark: Channel <#${channelId}> supprimé.` }
    }

    return { text: ":x: Action inconnue. Utilisez `add` ou `remove`." }
  }

  if (sub === "allow" || sub === "deny") {
    const userRaw = parts[1]
    const channelRaw = parts[2]
    const userId = userRaw?.replace(/[<@>]/g, "").split("|")[0]
    const channelId = channelRaw?.replace(/[<#>]/g, "").split("|")[0]

    if (!userId || !channelId) {
      return { text: `:x: Usage : \`config ${sub} @user #channel\`` }
    }

    const config = load()
    if (!config.channels[channelId]) {
      return { text: `:x: Channel <#${channelId}> non configuré. Ajoutez-le d'abord avec \`config channel add <id>\`.` }
    }

    const senders = config.channels[channelId].allowedSenders

    if (sub === "allow") {
      if (!senders.includes(userId)) senders.push(userId)
      save(config)
      return { text: `:white_check_mark: <@${userId}> autorisé dans <#${channelId}>.` }
    }

    if (sub === "deny") {
      config.channels[channelId].allowedSenders = senders.filter((u) => u !== userId)
      save(config)
      return { text: `:white_check_mark: <@${userId}> retiré de <#${channelId}>.` }
    }
  }

  return { text: `:x: Commande inconnue. Commandes disponibles :\n• \`config show\`\n• \`config channel add/remove <id>\`\n• \`config allow/deny @user #channel\`` }
}
