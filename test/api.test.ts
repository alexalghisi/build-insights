import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ClickHouseClient } from "@clickhouse/client";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import type { Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountsRepo } from "../src/accounts/AccountsRepo.ts";
import { StepsRepo } from "../src/analytics/StepsRepo.ts";
import { REQUIRED_SCOPE } from "../src/api/auth.ts";
import { IngestService } from "../src/gen/buildinsights/v1/ingest_pb.ts";
import { InsightsService } from "../src/gen/buildinsights/v1/insights_pb.ts";
import { UsageService } from "../src/gen/buildinsights/v1/usage_pb.ts";
import { createApiServer } from "../src/server.ts";
import { freshClickhouse, freshMysql, hasServices } from "./support.ts";

const NOW = new Date("2026-10-05T12:00:00Z");

describe("access policy", () => {
    it("covers every RPC of every service", () => {
        const rpcs = [IngestService, InsightsService, UsageService].flatMap((s) => s.methods.map((m) => `${s.typeName}.${m.name}`));
        expect(Object.keys(REQUIRED_SCOPE).sort()).toEqual(rpcs.sort());
    });
});

async function code(promise: Promise<unknown>): Promise<Code | "ok"> {
    try {
        await promise;
        return "ok";
    } catch (error) {
        return ConnectError.from(error).code;
    }
}

