import fs from "node:fs";
import path from "node:path";
import { AnswerLayerClient } from "./client.js";
import { formatJson, formatList, formatQueryResult } from "./format.js";
import { readConfig, resolveAuth, writeConfig } from "./config.js";

export async function main(argv, io) {
  const parsed = parseArgs(argv);
  const [group, command, ...positionals] = parsed.positionals;

  if (!group || group === "help" || parsed.flags.help || parsed.flags.h) {
    write(io.stdout, helpText());
    return;
  }

  if (group === "configure") {
    return configure(parsed, io);
  }

  const { baseUrl, apiKey } = resolveAuth(parsed.flags, io.env);
  const client = new AnswerLayerClient({ baseUrl, apiKey });

  if (group === "health") {
    const result = await client.health();
    write(io.stdout, parsed.flags.json ? formatJson(result) : `ok ${JSON.stringify(result)}\n`);
    return;
  }

  if (group === "openapi") {
    const result = await client.rawRequest("GET", "/openapi.json", { auth: false });
    return writeApiResponse(result, parsed, io);
  }

  if (group === "api") {
    return handleApi(client, command, positionals, parsed, io);
  }

  if (group === "connections") {
    return handleConnections(client, command, positionals, parsed, io);
  }

  if (group === "query") {
    return handleQuery(client, command, positionals, parsed, io);
  }

  if (group === "saved-queries" || group === "saved") {
    return handleSavedQueries(client, command, positionals, parsed, io);
  }

  if (group === "inquiry") {
    return handleInquiry(client, command, positionals, parsed, io);
  }

  throw usage(`Unknown command: ${group}`);
}

async function handleApi(client, command, positionals, parsed, io) {
  const method = (command || "").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) {
    throw usage("Expected `api <method> <path>`");
  }

  const apiPath = requirePositional(positionals, 0, "API path");
  const headers = parseHeaderFlags(allValues(parsed.flags.header));
  const body = await buildApiBody(parsed.flags, io);
  const result = await client.rawRequest(method, apiPath, {
    auth: !parsed.flags.noAuth,
    query: parsePairFlags(allValues(parsed.flags.query), "--query"),
    headers,
    body,
  });

  writeApiResponse(result, parsed, io);
}

function configure(parsed, io) {
  const existing = readConfig(io.env);
  const baseUrl = parsed.flags.baseUrl || existing.baseUrl;
  const apiKey = parsed.flags.apiKey || existing.apiKey;

  if (!baseUrl || !apiKey) {
    throw usage("configure requires --base-url and --api-key");
  }

  const configPath = writeConfig({ ...existing, baseUrl, apiKey }, io.env);
  write(io.stdout, `Saved AnswerLayer config to ${configPath}\n`);
}

async function handleConnections(client, command, positionals, parsed, io) {
  if (command === "list" || !command) {
    const result = await client.listConnections();
    if (parsed.flags.json) {
      write(io.stdout, formatJson(result));
      return;
    }
    write(io.stdout, formatList(result, [
      { key: "id", label: "ID" },
      { key: "name", label: "Name" },
      { key: "db_type", label: "Type" },
      { key: "status", label: "Status" },
    ]));
    return;
  }

  if (command === "get") {
    const id = requirePositional(positionals, 0, "connection id");
    write(io.stdout, formatJson(await client.getConnection(id)));
    return;
  }

  throw usage(`Unknown connections command: ${command}`);
}

async function handleQuery(client, command, positionals, parsed, io) {
  if (command !== "run" && command !== "validate") {
    throw usage("Expected `query run` or `query validate`");
  }

  const connectionId = requirePositional(positionals, 0, "connection id");
  const sql = await readSql(parsed.flags, positionals.slice(1), io);
  const payload = queryPayload(parsed.flags, sql);
  const result = command === "run"
    ? await client.runQuery(connectionId, payload)
    : await client.validateQuery(connectionId, payload);

  if (command === "validate" || parsed.flags.json) {
    write(io.stdout, formatJson(result));
    return;
  }

  write(io.stdout, formatQueryResult(result, firstValue(parsed.flags.format) || "table"));
}

