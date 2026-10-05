/**
 * Fills a local database with three weeks of realistic CI builds for two projects,
 * and prints API tokens for the CLI and the console.
 *
 *   MYSQL_URL=mysql://… CLICKHOUSE_URL=http://… npm run seed
 */
import { createClient } from "@clickhouse/client";
import mysql from "mysql2/promise";
import { AccountsRepo } from "./accounts/AccountsRepo.ts";
import { StepsRepo, type BuildReport, type StepRow } from "./analytics/StepsRepo.ts";

function seeded(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const random = seeded(42);
const between = (min: number, max: number) => Math.round(min + random() * (max - min));

/** One build: install is cached most of the time; unit and e2e tests run in parallel. A cache fix lands a week ago. */
function steps(start: Date, daysAgo: number, project: "api" | "web"): StepRow[] {
    const cacheHitRate = daysAgo > 7 ? 0.45 : 0.9;
    const installCached = random() < cacheHitRate;
    const plan: [string, number, boolean, boolean][] = [
        ["checkout", between(2_000, 4_000), false, false],
        ["install dependencies", installCached ? between(2_500, 4_500) : between(70_000, 110_000), installCached, false],
        ["build", project === "web" ? between(35_000, 60_000) : between(20_000, 35_000), random() < 0.5, false],
        ["unit tests", between(40_000, 75_000), false, true],
        ["e2e tests", project === "web" ? between(150_000, 260_000) : between(60_000, 120_000), false, true],
        ["docker push", between(8_000, 20_000), false, false],
    ];
    const rows: StepRow[] = [];
    let clock = start.getTime();
    let parallelEnd = clock;
    for (const [name, durationMs, cached, parallel] of plan) {
        const startedAt = parallel ? clock : Math.max(clock, parallelEnd);
        rows.push({ name, startedAt: new Date(startedAt), durationMs, cached, exitCode: 0 });
        if (parallel) parallelEnd = Math.max(parallelEnd, startedAt + durationMs);
        else clock = startedAt + durationMs;
    }
    return rows;
}

const pool = mysql.createPool({ uri: process.env.MYSQL_URL ?? "mysql://buildlog:buildlog@127.0.0.1/buildlog" });
const clickhouse = createClient({ url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123", database: process.env.CLICKHOUSE_DATABASE ?? "default" });
await AccountsRepo.migrate(pool);
const accounts = new AccountsRepo(pool);
const repo = new StepsRepo(clickhouse);
await repo.migrate();

const org = await accounts.createOrg("Acme", { includedMinutes: 6_000, overageCentsPerMinute: 1 });
const projects = { api: await accounts.createProject(org.id, "api"), web: await accounts.createProject(org.id, "web") };

const now = Date.now();
const builds: BuildReport[] = [];
for (const [key, project] of Object.entries(projects) as ["api" | "web", (typeof projects)["api"]][]) {
    for (let daysAgo = 20; daysAgo >= 0; daysAgo--) {
        const count = between(14, 26);
        for (let i = 0; i < count; i++) {
            const start = new Date(now - daysAgo * 86_400_000 - between(0, 10 * 3_600_000));
            builds.push({ orgId: org.id, projectId: project.id, buildId: `gh-${builds.length + 1000}-1`, gitRef: random() < 0.6 ? "main" : "feature", steps: steps(start, daysAgo, key) });
        }
    }
}
await repo.insertNew(builds);

const ci = await accounts.createToken({ orgId: org.id, projectId: projects.api.id, scopes: ["builds:write"], name: "api CI" });
const console_ = await accounts.createToken({ orgId: org.id, scopes: ["insights:read", "billing:read"], name: "console" });
console.log(`Seeded ${builds.length} builds for org ${org.id}`);
console.log(`  projects:      api=${projects.api.id} web=${projects.web.id}`);
console.log(`  CI token:      ${ci.token}   (builds:write, api only)`);
console.log(`  console token: ${console_.token}   (insights:read, billing:read)`);
await pool.end();
await clickhouse.close();
