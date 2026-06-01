// Installs (or uninstalls) the CollaborAI daemon as a macOS LaunchAgent, so it
// starts automatically at login and restarts if it crashes.
//
//   npm run daemon:install     -> generate the plist and load it into launchd
//   npm run daemon:uninstall   -> unload and remove the plist
//
// The plist runs exactly the same command as `npm run daemon`, with absolute
// paths (launchd has no cwd nor an interactive shell PATH). The current PATH is
// baked in at install time so the daemon can still resolve `claude`.

import { spawnSync } from "child_process"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs"
import { homedir, platform } from "os"
import { dirname, join, resolve } from "path"
import { fileURLToPath } from "url"

const LABEL = "com.collaborai.daemon"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..", "..") // src/daemon -> repo root
const plistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`)
const logDir = join(homedir(), ".collaborai")
const logPath = join(logDir, "daemon.log")

export function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`)
}

export function buildPlist(): string {
  const node = process.execPath // absolute path to the current node binary
  const nodeDir = dirname(node)
  // PATH baked in at install time (the dev installs from a shell where `claude`
  // is resolvable), augmented with the usual locations and node's dir.
  const path = [
    nodeDir,
    process.env.PATH ?? "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]
    .filter(Boolean)
    .join(":")

  const args = [
    node,
    `--env-file=${join(repoRoot, ".env")}`,
    "--import",
    "tsx",
    join(repoRoot, "src", "daemon", "index.ts"),
  ]

  const programArgs = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n")

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`
}

function launchctl(...args: string[]): void {
  const r = spawnSync("launchctl", args, { stdio: "inherit" })
  // `unload` of a missing plist returns a non-zero code: we ignore it in favor
  // of the main flow (real errors surface on the other commands).
  if (r.error) throw r.error
}

function install(): void {
  mkdirSync(dirname(plistPath), { recursive: true })
  mkdirSync(logDir, { recursive: true })

  if (!existsSync(join(repoRoot, ".env"))) {
    console.warn(`[install] no .env at ${join(repoRoot, ".env")} — copy .env.example before running`)
  }

  // Unload any previous version before rewriting the plist.
  if (existsSync(plistPath)) launchctl("unload", plistPath)

  writeFileSync(plistPath, buildPlist())
  launchctl("load", "-w", plistPath)

  console.log(`[install] LaunchAgent installed: ${plistPath}`)
  console.log(`[install] the daemon starts now and at every login`)
  console.log(`[install] logs: ${logPath}`)
}

function uninstall(): void {
  if (existsSync(plistPath)) {
    launchctl("unload", plistPath)
    rmSync(plistPath)
    console.log(`[install] LaunchAgent removed: ${plistPath}`)
  } else {
    console.log(`[install] nothing to remove (${plistPath} not found)`)
  }
}

// Only run the CLI when this file is the entry point, so importing it (e.g. in
// tests) does not trigger an install or exit the process.
const invokedDirectly =
  process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  if (platform() !== "darwin") {
    console.error("[install] this script only supports macOS (launchd). Detected platform:", platform())
    process.exit(1)
  }

  if (process.argv.includes("--uninstall")) uninstall()
  else install()
}
