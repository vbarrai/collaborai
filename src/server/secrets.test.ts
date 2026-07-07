import { test } from "node:test"
import assert from "node:assert/strict"
import { tmpdir } from "os"
import { join } from "path"
import { rmSync, mkdtempSync } from "fs"
import { mergeServerSecrets, loadSecretsFile, writeSecretsFile } from "./secrets.js"

test("mergeServerSecrets: env overrides file", () => {
  const file = { wsAuthToken: "file-token", slack: { botToken: "file-bot", appToken: "file-app" } }
  const env = { WS_AUTH_TOKEN: "env-token", SLACK_BOT_TOKEN: "env-bot" }
  const r = mergeServerSecrets(env, file)
  assert.equal(r.wsAuthToken, "env-token")
  assert.equal(r.slackBotToken, "env-bot")
  assert.equal(r.slackAppToken, "file-app") // not in env → falls back to file
})

test("mergeServerSecrets: file used when env empty", () => {
  const file = { wsAuthToken: "file-token", slack: { botToken: "file-bot", appToken: "file-app" } }
  const r = mergeServerSecrets({}, file)
  assert.equal(r.wsAuthToken, "file-token")
  assert.equal(r.slackBotToken, "file-bot")
  assert.equal(r.slackAppToken, "file-app")
})

test("mergeServerSecrets: undefined when neither set", () => {
  const r = mergeServerSecrets({}, {})
  assert.equal(r.wsAuthToken, undefined)
  assert.equal(r.slackBotToken, undefined)
})

test("secrets file write/read roundtrip", () => {
  const dir = mkdtempSync(join(tmpdir(), "collaborai-"))
  const path = join(dir, "secrets.json")
  try {
    assert.deepEqual(loadSecretsFile(path), {}) // missing file → empty
    writeSecretsFile({ wsAuthToken: "abc", slack: { botToken: "xoxb-1" } }, path)
    const loaded = loadSecretsFile(path)
    assert.equal(loaded.wsAuthToken, "abc")
    assert.equal(loaded.slack?.botToken, "xoxb-1")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
