export class AnswerLayerApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "AnswerLayerApiError";
    this.status = status;
    this.body = body;
  }
}

export class AnswerLayerClient {
  constructor({ baseUrl, apiKey, fetchImpl = globalThis.fetch }) {
    if (!baseUrl) {
      throw new Error("Missing API base URL. Run `answerlayer configure --base-url <url> --api-key <key>` or set ANSWERLAYER_BASE_URL.");
    }

    if (!fetchImpl) {
      throw new Error("This CLI requires Node.js 20+ with global fetch support.");
    }

    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async request(method, path, { body, query, auth = true } = {}) {
    if (auth && !this.apiKey) {
      throw new Error("Missing API key. Run `answerlayer configure --base-url <url> --api-key <key>` or set ANSWERLAYER_API_KEY.");
    }

    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers = {
      Accept: "application/json",
      "User-Agent": "answerlayer-cli/0.1.0",
    };

    if (auth) {
      headers["X-API-Key"] = this.apiKey;
    }

    const init = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchImpl(url, init);
    const text = await response.text();
    const parsed = parseResponseBody(text, response.headers.get("content-type"));

    if (!response.ok) {
      const detail = parsed && typeof parsed === "object" && "detail" in parsed
        ? parsed.detail
        : text;
      const message = detail
        ? `API request failed (${response.status}): ${formatDetail(detail)}`
        : `API request failed (${response.status})`;
      throw new AnswerLayerApiError(message, { status: response.status, body: parsed });
    }

    return parsed;
  }

  health() {
    return this.request("GET", "/api/v1/health", { auth: false });
  }

  listConnections() {
    return this.request("GET", "/api/v1/connections/");
  }

  getConnection(id) {
    return this.request("GET", `/api/v1/connections/${encodeURIComponent(id)}`);
  }

  runQuery(connectionId, payload) {
    return this.request("POST", `/api/v1/query/${encodeURIComponent(connectionId)}`, {
      body: payload,
    });
  }

  validateQuery(connectionId, payload) {
    return this.request("POST", `/api/v1/query/${encodeURIComponent(connectionId)}/validate`, {
      body: payload,
    });
  }

  listSavedQueries() {
    return this.request("GET", "/api/v1/saved-queries");
  }

  getSavedQuery(id) {
    return this.request("GET", `/api/v1/saved-queries/${encodeURIComponent(id)}`);
  }

  createSavedQuery(payload) {
    return this.request("POST", "/api/v1/saved-queries", { body: payload });
  }

  executeSavedQuery(id, payload) {
    return this.request("POST", `/api/v1/saved-queries/${encodeURIComponent(id)}/execute`, {
      body: payload,
    });
  }

  createInquirySession(payload) {
    return this.request("POST", "/api/v1/inquiry/sessions", { body: payload });
  }

  runInquiryTurnSync(sessionId, payload) {
    return this.request("POST", `/api/v1/inquiry/sessions/${encodeURIComponent(sessionId)}/sync`, {
      body: payload,
    });
  }
}

function parseResponseBody(text, contentType) {
  if (!text) {
    return null;
  }

  if (contentType && contentType.includes("application/json")) {
    return JSON.parse(text);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatDetail(detail) {
  if (typeof detail === "string") {
    return detail;
  }
  return JSON.stringify(detail);
}
