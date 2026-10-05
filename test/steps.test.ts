import type { ClickHouseClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StepsRepo, type BuildReport, type StepRow } from "../src/analytics/StepsRepo.ts";
import { freshClickhouse, hasServices } from "./support.ts";

const NOW = new Date("2026-10-05T12:00:00Z");
const at = (iso: string) => new Date(iso);

function step(name: string, startedAt: string, durationMs: number, cached = false): StepRow {
    return { name, startedAt: at(startedAt), durationMs, cached, exitCode: 0 };
}

function build(buildId: string, steps: StepRow[], projectId = "prj_api", orgId = "org_acme"): BuildReport {
    return { orgId, projectId, buildId, gitRef: "main", steps };
}

describe.skipIf(!hasServices)("StepsRepo (ClickHouse)", () => {
    let ch: ClickHouseClient;
    let repo: StepsRepo;

    beforeAll(async () => {
        ch = await freshClickhouse();
        repo = new StepsRepo(ch);
        await repo.migrate();
    });

    beforeEach(async () => {
        await ch.command({ query: "TRUNCATE TABLE build_steps" });
    });

    afterAll(async () => {
        await ch.close();
    });

    it("computes per-step percentiles, cache hit rate and share of time", async () => {
        for (let i = 0; i < 20; i++) {
            await repo.insertBuild(
                build(`b${i}`, [
                    step("install", `2026-10-0${1 + (i % 4)}T10:00:00Z`, i < 15 ? 2_000 : 60_000, i < 15),
                    step("test", `2026-10-0${1 + (i % 4)}T10:01:00Z`, 30_000 + i * 1_000),
                ]),
            );
        }
        const { builds, steps } = await repo.stepStats("prj_api", 14, NOW);
        expect(builds).toBe(20);
        const [test, install] = steps;
        expect(test).toMatchObject({ name: "test", runs: 20, p50Ms: 40_000, p95Ms: 49_000, cacheHitRate: 0 });
        expect(install).toMatchObject({ name: "install", runs: 20, p50Ms: 2_000, p95Ms: 60_000, cacheHitRate: 0.75 });
        expect((test?.shareOfTime ?? 0) + (install?.shareOfTime ?? 0)).toBeCloseTo(1);
    });

    it("replaces a build that is reported again instead of double counting it", async () => {
        await repo.insertBuild(build("b1", [step("install", "2026-10-04T10:00:00Z", 1_000), step("test", "2026-10-04T10:00:01Z", 9_000)]));
        expect(await repo.hasBuild("prj_api", "b1")).toBe(true);
        await repo.insertBuild(build("b1", [step("install", "2026-10-04T10:00:00Z", 1_500)]));
        const { builds, steps } = await repo.stepStats("prj_api", 14, NOW);
        expect(builds).toBe(1);
        expect(steps).toEqual([expect.objectContaining({ name: "install", runs: 1, p50Ms: 1_500 })]);
    });

    it("keeps projects apart and respects the window", async () => {
        await repo.insertBuild(build("b1", [step("lint", "2026-10-04T10:00:00Z", 1_000)], "prj_api"));
        await repo.insertBuild(build("b2", [step("lint", "2026-10-04T10:00:00Z", 1_000)], "prj_web"));
        await repo.insertBuild(build("b3", [step("lint", "2026-08-01T10:00:00Z", 1_000)], "prj_api"));
        expect((await repo.stepStats("prj_api", 14, NOW)).builds).toBe(1);
        expect((await repo.stepStats("prj_api", 90, NOW)).builds).toBe(2);
    });

    it("uses wall-clock build time for trends, so parallel steps aren't counted twice", async () => {
        await repo.insertBuild(build("b1", [step("unit", "2026-10-04T10:00:00Z", 60_000), step("e2e", "2026-10-04T10:00:00Z", 90_000, true)]));
        await repo.insertBuild(build("b2", [step("unit", "2026-10-04T11:00:00Z", 30_000)]));
        await repo.insertBuild(build("b3", [step("unit", "2026-10-04T12:00:00Z", 20_000), step("e2e", "2026-10-04T12:00:20Z", 40_000)]));
        expect(await repo.trend("prj_api", 14, NOW)).toEqual([{ day: "2026-10-04", builds: 3, p50BuildMs: 60_000, p95BuildMs: 90_000, cacheHitRate: 0.2 }]);
    });

    it("rounds each build up to the minute for usage, per org and month", async () => {
        await repo.insertBuild(build("b1", [step("build", "2026-10-01T10:00:00Z", 61_000)]));
        await repo.insertBuild(build("b2", [step("build", "2026-10-01T12:00:00Z", 1_000)], "prj_web"));
        await repo.insertBuild(build("b3", [step("build", "2026-10-02T10:00:00Z", 120_000)]));
        await repo.insertBuild(build("b4", [step("build", "2026-09-30T23:59:00Z", 600_000)]));
        await repo.insertBuild(build("b5", [step("build", "2026-10-02T10:00:00Z", 60_000)], "prj_x", "org_other"));
        expect(await repo.dailyMinutes("org_acme", "2026-10")).toEqual([
            { day: "2026-10-01", builds: 2, buildMinutes: 3 },
            { day: "2026-10-02", builds: 1, buildMinutes: 2 },
        ]);
    });
});
