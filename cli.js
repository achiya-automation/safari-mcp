#!/usr/bin/env node
// `safari-mcp pair` must not start the server: importing index.js boots the Safari helper.
if (process.argv[2] === "pair") (await import("./pairing.js")).printPairingCode();
else await import("./index.js");
