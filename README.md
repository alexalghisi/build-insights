# build-insights

Where does CI time go? This service collects step timings from every build and shows which steps dominate, how their p50 and p95 move, how often caches hit, and what the month's build minutes cost. It has three parts:

- a TypeScript API on MySQL and ClickHouse, speaking Connect RPC;
- a React console;
- a small Go CLI that CI jobs use to report.

![The Go CLI reporting builds and hitting auth and tenant checks, then the console](docs/preview.gif)

## Design

```
CI job ──bi report──▶  Connect API (Node.js, TypeScript) ──▶ ClickHouse   step timings, one row per step
                            │                              └▶ MySQL        orgs, projects, API tokens, plans
console (React) ──────────▶─┘
```

**One contract.** The API is defined once in protobuf (`proto/`). Buf generates the TypeScript for the server and for the console. The Go CLI speaks the Connect protocol directly over HTTP and JSON, so it needs no generated code. `buf lint` keeps the contract consistent.

**Analytics in ClickHouse.** Step timings go into a `ReplacingMergeTree` keyed by `(org, project, build, step index)`:

- **Retried reports.** A CI job that retries its upload replaces the earlier report instead of double counting. Reporting the same build id again is idempotent, and a shorter re-report removes the extra steps.
- **Percentiles.** p50 and p95 are computed per step.
- **Wall-clock build time.** Trends and billing use the time from first step start to last step end, so steps that run in parallel aren't counted twice.
- **Billing.** Each build is rounded up to the minute, and overage is charged beyond the plan's included minutes.

**Accounts in MySQL.** Orgs, projects and API tokens are stored without foreign keys, so the schema also runs on PlanetScale/Vitess. Tokens:

- are only stored as SHA-256 hashes;
- carry a `bi_` prefix that secret scanners can match;
- can be narrowed to one project and revoked.

**Authorization is closed by default.** An interceptor resolves the token and checks the scope each RPC requires: `builds:write`, `insights:read` or `billing:read`. An RPC that is missing from the policy table is refused, and a test fails if any RPC lacks an entry. Projects of other orgs return `not_found`, so ids can't be probed across tenants.

**Errors are for people.** An invalid report gets one `invalid_argument` error that lists every problem with its field path, for example `steps[0].duration_ms: at most 86400000`. The CLI prints Connect errors as they come.

**The CLI is safe to run in CI.**

- The build id defaults to `GITHUB_RUN_ID` plus `GITHUB_RUN_ATTEMPT`, so a re-run counts as a new build but a retried upload doesn't.
- Transient failures are retried with backoff and jitter: `unavailable`, `resource_exhausted`, proxy 502/503/504 and network errors. This is safe because reports are idempotent.
- The token is read from the environment, never from a flag, so it stays out of shell history.

## Tech stack

TypeScript (strict), Node.js 22, Connect RPC, protobuf and Buf, MySQL, ClickHouse, React 19, Vite, Go 1.24, vitest, Testing Library, `go test`

## Running it

```bash
docker compose up -d                       # MySQL 8 and ClickHouse
npm ci && (cd web && npm ci)

export MYSQL_URL=mysql://buildlog:buildlog@127.0.0.1/buildlog CLICKHOUSE_URL=http://localhost:8123
npm run seed                               # three weeks of builds for two projects; prints API tokens
CORS_ORIGIN=http://localhost:5173 npm start   # API on :8080
(cd web && npm run dev)                    # console on http://localhost:5173, paste the console token
```

The CLI:

```bash
cd cli && go build -o bin/bi .
export BUILD_INSIGHTS_TOKEN=bi_…            # a token with builds:write
bi report --project prj_… --file steps.json
bi stats --project prj_… --days 14         # needs insights:read
```

`steps.json` is the list of steps of one build, in the API's JSON format. Timestamps must be within the 90-day retention:

```json
[
  { "name": "install dependencies", "startedAt": "2026-10-05T10:00:03Z", "durationMs": 3400, "cached": true },
  { "name": "unit tests", "startedAt": "2026-10-05T10:00:31Z", "durationMs": 51800 }
]
```

In GitHub Actions:

```yaml
- name: Report build timings
  if: always()
  run: bi report --project ${{ vars.BUILD_INSIGHTS_PROJECT }} --file steps.json
  env:
    BUILD_INSIGHTS_URL: https://insights.example.com
    BUILD_INSIGHTS_TOKEN: ${{ secrets.BUILD_INSIGHTS_TOKEN }}
```

## Tests

```bash
npm run typecheck
BUILD_INSIGHTS_TEST_MYSQL_URL=mysql://buildlog:buildlog@127.0.0.1/buildlog \
BUILD_INSIGHTS_TEST_CLICKHOUSE_URL=http://localhost:8123 npm test   # API end to end, ClickHouse queries, accounts
(cd web && npm run typecheck && npm test)                          # console against an in-memory Connect router
(cd cli && go vet ./... && go test ./...)                          # CLI against httptest servers
```

Database tests are skipped when the URLs aren't set.

## Layout

```
proto/       API contract (Buf)
src/         API server: accounts (MySQL), analytics (ClickHouse), auth, Connect routes, seed
web/         React console
cli/         Go CLI
```

## License

MIT