describe.skipIf(!hasServices)("Connect API", () => {
    let pool: Pool;
    let ch: ClickHouseClient;
    let server: Server;
    let baseUrl: string;
    let accounts: AccountsRepo;
    const ids = { org: "", otherOrg: "", api: "", web: "", foreign: "" };
    const tokens = { ciApi: "", reader: "", billing: "", readerApiOnly: "", otherOrgReader: "" };

    beforeAll(async () => {
        pool = await freshMysql();
        await AccountsRepo.migrate(pool);
        accounts = new AccountsRepo(pool);
        ch = await freshClickhouse("buildlog_test_api");
        const steps = new StepsRepo(ch);
        await steps.migrate();

        const org = await accounts.createOrg("Acme", { includedMinutes: 2, overageCentsPerMinute: 5 });
        const other = await accounts.createOrg("Globex", { includedMinutes: 100, overageCentsPerMinute: 5 });
        ids.org = org.id;
        ids.otherOrg = other.id;
        ids.api = (await accounts.createProject(org.id, "api")).id;
        ids.web = (await accounts.createProject(org.id, "web")).id;
        ids.foreign = (await accounts.createProject(other.id, "secret")).id;
        tokens.ciApi = (await accounts.createToken({ orgId: org.id, projectId: ids.api, scopes: ["builds:write"], name: "ci" })).token;
        tokens.reader = (await accounts.createToken({ orgId: org.id, scopes: ["insights:read"], name: "console" })).token;
        tokens.billing = (await accounts.createToken({ orgId: org.id, scopes: ["billing:read", "insights:read"], name: "finance" })).token;
        tokens.readerApiOnly = (await accounts.createToken({ orgId: org.id, projectId: ids.api, scopes: ["insights:read", "billing:read"], name: "api team" })).token;
        tokens.otherOrgReader = (await accounts.createToken({ orgId: other.id, scopes: ["insights:read", "builds:write"], name: "globex" })).token;

        server = createApiServer({ accounts, steps, now: () => NOW, corsOrigin: "http://console.test" });
        await new Promise<void>((resolve) => server.listen(0, resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        server?.close();
        await pool?.end();
        await ch?.close();
    });

    function clients(token?: string) {
        const auth: Interceptor = (next) => (req) => {
            if (token !== undefined) req.header.set("authorization", `Bearer ${token}`);
            return next(req);
        };
        const transport = createConnectTransport({ baseUrl, httpVersion: "1.1", interceptors: [auth] });
        return { ingest: createClient(IngestService, transport), insights: createClient(InsightsService, transport), usage: createClient(UsageService, transport) };
    }

    const step = (name: string, iso: string, durationMs: number, cached = false) => ({ name, startedAt: timestampFromDate(new Date(iso)), durationMs, cached });

    it("ingests a build and reports where the time goes", async () => {
        const first = await clients(tokens.ciApi).ingest.reportBuild({
            projectId: ids.api,
            buildId: "gh-1001",
            gitRef: "main",
            steps: [step("install", "2026-10-04T10:00:00Z", 3_000, true), step("test", "2026-10-04T10:00:03Z", 45_000)],
        });
        expect(first).toMatchObject({ acceptedSteps: 2, replaced: false });
        const retry = await clients(tokens.ciApi).ingest.reportBuild({ projectId: ids.api, buildId: "gh-1001", steps: [step("install", "2026-10-04T10:00:00Z", 3_000, true), step("test", "2026-10-04T10:00:03Z", 45_000)] });
        expect(retry.replaced).toBe(true);

        const stats = await clients(tokens.reader).insights.getStepStats({ projectId: ids.api });
        expect(stats.builds).toBe(1);
        expect(stats.steps.map((s) => [s.name, s.p50Ms, s.cacheHitRate])).toEqual([
            ["test", 45_000, 0],
            ["install", 3_000, 1],
        ]);
    });

    it("requires a valid token", async () => {
        expect(await code(clients().insights.listProjects({}))).toBe(Code.Unauthenticated);
        expect(await code(clients("bi_not-a-real-token-at-all-000000000").insights.listProjects({}))).toBe(Code.Unauthenticated);
    });

    it("enforces scopes per RPC", async () => {
        expect(await code(clients(tokens.ciApi).insights.getStepStats({ projectId: ids.api }))).toBe(Code.PermissionDenied);
        expect(await code(clients(tokens.reader).ingest.reportBuild({ projectId: ids.api, buildId: "x", steps: [step("a", "2026-10-04T10:00:00Z", 1)] }))).toBe(
            Code.PermissionDenied,
        );
        expect(await code(clients(tokens.reader).usage.getUsage({ orgId: ids.org, month: "2026-10" }))).toBe(Code.PermissionDenied);
    });

    it("keeps tenants and project-scoped tokens apart", async () => {
        expect(await code(clients(tokens.otherOrgReader).insights.getStepStats({ projectId: ids.api }))).toBe(Code.NotFound);
        expect(await code(clients(tokens.otherOrgReader).ingest.reportBuild({ projectId: ids.api, buildId: "evil", steps: [step("a", "2026-10-04T10:00:00Z", 1)] }))).toBe(
            Code.NotFound,
        );
        expect(await code(clients(tokens.ciApi).ingest.reportBuild({ projectId: ids.web, buildId: "b", steps: [step("a", "2026-10-04T10:00:00Z", 1)] }))).toBe(
            Code.NotFound,
        );
        expect((await clients(tokens.readerApiOnly).insights.listProjects({})).projects.map((p) => p.name)).toEqual(["api"]);
        expect((await clients(tokens.reader).insights.listProjects({})).projects.map((p) => p.name)).toEqual(["api", "web"]);
    });

    it("explains every problem with an invalid report", async () => {
        const error = await clients(tokens.ciApi)
            .ingest.reportBuild({
                projectId: ids.api,
                buildId: "has spaces",
                steps: [{ name: "", durationMs: 90_000_000 }, step("ancient", "2026-01-01T00:00:00Z", 1)],
            })
            .catch((e: unknown) => ConnectError.from(e));
        expect(error).toBeInstanceOf(ConnectError);
        expect((error as ConnectError).code).toBe(Code.InvalidArgument);
        expect((error as ConnectError).rawMessage).toBe(
            "Invalid build report: build_id: 1-128 characters from A-Z a-z 0-9 . _ : -; steps[0].name: 1-200 characters; steps[0].duration_ms: at most 86400000; steps[0].started_at: required; steps[1].started_at: older than the 90-day retention",
        );
    });

    it("bills build minutes beyond the plan, for org-wide billing tokens only", async () => {
        await clients(tokens.ciApi).ingest.reportBuild({ projectId: ids.api, buildId: "gh-2001", steps: [step("build", "2026-10-02T09:00:00Z", 125_000)] });
        const usage = await clients(tokens.billing).usage.getUsage({ orgId: ids.org, month: "2026-10" });
        expect(usage).toMatchObject({ buildMinutes: 4, includedMinutes: 2, overageMinutes: 2, overageCents: 10 });
        expect(usage.days.map((d) => [d.day, d.buildMinutes])).toEqual([
            ["2026-10-02", 3],
            ["2026-10-04", 1],
        ]);
        expect(await code(clients(tokens.billing).usage.getUsage({ orgId: ids.otherOrg, month: "2026-10" }))).toBe(Code.NotFound);
        expect(await code(clients(tokens.readerApiOnly).usage.getUsage({ orgId: ids.org, month: "2026-10" }))).toBe(Code.PermissionDenied);
        expect(await code(clients(tokens.billing).usage.getUsage({ orgId: ids.org, month: "October" }))).toBe(Code.InvalidArgument);
    });

    it("answers CORS preflights only for the console's origin", async () => {
        const preflight = (origin: string) =>
            fetch(`${baseUrl}/buildinsights.v1.InsightsService/ListProjects`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
        const allowed = await preflight("http://console.test");
        expect(allowed.status).toBe(204);
        expect(allowed.headers.get("access-control-allow-origin")).toBe("http://console.test");
        expect((await preflight("http://evil.test")).headers.get("access-control-allow-origin")).toBeNull();
    });
});
