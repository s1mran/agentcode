import { test, expect } from "bun:test"
import { BashArity } from "../../src/permission/arity"

test("arity 1 - unknown commands default to first token", () => {
  expect(BashArity.prefix(["unknown", "command", "subcommand"])).toEqual(["unknown"])
  expect(BashArity.prefix(["touch", "foo.txt"])).toEqual(["touch"])
})

test("arity 2 - two token commands", () => {
  expect(BashArity.prefix(["git", "checkout", "main"])).toEqual(["git", "checkout"])
  expect(BashArity.prefix(["docker", "run", "nginx"])).toEqual(["docker", "run"])
})

test("arity 3 - three token commands", () => {
  expect(BashArity.prefix(["aws", "s3", "ls", "my-bucket"])).toEqual(["aws", "s3", "ls"])
  expect(BashArity.prefix(["npm", "run", "dev", "script"])).toEqual(["npm", "run", "dev"])
})

test("longest match wins - nested prefixes", () => {
  expect(BashArity.prefix(["docker", "compose", "up", "service"])).toEqual(["docker", "compose", "up"])
  expect(BashArity.prefix(["consul", "kv", "get", "config"])).toEqual(["consul", "kv", "get"])
})

test("exact length matches", () => {
  expect(BashArity.prefix(["git", "checkout"])).toEqual(["git", "checkout"])
  expect(BashArity.prefix(["npm", "run", "dev"])).toEqual(["npm", "run", "dev"])
})

test("edge cases", () => {
  expect(BashArity.prefix([])).toEqual([])
  expect(BashArity.prefix(["single"])).toEqual(["single"])
  expect(BashArity.prefix(["git"])).toEqual(["git"])
})

test("added entries keep prefixes meaningful", () => {
  expect(BashArity.prefix(["gh", "pr", "view", "12"])).toEqual(["gh", "pr", "view"])
  expect(BashArity.prefix(["docker", "compose", "up", "-d"])).toEqual(["docker", "compose", "up"])
  expect(BashArity.prefix(["kubectl", "get", "pods"])).toEqual(["kubectl", "get"])
  expect(BashArity.prefix(["cargo", "test", "--release"])).toEqual(["cargo", "test"])
  expect(BashArity.prefix(["go", "test", "./..."])).toEqual(["go", "test"])
  expect(BashArity.prefix(["uv", "sync", "--frozen"])).toEqual(["uv", "sync"])
  expect(BashArity.prefix(["uv", "run", "pytest", "-x"])).toEqual(["uv", "run", "pytest"])
  expect(BashArity.prefix(["poetry", "install"])).toEqual(["poetry", "install"])
  expect(BashArity.prefix(["make", "build", "VERBOSE=1"])).toEqual(["make", "build"])
  expect(BashArity.prefix(["pnpm", "run", "dev", "--port"])).toEqual(["pnpm", "run", "dev"])
  expect(BashArity.prefix(["yarn", "run", "dev", "x"])).toEqual(["yarn", "run", "dev"])
})

test("object prototype names are not arity entries", () => {
  expect(BashArity.prefix(["constructor", "x"])).toEqual(["constructor"])
  expect(BashArity.prefix(["toString"])).toEqual(["toString"])
  expect(BashArity.prefix(["hasOwnProperty", "a", "b"])).toEqual(["hasOwnProperty"])
})
