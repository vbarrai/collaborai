# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

CollaborAI lets a Slack team delegate coding tasks to Claude Code instances running on individual
developers' machines. A user `@`-mentions the bot and a target teammate in a configured channel; the
target's machine runs `claude -p <prompt>` in a chosen project directory and streams the result back
into the Slack thread.

The system has two processes that talk over a single WebSocket connection:

- **Server** (`src/server/`) — one central process. Connects to Slack via Socket Mode (`@slack/bolt`),
  runs the WebSocket *server*, and orchestrates the request → confirmation → dispatch → stream flow.
- **Daemon** (`src/daemon/`) — one per developer, runs on their own machine. Connects to the Server as a
  WebSocket *client*, advertises its local projects, and spawns the `claude` CLI to execute tasks.

The wire protocol between them is the single source of truth in `src/protocol.ts` (`ServerMessage` /
`DaemonMessage` discriminated unions). Change message shapes there first; both sides import it.

## Commands

```bash
npm run server            # start the Brain (Slack + WebSocket server). Needs SLACK_*, WS_PORT, WS_AUTH_TOKEN
npm run daemon           # start a Daemon (connects to Brain). Needs BRAIN_URL, SLACK_USER_ID, WS_AUTH_TOKEN
npm run daemon:install   # (macOS) install the Daemon as a launchd LaunchAgent so it starts at login
npm run daemon:uninstall # (macOS) stop and remove the LaunchAgent
```

`daemon:install` (`src/daemon/install.ts`) writes a LaunchAgent plist to
`~/Library/LaunchAgents/com.collaborai.daemon.plist` and `launchctl load`s it. The plist runs the same
`node --env-file=.env --import tsx src/daemon/index.ts` command with absolute paths, sets
`RunAtLoad`/`KeepAlive` (start at login, restart on crash), bakes the install-time `PATH` in (so the
daemon still finds the `claude` CLI under launchd's minimal environment), and logs to
`~/.collaborai/daemon.log`. macOS-only for now.

Both scripts run TypeScript directly via `tsx` and load env vars with `node --env-file=.env`. There is
no build step for running, no test suite, and no linter configured. `tsconfig.json` targets ESNext
modules in `strict` mode (`npx tsc --noEmit` type-checks without emitting).

Copy `.env.example` to `.env` before running. The Daemon requires the `claude` CLI to be installed and
on `PATH` (it is invoked with `--dangerously-skip-permissions`).

## Architecture

### Task flow (Server side, `index.ts` + `ws-server.ts`)

1. **Trigger** — `app.event("app_mention")` / `app.message` → `handleMention()`. The channel must exist
   in `server.config.json`, and if that channel lists `allowedSenders`, the requester must be one of them.
2. **Resolve projects** — for each mentioned, *daemon-connected* user, the Server sends `list_projects`
   over WebSocket and awaits a `projects` reply (`requestProjects`, 5s timeout via a pending-promise map
   keyed by `requestId`).
3. **Pick a project** — if the prompt text contains a project name it auto-selects; otherwise the Server
   posts a `static_select` + "Lancer" button (`pendingTasks` map).
4. **Confirm** — `resolveProject()` either auto-dispatches (if `shouldAutoAccept` matches the daemon's
   per-channel rules) or posts Accept/Deny buttons (`pendingConfirmations` map).
5. **Dispatch & stream** — `dispatchTask()` posts a placeholder Slack message, records it in
   `streamingMessages` keyed by `taskId`, and sends a `task` message. Incoming `stream` chunks are
   appended to the buffer and the Slack message is edited in place (wrapped in a ``` code block);
   `done` clears state, `error` rewrites the message.

The asynchronous request/response pairs (`list_projects`/`projects`, `config_cmd`/`config_response`)
are all implemented as **pending-promise maps keyed by a `requestId`** with a timeout — follow this
pattern when adding new round-trip messages.

### Daemon side (`daemon/index.ts`)

`connect()` opens the WebSocket, registers with `{ slackUserId, token }`, and auto-reconnects after 5s
on close. On a `task` message, `runClaudeCode()` spawns `claude -p <prompt> --output-format stream-json
--verbose --dangerously-skip-permissions` in the project's `cwd`, parses each JSON line, and forwards
`assistant` text blocks and the final `result` as `stream` chunks. Exit code 0 → `done`, else `error`.

### Connection registry (`server/registry.ts`)

In-memory `Map<slackUserId, { ws, connectedAt }>`. This is the authority on which developers are
currently online. `onRegistryChange` listeners drive the pinned "who's online" status message
(`status.ts`). Auth is a shared `WS_AUTH_TOKEN` checked on `register`; unregistered sockets are closed.

### Slack Home tab & modals (`home-tab.ts`, `daemon-modal.ts`)

The App Home tab (`app_home_opened`) renders Server config (allowed channels/senders). The "Config
daemon" button opens a modal that proxies to the target daemon via `config_cmd` round-trips, so a user
edits their *remote* daemon's project list and auto-accept rules from Slack. Modals stack with
`views.push` and refresh the parent view through the `parentViewId` carried in `private_metadata`.

## Configuration & state

All persistent state lives as JSON under `~/.collaborai/` (gitignored, never committed):

- `server.config.json` (Server) — `{ channels: { [channelId]: { allowedSenders: string[] } } }`.
  Empty `allowedSenders` means everyone in that channel is allowed.
- `daemon.config.json` (Daemon) — `{ projects: Project[], autoAccept: { channels: {...} } }`.
  In `autoAccept`, a `users` list containing `"*"` means auto-accept from anyone.
- `status-messages.json` (Server) — maps channel → the pinned status message `ts` so it can be updated.

Config can be edited three ways, all converging on the same JSON: Slack slash-style commands
(`@collaborai config ...`, parsed in `server/config-commands.ts` and `daemon/config-commands.ts`), the
Home tab, and the daemon modal. `index.ts` decides whether a `config` command targets the Server or a
daemon by checking whether a mentioned user is in the connection registry. When you add a config
option, update the command parser, the relevant Home/modal blocks, and the loader that reads it.

## Conventions

- **ESM only.** `package.json` is `"type": "module"`; intra-`src` imports must use explicit `.js`
  extensions (e.g. `import { ... } from "./registry.js"`) even though the sources are `.ts`.
- Slack-user-facing strings are written in **French**; logs and code identifiers are in English.
- Slack-formatted IDs are normalized by stripping wrapper characters, e.g.
  `raw.replace(/[<#>|]/g, "").split("|")[0]` for channels and `/[<@>]/g` for users.
- Bolt action/view handlers reach into loosely typed payloads, so `(body as any)` / `@ts-ignore` are
  used deliberately at those boundaries; keep them localized rather than widening types broadly.