async function handleSavedQueries(client, command, positionals, parsed, io) {
  if (command === "list" || !command) {
    const result = await client.listSavedQueries();
    if (parsed.flags.json) {
      write(io.stdout, formatJson(result));
      return;
    }
    write(io.stdout, formatList(result.saved_queries || [], [
      { key: "id", label: "ID" },
      { key: "name", label: "Name" },
      { key: "visibility", label: "Visibility" },
      { key: "connection_id", label: "Connection" },
    ]));
    return;
  }

  if (command === "get") {
    const id = requirePositional(positionals, 0, "saved query id");
    write(io.stdout, formatJson(await client.getSavedQuery(id)));
    return;
  }

  if (command === "create") {
    const name = firstValue(parsed.flags.name);
    const connectionId = firstValue(parsed.flags.connection);
    const sql = await readSql(parsed.flags, positionals, io);
    if (!name || !connectionId) {
      throw usage("saved-queries create requires --name and --connection");
    }
    const result = await client.createSavedQuery({
      name,
      description: firstValue(parsed.flags.description),
      visibility: firstValue(parsed.flags.visibility),
      sql,
      connection_id: connectionId,
    });
    write(io.stdout, formatJson(result));
    return;
  }

  if (command === "execute") {
    const id = requirePositional(positionals, 0, "saved query id");
    const result = await client.executeSavedQuery(id, {
      params: parseJsonFlag(firstValue(parsed.flags.params), "params"),
      row_limit: parseInteger(firstValue(parsed.flags.rowLimit), 1000),
      timeout: parseInteger(firstValue(parsed.flags.timeout), 30),
    });
    write(io.stdout, parsed.flags.json ? formatJson(result) : formatQueryResult(result, firstValue(parsed.flags.format) || "table"));
    return;
  }

  throw usage(`Unknown saved-queries command: ${command}`);
}

async function handleInquiry(client, command, positionals, parsed, io) {
  if (command !== "ask") {
    throw usage("Expected `inquiry ask`");
  }

  const question = firstValue(parsed.flags.question) || positionals.join(" ");
  const connectionId = firstValue(parsed.flags.connection);
  if (!question.trim()) {
    throw usage("inquiry ask requires a question");
  }

  let sessionId = firstValue(parsed.flags.session);
  if (!sessionId) {
    if (!connectionId) {
      throw usage("inquiry ask requires --connection when --session is not provided");
    }
    const session = await client.createInquirySession({
      connection_id: connectionId,
      model: firstValue(parsed.flags.model),
    });
    sessionId = session.session_id;
  }

  const result = await client.runInquiryTurnSync(sessionId, { user_input: question });
  if (parsed.flags.json) {
    write(io.stdout, formatJson({ session_id: sessionId, ...result }));
    return;
  }

  write(io.stdout, `${result.final_response}\n`);
  if (result.sql_queries && result.sql_queries.length > 0) {
    write(io.stdout, "\nSQL:\n");
    for (const sql of result.sql_queries) {
      write(io.stdout, `${sql}\n`);
    }
  }
}

function queryPayload(flags, sql) {
  return {
    query: sql,
    params: parseJsonFlag(firstValue(flags.params), "params"),
    row_limit: parseInteger(firstValue(flags.rowLimit), 1000),
    timeout: parseInteger(firstValue(flags.timeout), 30),
  };
}

async function readSql(flags, positionals, io) {
  const sql = firstValue(flags.sql);
  const file = firstValue(flags.file);

  if (sql) {
    return sql;
  }

  if (file) {
    return fs.readFileSync(file, "utf8");
  }

  if (positionals.length > 0) {
    return positionals.join(" ");
  }

  if (!io.stdin.isTTY) {
    return await readAll(io.stdin);
  }

  throw usage("SQL is required. Pass --sql, --file, a positional SQL string, or stdin.");
}

