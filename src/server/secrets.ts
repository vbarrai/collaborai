import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join, dirname } from "path"
import { createInterface } from "readline"

export const COLLABORAI_HOME = process.env.COLLABORAI_HOME ?? join(homedir(), ".collaborai")
export const SECRETS_PATH = join(COLLABORAI_HOME, "secrets.json")

export interface Secrets {
  wsAuthToken?: string
  slack?: { botToken?: string; appToken?: string }
}

export interface ResolvedServerSecrets {
  wsAuthToken?: string
  slackBotToken?: string
  slackAppToken?: string
}

export function loadSecretsFile(path = SECRETS_PATH): Secrets {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Secrets
  } catch {
    return {}
  }
}

export function writeSecretsFile(secrets: Secrets, path = SECRETS_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(secrets, null, 2) + "\n")
}

// Pure precedence resolution: environment variables win over the secrets file.
// Exported separately so it can be unit-tested without touching the filesystem.
export function mergeServerSecrets(
  env: Record<string, string | undefined>,
  file: Secrets
): ResolvedServerSecrets {
  return {
    wsAuthToken: env.WS_AUTH_TOKEN ?? file.wsAuthToken,
    slackBotToken: env.SLACK_BOT_TOKEN ?? file.slack?.botToken,
    slackAppToken: env.SLACK_APP_TOKEN ?? file.slack?.appToken,
  }
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close()
    resolve(answer.trim())
  }))
}

// Resolves the secrets the server needs. In Slack mode, if tokens are missing
// and we have an interactive terminal, runs a one-time wizard and persists them.
export async function loadServerSecrets(opts: {
  slack: boolean
  path?: string
}): Promise<ResolvedServerSecrets> {
  const path = opts.path ?? SECRETS_PATH
  const file = loadSecretsFile(path)
  let resolved = mergeServerSecrets(process.env, file)

  const interactive = Boolean(process.stdin.isTTY)
  const missingSlack = opts.slack && (!resolved.slackBotToken || !resolved.slackAppToken)
  const missingToken = !resolved.wsAuthToken

  if ((missingSlack || (opts.slack && missingToken)) && interactive) {
    console.log("\n— Configuration CollaborAI (premier lancement) —")
    console.log(`Les tokens seront enregistrés dans ${path}\n`)

    const updated: Secrets = { ...file, slack: { ...file.slack } }

    if (missingToken) {
      const v = await prompt("WS_AUTH_TOKEN (secret partagé daemons/clients) : ")
      if (v) updated.wsAuthToken = v
    }
    if (opts.slack && !resolved.slackBotToken) {
      const v = await prompt("SLACK_BOT_TOKEN (xoxb-…) : ")
      if (v) updated.slack!.botToken = v
    }
    if (opts.slack && !resolved.slackAppToken) {
      const v = await prompt("SLACK_APP_TOKEN (xapp-…) : ")
      if (v) updated.slack!.appToken = v
    }

    writeSecretsFile(updated, path)
    console.log(`\n✔ Tokens enregistrés dans ${path}\n`)
    resolved = mergeServerSecrets(process.env, updated)
  }

  return resolved
}
