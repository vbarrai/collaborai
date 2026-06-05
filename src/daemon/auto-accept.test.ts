import { test } from "node:test"
import assert from "node:assert/strict"
import { shouldAutoAcceptRequester } from "./auto-accept.js"

test("no requesters list → not auto-accepted", () => {
  assert.equal(shouldAutoAcceptRequester({ channels: {} }, "alice"), false)
  assert.equal(shouldAutoAcceptRequester({ channels: {}, requesters: [] }, "alice"), false)
})

test("explicit requester → auto-accepted", () => {
  assert.equal(shouldAutoAcceptRequester({ channels: {}, requesters: ["alice", "bob"] }, "alice"), true)
  assert.equal(shouldAutoAcceptRequester({ channels: {}, requesters: ["bob"] }, "alice"), false)
})

test("wildcard → anyone auto-accepted", () => {
  assert.equal(shouldAutoAcceptRequester({ channels: {}, requesters: ["*"] }, "whoever"), true)
})
