#!/usr/bin/env node
/**
 * #140: on Node 24, undici's fetch calls socket.setTypeOfService() on every HTTP/1.1
 * write. On macOS a peer reset makes it throw EINVAL from an I/O callback, and the
 * process exits. The bridge-port takeover test caught it twice on CI (runs 36828160843
 * and 37142549357): the secondary died the moment its primary went away.
 *
 * Run:  node --test test/node-compat.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ignoreTypeOfServiceEinval } from "../node-compat.js";

function fakeSocketProto(error) {
  return {
    calls: 0,
    setTypeOfService(tos) {
      this.calls++;
      if (error) throw error;
      this.tos = tos;
      return this;
    },
  };
}

test("EINVAL from setTypeOfService is swallowed and the socket is returned", () => {
  const proto = fakeSocketProto(Object.assign(new Error("setTypeOfService EINVAL"), {
    code: "EINVAL", syscall: "setTypeOfService",
  }));
  ignoreTypeOfServiceEinval(proto);
  const socket = Object.create(proto);
  assert.equal(socket.setTypeOfService(0), socket);
  assert.equal(socket.calls, 1);
});

test("any other error still throws", () => {
  const proto = fakeSocketProto(Object.assign(new RangeError("tos out of range"), {
    code: "ERR_OUT_OF_RANGE",
  }));
  ignoreTypeOfServiceEinval(proto);
  assert.throws(() => Object.create(proto).setTypeOfService(999), { code: "ERR_OUT_OF_RANGE" });
});

test("a working call passes through, and wrapping twice adds no second layer", () => {
  const proto = fakeSocketProto(null);
  ignoreTypeOfServiceEinval(proto);
  const once = proto.setTypeOfService;
  ignoreTypeOfServiceEinval(proto);
  assert.equal(proto.setTypeOfService, once);
  const socket = Object.create(proto);
  assert.equal(socket.setTypeOfService(8), socket);
  assert.equal(socket.tos, 8);
});

test("Node without setTypeOfService (20, 22) is left alone", () => {
  const proto = {};
  ignoreTypeOfServiceEinval(proto);
  assert.equal("setTypeOfService" in proto, false);
});

// The real thing, in a child process: the native call fails the way macOS fails it on a
// reset socket, and undici's own write path calls it. On Node 24.21.0 without the
// wrapper this child exits 1 on the uncaught EINVAL, try/catch and all (measured
// 2026-10-04); Node 20, 22 and 26 never call it, so there the fetch simply resolves.
test("a fetch whose socket throws EINVAL from setTypeOfService still resolves", () => {
  const compat = new URL("../node-compat.js", import.meta.url).href;
  const script = `
    import { Socket } from "node:net";
    import http from "node:http";
    import { ignoreTypeOfServiceEinval } from ${JSON.stringify(compat)};
    Socket.prototype.setTypeOfService = function () {
      throw Object.assign(new Error("setTypeOfService EINVAL"), { code: "EINVAL", syscall: "setTypeOfService" });
    };
    ignoreTypeOfServiceEinval(Socket.prototype);
    const server = http.createServer((req, res) => res.end("ok")).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.on("listening", resolve));
    try {
      const res = await fetch("http://127.0.0.1:" + server.address().port + "/");
      console.log("resolved:" + (await res.text()));
    } catch (err) {
      console.log("rejected:" + err.message);
    }
    server.close();
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 20_000,
  });
  assert.equal(run.status, 0, `child exited ${run.status}:\n${run.stderr}`);
  assert.match(run.stdout, /resolved:ok/);
});

test("index.js wraps the real Socket prototype before its first fetch", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const applied = source.indexOf("ignoreTypeOfServiceEinval(Socket.prototype)");
  assert.ok(applied > 0, "index.js never applies ignoreTypeOfServiceEinval");
  assert.ok(applied < source.indexOf("fetch("), "the wrapper must run before any fetch");
});
