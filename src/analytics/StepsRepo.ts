import type { ClickHouseClient } from "@clickhouse/client";

export interface StepRow {
    readonly name: string;
    readonly startedAt: Date;
    readonly durationMs: number;
    readonly cached: boolean;
    readonly exitCode: number;
}

export interface BuildReport {
    readonly orgId: string;
    readonly projectId: string;
    readonly buildId: string;
    readonly gitRef: string;
    readonly steps: readonly StepRow[];
}

export interface StepStatsRow {
    readonly name: string;
    readonly runs: number;
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly cacheHitRate: number;
    readonly shareOfTime: number;
}

export interface TrendRow {
    readonly day: string;
    readonly builds: number;
    readonly p50BuildMs: number;
    readonly p95BuildMs: number;
    readonly cacheHitRate: number;
}

export interface DailyMinutes {
    readonly day: string;
    readonly builds: number;
    readonly buildMinutes: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS build_steps (
    org_id       LowCardinality(String),
    project_id   LowCardinality(String),
    build_id     String,
    git_ref      String,
    step_index   UInt16,
    step_name    String,
    started_at   DateTime64(3, 'UTC'),
    duration_ms  UInt32,
    cached       Bool,
    exit_code    Int32,
    version      UInt64
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(started_at)
ORDER BY (org_id, project_id, build_id, step_index)`;

// A build's wall-clock time: first step start to last step end. Steps can run in parallel,
// so summing step durations would overstate it.
const BUILDS = `
SELECT project_id, build_id,
       min(started_at) AS started,
       max(toUnixTimestamp64Milli(started_at) + duration_ms) - min(toUnixTimestamp64Milli(started_at)) AS wall_ms
FROM build_steps FINAL`;

/**
 * Step timings live in ClickHouse. Rows are keyed by build and step index in a
 * ReplacingMergeTree, so a CI job that retries its report replaces the earlier
 * rows instead of double counting. Queries read with FINAL to see the latest report.
 */
export class StepsRepo {
    readonly #ch: ClickHouseClient;

    constructor(client: ClickHouseClient) {
        this.#ch = client;
    }

    async migrate(): Promise<void> {
        await this.#ch.command({ query: SCHEMA });
    }

    async hasBuild(projectId: string, buildId: string): Promise<boolean> {
        const result = await this.#ch.query({
            query: "SELECT count() AS n FROM build_steps WHERE project_id = {projectId:String} AND build_id = {buildId:String}",
            query_params: { projectId, buildId },
            format: "JSONEachRow",
        });
        const [row] = await result.json<{ n: string }>();
        return Number(row?.n ?? 0) > 0;
    }

    /** Replaces the build's steps. A shorter re-report removes the extra steps of the earlier one. */
    async insertBuild(build: BuildReport): Promise<void> {
        const version = nextVersion();
        await this.#ch.command({
            query: "DELETE FROM build_steps WHERE project_id = {projectId:String} AND build_id = {buildId:String} AND step_index >= {count:UInt16}",
            query_params: { projectId: build.projectId, buildId: build.buildId, count: build.steps.length },
        });
        await this.#ch.insert({
            table: "build_steps",
            format: "JSONEachRow",
            values: build.steps.map((step, index) => ({
                org_id: build.orgId,
                project_id: build.projectId,
                build_id: build.buildId,
                git_ref: build.gitRef,
                step_index: index,
                step_name: step.name,
                started_at: step.startedAt.toISOString(),
                duration_ms: step.durationMs,
                cached: step.cached,
                exit_code: step.exitCode,
                version,
            })),
            clickhouse_settings: { date_time_input_format: "best_effort" },
        });
    }

    async stepStats(projectId: string, windowDays: number, now = new Date()): Promise<{ builds: number; steps: StepStatsRow[] }> {
        const params = { projectId, since: since(now, windowDays) };
        const steps = await this.#rows<{ name: string; runs: string; p50: number; p95: number; hit: number; share: number }>(
            `SELECT step_name AS name, count() AS runs,
                    toUInt32(quantileExact(0.5)(duration_ms)) AS p50,
                    toUInt32(quantileExact(0.95)(duration_ms)) AS p95,
                    avg(cached) AS hit,
                    sum(duration_ms) / sum(sum(duration_ms)) OVER () AS share
             FROM build_steps FINAL
             WHERE project_id = {projectId:String} AND started_at >= {since:DateTime64(3)}
             GROUP BY step_name
             ORDER BY sum(duration_ms) DESC, name
             LIMIT 100`,
            params,
        );
        const [builds] = await this.#rows<{ n: string }>(
            "SELECT uniqExact(build_id) AS n FROM build_steps FINAL WHERE project_id = {projectId:String} AND started_at >= {since:DateTime64(3)}",
            params,
        );
        return {
            builds: Number(builds?.n ?? 0),
            steps: steps.map((s) => ({ name: s.name, runs: Number(s.runs), p50Ms: s.p50, p95Ms: s.p95, cacheHitRate: s.hit, shareOfTime: s.share })),
        };
    }

    async trend(projectId: string, windowDays: number, now = new Date()): Promise<TrendRow[]> {
        const rows = await this.#rows<{ day: string; builds: string; p50: number; p95: number; hit: number }>(
            `SELECT toString(toDate(b.started)) AS day, count() AS builds,
                    toUInt32(quantileExact(0.5)(b.wall_ms)) AS p50,
                    toUInt32(quantileExact(0.95)(b.wall_ms)) AS p95,
                    any(h.hit) AS hit
             FROM (${BUILDS} WHERE project_id = {projectId:String} AND started_at >= {since:DateTime64(3)} GROUP BY project_id, build_id) AS b
             LEFT JOIN (SELECT toDate(started_at) AS d, avg(cached) AS hit FROM build_steps FINAL
                        WHERE project_id = {projectId:String} AND started_at >= {since:DateTime64(3)} GROUP BY d) AS h ON h.d = toDate(b.started)
             GROUP BY day ORDER BY day`,
            { projectId, since: since(now, windowDays) },
        );
        return rows.map((r) => ({ day: r.day, builds: Number(r.builds), p50BuildMs: r.p50, p95BuildMs: r.p95, cacheHitRate: r.hit }));
    }

    /** Build minutes per day for an org's month: each build's wall-clock time, rounded up to the minute. */
    async dailyMinutes(orgId: string, month: string): Promise<DailyMinutes[]> {
        const rows = await this.#rows<{ day: string; builds: string; minutes: string }>(
            `SELECT toString(toDate(started)) AS day, count() AS builds, sum(toUInt32(ceil(wall_ms / 60000))) AS minutes
             FROM (${BUILDS} WHERE org_id = {orgId:String} AND toYYYYMM(started_at) = {month:UInt32} GROUP BY project_id, build_id)
             WHERE toYYYYMM(started) = {month:UInt32}
             GROUP BY day ORDER BY day`,
            { orgId, month: Number(month.replace("-", "")) },
        );
        return rows.map((r) => ({ day: r.day, builds: Number(r.builds), buildMinutes: Number(r.minutes) }));
    }

    async #rows<T>(query: string, query_params: Record<string, unknown>): Promise<T[]> {
        const result = await this.#ch.query({ query, query_params, format: "JSONEachRow" });
        return result.json<T>();
    }
}

let lastVersion = 0;

/** Microsecond timestamps that never repeat in this process, so the latest report always wins. */
function nextVersion(): number {
    lastVersion = Math.max(Date.now() * 1000, lastVersion + 1);
    return lastVersion;
}

function since(now: Date, days: number): string {
    return new Date(now.getTime() - days * 86_400_000).toISOString().replace("T", " ").replace("Z", "");
}
