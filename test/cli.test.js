import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { main } from "../src/cli.js";

test("configure writes base URL and API key to the configured path", async () => {
  const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-")), "config.json");
  const output = captureStream();

  await main([
    "configure",
    "--base-url",
    "https://answerlayer.example",
    "--api-key",
    "al_live_test",
  ], {
    env: { ANSWERLAYER_CONFIG: configPath },
    stdin: readableStdin(),
    stdout: output,
    stderr: captureStream(),
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), {
    baseUrl: "https://answerlayer.example",
    apiKey: "al_live_test",
  });
  assert.match(output.text(), /Saved AnswerLayer config/);
});

test("query run calls the AnswerLayer API with X-API-Key", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/query/connection-1");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["X-API-Key"], "al_live_test");
    assert.deepEqual(JSON.parse(init.body), {
      query: "select 1",
      params: null,
      row_limit: 1000,
      timeout: 30,
    });

    return new Response(JSON.stringify({
      columns: ["value"],
      rows: [[1]],
      row_count: 1,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "query",
      "run",
      "connection-1",
      "--base-url",
      "https://answerlayer.example",
      "--api-key",
      "al_live_test",
      "--sql",
      "select 1",
      "--json",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), {
    columns: ["value"],
    rows: [[1]],
    row_count: 1,
  });
});

test("api command supports arbitrary method, path, query, body, and headers", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();

  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "https://answerlayer.example/api/v1/semantic/entities?connection_id=conn-1");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["X-API-Key"], "al_live_test");
    assert.equal(init.headers["X-Test"], "yes");
    assert.deepEqual(JSON.parse(init.body), { name: "orders" });

    return new Response(JSON.stringify({ id: "entity-1" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "api",
      "post",
      "/api/v1/semantic/entities",
      "--base-url",
      "https://answerlayer.example",
      "--api-key",
      "al_live_test",
      "--query",
      "connection_id=conn-1",
      "--header",
      "X-Test=yes",
      "--body",
      "{\"name\":\"orders\"}",
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), { id: "entity-1" });
});

test("api command can build multipart uploads", async () => {
  const originalFetch = globalThis.fetch;
  const output = captureStream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "al-cli-upload-"));
  const uploadPath = path.join(tempDir, "sample.csv");
  fs.writeFileSync(uploadPath, "id\n1\n");

  globalThis.fetch = async (_url, init) => {
    assert.equal(init.method, "POST");
    assert.ok(init.body instanceof FormData);
    assert.equal(init.headers["Content-Type"], undefined);
    assert.equal(init.body.get("name"), "sample");
    assert.equal(init.body.get("file").name, "sample.csv");

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    await main([
      "api",
      "post",
      "/api/v1/csv/upload",
      "--base-url",
      "https://answerlayer.example",
      "--api-key",
      "al_live_test",
      "--form",
      "name=sample",
      "--file",
      `file=${uploadPath}`,
    ], {
      env: {},
      stdin: readableStdin(),
      stdout: output,
      stderr: captureStream(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(JSON.parse(output.text()), { ok: true });
});

function readableStdin() {
  const stream = Readable.from([]);
  stream.isTTY = true;
  return stream;
}

function captureStream() {
  let body = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      body += chunk.toString();
      callback();
    },
  });
  stream.text = () => body;
  return stream;
}
