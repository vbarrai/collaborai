import { test } from "node:test"
import assert from "node:assert/strict"
import type { WebSocket } from "ws"
import { register, registerClient, unregister, getByUserId, getClient, listAll } from "./registry.js"

// Minimal fake socket — registry only stores and compares it by reference.
const fakeWs = () => ({}) as unknown as WebSocket

test("daemon register / lookup / list", () => {
  const ws = fakeWs()
  register("alice", ws)
  assert.equal(getByUserId("alice")?.ws, ws)
  assert.ok(listAll().includes("alice"))
})

test("client register / lookup, separate from daemons", () => {
  const ws = fakeWs()
  registerClient("cli-1", ws)
  assert.equal(getClient("cli-1")?.ws, ws)
  assert.equal(getByUserId("cli-1"), undefined) // clients are not daemons
})

test("unregister removes daemon by socket", () => {
  const ws = fakeWs()
  register("bob", ws)
  assert.ok(getByUserId("bob"))
  unregister(ws)
  assert.equal(getByUserId("bob"), undefined)
})

test("unregister removes client by socket", () => {
  const ws = fakeWs()
  registerClient("cli-2", ws)
  assert.ok(getClient("cli-2"))
  unregister(ws)
  assert.equal(getClient("cli-2"), undefined)
})