async function buildApiBody(flags, io) {
  const formEntries = allValues(flags.form);
  const uploadEntries = allValues(flags.file);
  if (formEntries.length > 0 || uploadEntries.length > 0) {
    const form = new FormData();
    for (const [key, value] of Object.entries(parsePairFlags(formEntries, "--form"))) {
      if (Array.isArray(value)) {
        for (const item of value) {
          form.append(key, item);
        }
      } else {
        form.append(key, value);
      }
    }
    for (const spec of uploadEntries) {
      const [field, filePath] = parsePair(spec, "--file");
      const buffer = fs.readFileSync(filePath);
      form.append(field, new Blob([buffer]), path.basename(filePath));
    }
    return form;
  }

  const rawBody = Boolean(flags.rawBody);
  const body = firstValue(flags.body);
  if (body !== undefined) {
    return rawBody ? body : parseJsonFlag(body, "body");
  }

  const bodyFile = firstValue(flags.bodyFile);
  if (bodyFile) {
    const text = fs.readFileSync(bodyFile, "utf8");
    return rawBody ? text : parseJsonFlag(text, "body-file");
  }

  if (!io.stdin.isTTY) {
    const text = await readAll(io.stdin);
    if (text.length > 0) {
      return rawBody ? text : parseJsonFlag(text, "stdin");
    }
  }

  return undefined;
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    const rawName = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
    const name = normalizeFlagName(rawName);
    const next = argv[index + 1];

    if (isBooleanFlag(rawName)) {
      setFlag(flags, name, true);
      continue;
    }

    if (inlineValue !== undefined) {
      setFlag(flags, name, inlineValue);
      continue;
    }

    if (next === undefined || next.startsWith("-")) {
      throw usage(`Missing value for ${rawName}`);
    }

    setFlag(flags, name, next);
    index += 1;
  }

  if (flags.help) {
    positionals.unshift("help");
  }

  return { flags, positionals };
}

function normalizeFlagName(rawName) {
  const aliases = {
    "-h": "help",
    "--help": "help",
    "--base-url": "baseUrl",
    "--api-key": "apiKey",
    "--row-limit": "rowLimit",
    "--sql": "sql",
    "-q": "sql",
    "--file": "file",
    "-f": "file",
    "--format": "format",
    "--params": "params",
    "--timeout": "timeout",
    "--name": "name",
    "--description": "description",
    "--visibility": "visibility",
    "--connection": "connection",
    "--session": "session",
    "--model": "model",
    "--question": "question",
    "--json": "json",
    "--body": "body",
    "--body-file": "bodyFile",
    "--raw-body": "rawBody",
    "--query": "query",
    "--form": "form",
    "--header": "header",
    "-H": "header",
    "--output": "output",
    "-o": "output",
    "--include": "include",
    "-i": "include",
    "--raw": "raw",
    "--no-auth": "noAuth",
  };

  return aliases[rawName] || rawName.replace(/^-+/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function isBooleanFlag(rawName) {
  return [
    "--json",
    "--help",
    "-h",
    "--raw-body",
    "--include",
    "-i",
    "--raw",
    "--no-auth",
  ].includes(rawName);
}

function setFlag(flags, name, value) {
  if (flags[name] === undefined) {
    flags[name] = value;
  } else if (Array.isArray(flags[name])) {
    flags[name].push(value);
  } else {
    flags[name] = [flags[name], value];
  }
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function allValues(value) {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function parsePairFlags(values, flagName) {
  const result = {};
  for (const value of values) {
    const [key, item] = parsePair(value, flagName);
    if (result[key] === undefined) {
      result[key] = item;
    } else if (Array.isArray(result[key])) {
      result[key].push(item);
    } else {
      result[key] = [result[key], item];
    }
  }
  return result;
}

function parseHeaderFlags(values) {
  const result = {};
  for (const value of values) {
    const separator = value.includes(":") ? ":" : "=";
    const index = value.indexOf(separator);
    if (index === -1) {
      throw usage(`Expected --header ${separator === ":" ? "Name: value" : "Name=value"}`);
    }
    const key = value.slice(0, index).trim();
    const item = value.slice(index + 1).trim();
    if (!key) {
      throw usage("Header name cannot be empty");
    }
    result[key] = item;
  }
  return result;
}

function parsePair(value, flagName) {
  const index = value.indexOf("=");
  if (index === -1) {
    throw usage(`Expected ${flagName} key=value`);
  }
  const key = value.slice(0, index);
  const item = value.slice(index + 1);
  if (!key) {
    throw usage(`Expected ${flagName} key=value`);
  }
  return [key, item];
}

function parseJsonFlag(value, name) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw usage(`Invalid JSON for --${name}: ${error.message}`);
  }
}

function parseInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw usage(`Expected an integer, received ${value}`);
  }
  return parsed;
}

