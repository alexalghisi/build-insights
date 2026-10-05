import { Code, ConnectError, createContextKey, type HandlerContext, type Interceptor } from "@connectrpc/connect";
import type { AccountsRepo, Project } from "../accounts/AccountsRepo.ts";
import { canAccessProject, type Principal, type Scope } from "../accounts/principal.ts";

/** The scope each RPC needs. An RPC missing from this table is refused, so new endpoints are closed by default. */
export const REQUIRED_SCOPE: Readonly<Record<string, Scope>> = {
    "buildinsights.v1.IngestService.ReportBuild": "builds:write",
    "buildinsights.v1.InsightsService.ListProjects": "insights:read",
    "buildinsights.v1.InsightsService.GetStepStats": "insights:read",
    "buildinsights.v1.InsightsService.GetTrend": "insights:read",
    "buildinsights.v1.UsageService.GetUsage": "billing:read",
};

const principalKey = createContextKey<Principal | undefined>(undefined, { description: "authenticated caller" });

export function authInterceptor(accounts: Pick<AccountsRepo, "authenticate">): Interceptor {
    return (next) => async (req) => {
        const rpc = `${req.service.typeName}.${req.method.name}`;
        const scope = REQUIRED_SCOPE[rpc];
        if (scope === undefined) throw new ConnectError(`No access policy is defined for ${rpc}`, Code.PermissionDenied);
        const token = /^Bearer (\S+)$/.exec(req.header.get("authorization") ?? "")?.[1];
        if (token === undefined) throw new ConnectError("Missing API token: send it as 'Authorization: Bearer <token>'", Code.Unauthenticated);
        const principal = await accounts.authenticate(token);
        if (principal === undefined) throw new ConnectError("Invalid or revoked API token", Code.Unauthenticated);
        if (!principal.scopes.has(scope)) throw new ConnectError(`This token doesn't have the ${scope} scope`, Code.PermissionDenied);
        req.contextValues.set(principalKey, principal);
        return next(req);
    };
}

export function principalOf(context: HandlerContext): Principal {
    const principal = context.values.get(principalKey);
    if (principal === undefined) throw new ConnectError("Request was not authenticated", Code.Unauthenticated);
    return principal;
}

/** Projects of other orgs are reported as not found, so ids can't be probed across tenants. */
export async function requireProject(accounts: Pick<AccountsRepo, "project">, principal: Principal, projectId: string): Promise<Project> {
    if (projectId === "") throw new ConnectError("project_id is required", Code.InvalidArgument);
    const project = await accounts.project(projectId);
    if (project === undefined || !canAccessProject(principal, project)) throw new ConnectError(`Project ${projectId} not found`, Code.NotFound);
    return project;
}
