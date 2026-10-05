export const SCOPES = ["builds:write", "insights:read", "billing:read"] as const;
export type Scope = (typeof SCOPES)[number];

export function isScope(value: string): value is Scope {
    return (SCOPES as readonly string[]).includes(value);
}

/** Who is calling: resolved from an API token. */
export interface Principal {
    readonly tokenId: string;
    readonly orgId: string;
    /** Set when the token is limited to one project. */
    readonly projectId: string | null;
    readonly scopes: ReadonlySet<Scope>;
}

export interface ProjectRef {
    readonly id: string;
    readonly orgId: string;
}

export function canAccessProject(principal: Principal, project: ProjectRef): boolean {
    return project.orgId === principal.orgId && (principal.projectId === null || principal.projectId === project.id);
}
