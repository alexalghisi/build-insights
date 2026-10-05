import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import type { AccountsRepo } from "../accounts/AccountsRepo.ts";
import type { StepsRepo } from "../analytics/StepsRepo.ts";
import { bill, isMonth } from "../billing.ts";
import { IngestService } from "../gen/buildinsights/v1/ingest_pb.ts";
import { InsightsService } from "../gen/buildinsights/v1/insights_pb.ts";
import { UsageService } from "../gen/buildinsights/v1/usage_pb.ts";
import { principalOf, requireProject } from "./auth.ts";
import { validateReport } from "./validation.ts";

export interface Deps {
    readonly accounts: AccountsRepo;
    readonly steps: StepsRepo;
    readonly now?: () => Date;
}

function windowDays(value: number): number {
    if (value === 0) return 14;
    if (value > 90) throw new ConnectError("window_days: 1-90", Code.InvalidArgument);
    return value;
}

export function routes({ accounts, steps, now = () => new Date() }: Deps) {
    return (router: ConnectRouter) => {
        router.service(IngestService, {
            async reportBuild(req, context) {
                const principal = principalOf(context);
                const project = await requireProject(accounts, principal, req.projectId);
                const rows = validateReport(req, now());
                const replaced = await steps.hasBuild(project.id, req.buildId);
                await steps.insertBuild({ orgId: project.orgId, projectId: project.id, buildId: req.buildId, gitRef: req.gitRef, steps: rows }, { replacing: replaced });
                return { acceptedSteps: rows.length, replaced };
            },
        });

        router.service(InsightsService, {
            async listProjects(_req, context) {
                const principal = principalOf(context);
                const projects = await accounts.projects(principal.orgId);
                return { projects: projects.filter((p) => principal.projectId === null || p.id === principal.projectId) };
            },
            async getStepStats(req, context) {
                const project = await requireProject(accounts, principalOf(context), req.projectId);
                return steps.stepStats(project.id, windowDays(req.windowDays), now());
            },
            async getTrend(req, context) {
                const project = await requireProject(accounts, principalOf(context), req.projectId);
                return { days: await steps.trend(project.id, windowDays(req.windowDays), now()) };
            },
        });

        router.service(UsageService, {
            async getUsage(req, context) {
                const principal = principalOf(context);
                if (req.orgId !== principal.orgId) throw new ConnectError(`Org ${req.orgId} not found`, Code.NotFound);
                if (principal.projectId !== null) throw new ConnectError("Usage is org-wide; use a token that isn't limited to a project", Code.PermissionDenied);
                if (!isMonth(req.month)) throw new ConnectError("month: expected YYYY-MM", Code.InvalidArgument);
                const org = await accounts.org(principal.orgId);
                if (org === undefined) throw new ConnectError(`Org ${req.orgId} not found`, Code.NotFound);
                const days = await steps.dailyMinutes(org.id, req.month);
                const total = days.reduce((sum, d) => sum + d.buildMinutes, 0);
                return { ...bill(total, org), days };
            },
        });
    };
}
