#!/usr/bin/env node

import { main } from "../src/cli.js";

main(process.argv.slice(2), {
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
}).catch((error) => {
  const message = error && error.message ? error.message : String(error);
  process.stderr.write(`answerlayer: ${message}\n`);
  process.exitCode = error && Number.isInteger(error.exitCode) ? error.exitCode : 1;
});