function requirePositional(positionals, index, label) {
  const value = positionals[index];
  if (!value) {
    throw usage(`Missing ${label}`);
  }
  return value;
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function write(stream, text) {
  stream.write(text);
}

function writeApiResponse(result, parsed, io) {
  const output = firstValue(parsed.flags.output);
  if (output) {
    fs.writeFileSync(output, result.buffer);
    write(io.stdout, `Wrote ${result.buffer.length} bytes to ${output}\n`);
    return;
  }

  if (parsed.flags.include) {
    write(io.stdout, `HTTP ${result.status}\n`);
    for (const [key, value] of Object.entries(result.headers)) {
      write(io.stdout, `${key}: ${value}\n`);
    }
    write(io.stdout, "\n");
  }

  if (parsed.flags.raw) {
    io.stdout.write(result.buffer);
    return;
  }

  if (parsed.flags.json || result.contentType.includes("application/json") || typeof result.data === "object") {
    write(io.stdout, formatJson(result.data));
    return;
  }

  if (typeof result.data === "string") {
    write(io.stdout, result.data);
    if (!result.data.endsWith("\n")) {
      write(io.stdout, "\n");
    }
    return;
  }

  io.stdout.write(result.buffer);
}

function usage(message) {
  const error = new Error(`${message}\n\n${helpText()}`);
  error.exitCode = 2;
  return error;
}

function helpText() {
  return `AnswerLayer CLI

Usage:
  answerlayer configure --base-url <url> --api-key <key>
  answerlayer health [--base-url <url>]
  answerlayer openapi [--output openapi.json]
  answerlayer api <method> <path> [--body <json>] [--query key=value]
  answerlayer connections list [--json]
  answerlayer connections get <connection-id>
  answerlayer query run <connection-id> --sql <sql> [--format table|json|csv]
  answerlayer query validate <connection-id> --sql <sql>
  answerlayer saved-queries list [--json]
  answerlayer saved-queries get <saved-query-id>
  answerlayer saved-queries create --name <name> --connection <id> --sql <sql>
  answerlayer saved-queries execute <saved-query-id> [--format table|json|csv]
  answerlayer inquiry ask --connection <id> "question"
  answerlayer inquiry ask --session <id> "follow up question"

Global options:
  --base-url <url>   AnswerLayer API base URL. Env: ANSWERLAYER_BASE_URL
  --api-key <key>    API key. Env: ANSWERLAYER_API_KEY
  --json             Print JSON where available.

API parity options:
  --body <json>         JSON request body.
  --body-file <path>    Read JSON request body from a file.
  --raw-body            Send body or body-file as raw text instead of JSON.
  --query key=value     Add a query parameter. Repeatable.
  --form key=value      Add a multipart form field. Repeatable.
  --file field=path     Add a multipart file field. Repeatable for api commands.
  --header, -H <h=v>    Add a request header. Repeatable.
  --include, -i         Print response status and headers.
  --output, -o <path>   Write response bytes to a file.
  --raw                 Write response bytes directly to stdout.
  --no-auth             Do not send X-API-Key.

SQL options:
  --sql, -q <sql>    SQL text.
  --file, -f <path>  Read SQL from a file.
  --params <json>    Query parameters as JSON.
  --row-limit <n>    Row limit. Default: 1000.
  --timeout <sec>    Timeout in seconds. Default: 30.
`;
}
