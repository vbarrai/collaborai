import { test } from "node:test"
import assert from "node:assert/strict"

import { xmlEscape, buildPlist } from "./install.js"

test("xmlEscape escapes XML-significant characters as numeric entities", () => {
  assert.equal(xmlEscape("<"), "&#60;")
  assert.equal(xmlEscape(">"), "&#62;")
  assert.equal(xmlEscape("&"), "&#38;")
  assert.equal(xmlEscape("'"), "&#39;")
  assert.equal(xmlEscape('"'), "&#34;")
})

test("xmlEscape leaves ordinary characters untouched", () => {
  assert.equal(xmlEscape("/Users/dev/repo"), "/Users/dev/repo")
  assert.equal(xmlEscape(""), "")
})

test("xmlEscape escapes every occurrence", () => {
  assert.equal(xmlEscape("a<b<c"), "a&#60;b&#60;c")
  assert.equal(xmlEscape("a & b & c"), "a &#38; b &#38; c")
})

test("buildPlist produces a well-formed plist with the expected label", () => {
  const plist = buildPlist()
  assert.match(plist, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  assert.match(plist, /<key>Label<\/key>\s*<string>com\.collaborai\.daemon<\/string>/)
  assert.match(plist, /<\/plist>\s*$/)
})

test("buildPlist enables start-at-login and restart-on-crash", () => {
  const plist = buildPlist()
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/)
})

test("buildPlist runs the daemon entry point via the current node binary", () => {
  const plist = buildPlist()
  assert.ok(plist.includes(`<string>${process.execPath}</string>`))
  assert.match(plist, /<string>--env-file=[^<]*\.env<\/string>/)
  assert.match(plist, /<string>--import<\/string>/)
  assert.match(plist, /<string>tsx<\/string>/)
  assert.match(plist, /src[/\\]daemon[/\\]index\.ts<\/string>/)
})

test("buildPlist bakes a PATH that includes node's dir and Homebrew", () => {
  const plist = buildPlist()
  const pathMatch = plist.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/)
  assert.ok(pathMatch, "expected a PATH environment variable in the plist")
  const path = pathMatch![1]
  assert.ok(path.includes("/opt/homebrew/bin"))
  assert.ok(path.includes("/usr/local/bin"))
  assert.ok(path.includes("/usr/bin"))
})
