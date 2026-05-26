# AnswerLayer CLI

Open-source command line client for the AnswerLayer API.

## Install

```bash
npm install -g @answerlayer/cli
```

For local development:

```bash
git clone <repo-url> answerlayer-cli
cd answerlayer-cli
npm link
```

## Configure

Create an API key in AnswerLayer with the scopes needed by your workflow, then run:

```bash
answerlayer configure --base-url https://app.example.com --api-key al_live_...
```

You can also skip the config file and use environment variables:

```bash
export ANSWERLAYER_BASE_URL=https://app.example.com
export ANSWERLAYER_API_KEY=al_live_...
```

The CLI sends API keys using the `X-API-Key` header.

Useful scopes:

- `connection:read` for listing connections
- `query:execute` for raw SQL
- `saved_query:read`, `saved_query:execute`, and `saved_query:write` for saved-query workflows
- `inquiry:execute` for natural-language inquiry

## Commands

```bash
answerlayer health
answerlayer openapi --output openapi.json

answerlayer connections list
answerlayer connections get <connection-id>

answerlayer query run <connection-id> --sql "select * from orders limit 10"
answerlayer query validate <connection-id> --sql "select * from orders"
answerlayer query run <connection-id> --file ./query.sql --format csv

answerlayer saved-queries list
answerlayer saved-queries create --name "Revenue by month" --connection <connection-id> --file ./revenue.sql
answerlayer saved-queries execute <saved-query-id> --format table

answerlayer inquiry ask --connection <connection-id> "What changed in revenue this month?"
answerlayer inquiry ask --session <session-id> "Break that down by region"
```

Most read commands support `--json`. Query results support `--format table|json|csv`.

## Full API coverage

The named commands are convenience wrappers for common workflows. For functional parity with the REST API, use `answerlayer api`:

```bash
answerlayer api get /api/v1/connections/
answerlayer api post /api/v1/semantic/entities --body '{"name":"Orders","description":"Customer orders"}'
answerlayer api get /api/v1/metadata/structure/<connection-id> --query include_pii=true
answerlayer api post /api/v1/csv/upload --form name=orders --file file=./orders.csv
answerlayer api patch /api/v1/dashboards/<dashboard-id> --body-file ./dashboard-update.json
answerlayer api get /api/v1/branding/assets/logo --output logo.png
```

Useful options:

- `--body <json>` or `--body-file <path>` for JSON request bodies
- `--raw-body` to send body text without JSON parsing
- `--query key=value`, `--header key=value`, and `--form key=value`, all repeatable
- `--file field=path` for multipart uploads
- `--include` to print response status and headers
- `--output <path>` or `--raw` for binary responses
- `--no-auth` for public endpoints

## Development

```bash
npm test
```

The package intentionally has no runtime dependencies. It requires Node.js 20 or newer for built-in `fetch`.

## License

MIT
