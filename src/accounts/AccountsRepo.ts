import { readFile } from "node:fs/promises";
import type { Pool, RowDataPacket } from "mysql2/promise";
import { isScope, type Principal, type Scope } from "./principal.ts";
import { generateToken, hashToken, looksLikeToken, newId } from "./tokens.ts";

export interface Org {
    readonly id: string;
    readonly name: string;
    readonly includedMinutes: number;
    readonly overageCentsPerMinute: number;
}

export interface Project {
    readonly id: string;
    readonly orgId: string;
    readonly name: string;
}

export class AccountsRepo {
    readonly #pool: Pool;

    constructor(pool: Pool) {
        this.#pool = pool;
    }

    static async migrate(pool: Pool): Promise<void> {
        const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
        for (const statement of sql.split(";").map((s) => s.trim()).filter((s) => s && !s.split("\n").every((l) => l.startsWith("--")))) {
            await pool.query(statement);
        }
    }

    async createOrg(name: string, plan: { includedMinutes: number; overageCentsPerMinute: number }): Promise<Org> {
        const org = { id: newId("org"), name, ...plan };
        await this.#pool.execute("INSERT INTO orgs (id, name, included_minutes, overage_cents_per_minute) VALUES (?, ?, ?, ?)", [
            org.id,
            name,
            plan.includedMinutes,
            plan.overageCentsPerMinute,
        ]);
        return org;
    }

    async createProject(orgId: string, name: string): Promise<Project> {
        if ((await this.org(orgId)) === undefined) throw new Error(`Org ${orgId} does not exist`);
        const project = { id: newId("prj"), orgId, name };
        await this.#pool.execute("INSERT INTO projects (id, org_id, name) VALUES (?, ?, ?)", [project.id, orgId, name]);
        return project;
    }

    /** Returns the plaintext token. It is shown once and never stored. */
    async createToken(input: { orgId: string; projectId?: string; scopes: readonly Scope[]; name: string }): Promise<{ id: string; token: string }> {
        if (input.projectId !== undefined) {
            const project = await this.project(input.projectId);
            if (project?.orgId !== input.orgId) throw new Error(`Project ${input.projectId} does not belong to ${input.orgId}`);
        }
        const id = newId("tok");
        const token = generateToken();
        await this.#pool.execute("INSERT INTO api_tokens (id, token_hash, org_id, project_id, scopes, name) VALUES (?, ?, ?, ?, ?, ?)", [
            id,
            hashToken(token),
            input.orgId,
            input.projectId ?? null,
            [...new Set(input.scopes)].join(","),
            input.name,
        ]);
        return { id, token };
    }

    async authenticate(token: string): Promise<Principal | undefined> {
        if (!looksLikeToken(token)) return undefined;
        const [rows] = await this.#pool.execute<RowDataPacket[]>(
            "SELECT id, org_id, project_id, scopes FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL",
            [hashToken(token)],
        );
        const row = rows[0];
        if (row === undefined) return undefined;
        void this.#pool.execute("UPDATE api_tokens SET last_used_at = CURRENT_TIMESTAMP(3) WHERE id = ?", [row.id]).catch(() => {});
        return {
            tokenId: String(row.id),
            orgId: String(row.org_id),
            projectId: row.project_id === null ? null : String(row.project_id),
            scopes: new Set(String(row.scopes).split(",").filter(isScope)),
        };
    }

    async revokeToken(id: string): Promise<void> {
        await this.#pool.execute("UPDATE api_tokens SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ? AND revoked_at IS NULL", [id]);
    }

    async org(id: string): Promise<Org | undefined> {
        const [rows] = await this.#pool.execute<RowDataPacket[]>("SELECT id, name, included_minutes, overage_cents_per_minute FROM orgs WHERE id = ?", [id]);
        const row = rows[0];
        return row && { id: row.id, name: row.name, includedMinutes: row.included_minutes, overageCentsPerMinute: row.overage_cents_per_minute };
    }

    async project(id: string): Promise<Project | undefined> {
        const [rows] = await this.#pool.execute<RowDataPacket[]>("SELECT id, org_id, name FROM projects WHERE id = ?", [id]);
        const row = rows[0];
        return row && { id: row.id, orgId: row.org_id, name: row.name };
    }

    async projects(orgId: string): Promise<Project[]> {
        const [rows] = await this.#pool.execute<RowDataPacket[]>("SELECT id, org_id, name FROM projects WHERE org_id = ? ORDER BY name", [orgId]);
        return rows.map((row) => ({ id: row.id, orgId: row.org_id, name: row.name }));
    }
}
