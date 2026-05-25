import fs from "node:fs";
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

  write(io.stdout, formatQueryResult(result, parsed.flags.format || "table"));
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
    const name = parsed.flags.name;
    const connectionId = parsed.flags.connection;
    const sql = await readSql(parsed.flags, positionals, io);
    if (!name || !connectionId) {
      throw usage("saved-queries create requires --name and --connection");
    }
    const result = await client.createSavedQuery({
      name,
      description: parsed.flags.description,
      visibility: parsed.flags.visibility,
      sql,
      connection_id: connectionId,
    });
    write(io.stdout, formatJson(result));
    return;
  }

  if (command === "execute") {
    const id = requirePositional(positionals, 0, "saved query id");
    const result = await client.executeSavedQuery(id, {
      params: parseJsonFlag(parsed.flags.params, "params"),
      row_limit: parseInteger(parsed.flags.rowLimit, 1000),
      timeout: parseInteger(parsed.flags.timeout, 30),
    });
    write(io.stdout, parsed.flags.json ? formatJson(result) : formatQueryResult(result, parsed.flags.format || "table"));
    return;
  }

  throw usage(`Unknown saved-queries command: ${command}`);
}

async function handleInquiry(client, command, positionals, parsed, io) {
  if (command !== "ask") {
    throw usage("Expected `inquiry ask`");
  }

  const question = parsed.flags.question || positionals.join(" ");
  const connectionId = parsed.flags.connection;
  if (!question.trim()) {
    throw usage("inquiry ask requires a question");
  }

  let sessionId = parsed.flags.session;
  if (!sessionId) {
    if (!connectionId) {
      throw usage("inquiry ask requires --connection when --session is not provided");
    }
    const session = await client.createInquirySession({
      connection_id: connectionId,
      model: parsed.flags.model,
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
    params: parseJsonFlag(flags.params, "params"),
    row_limit: parseInteger(flags.rowLimit, 1000),
    timeout: parseInteger(flags.timeout, 30),
  };
}

async function readSql(flags, positionals, io) {
  if (flags.sql) {
    return flags.sql;
  }

  if (flags.file) {
    return fs.readFileSync(flags.file, "utf8");
  }

  if (positionals.length > 0) {
    return positionals.join(" ");
  }

  if (!io.stdin.isTTY) {
    return await readAll(io.stdin);
  }

  throw usage("SQL is required. Pass --sql, --file, a positional SQL string, or stdin.");
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
      flags[name] = true;
      continue;
    }

    if (inlineValue !== undefined) {
      flags[name] = inlineValue;
      continue;
    }

    if (next === undefined || next.startsWith("-")) {
      throw usage(`Missing value for ${rawName}`);
    }

    flags[name] = next;
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
  };

  return aliases[rawName] || rawName.replace(/^-+/, "").replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function isBooleanFlag(rawName) {
  return rawName === "--json" || rawName === "--help" || rawName === "-h";
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

SQL options:
  --sql, -q <sql>    SQL text.
  --file, -f <path>  Read SQL from a file.
  --params <json>    Query parameters as JSON.
  --row-limit <n>    Row limit. Default: 1000.
  --timeout <sec>    Timeout in seconds. Default: 30.
`;
}
