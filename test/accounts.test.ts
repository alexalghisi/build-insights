import type { Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountsRepo } from "../src/accounts/AccountsRepo.ts";
import { canAccessProject } from "../src/accounts/principal.ts";
import { generateToken, hashToken, looksLikeToken } from "../src/accounts/tokens.ts";
import { freshMysql, hasMysql } from "./support.ts";

describe("tokens", () => {
    it("are prefixed, random and hashed", () => {
        const a = generateToken();
        expect(looksLikeToken(a)).toBe(true);
        expect(a).not.toBe(generateToken());
        expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    });
});

describe("canAccessProject", () => {
    const principal = { tokenId: "t", orgId: "org_a", projectId: null, scopes: new Set<never>() };
    it("allows org-wide tokens on every project of the org, and nothing else", () => {
        expect(canAccessProject(principal, { id: "p1", orgId: "org_a" })).toBe(true);
        expect(canAccessProject(principal, { id: "p9", orgId: "org_b" })).toBe(false);
    });
    it("limits project tokens to their project", () => {
        expect(canAccessProject({ ...principal, projectId: "p1" }, { id: "p1", orgId: "org_a" })).toBe(true);
        expect(canAccessProject({ ...principal, projectId: "p1" }, { id: "p2", orgId: "org_a" })).toBe(false);
    });
});

describe.skipIf(!hasMysql)("AccountsRepo (MySQL)", () => {
    let pool: Pool;
    let repo: AccountsRepo;

    beforeAll(async () => {
        pool = await freshMysql();
        await AccountsRepo.migrate(pool);
        repo = new AccountsRepo(pool);
    });

    afterAll(async () => {
        await pool.end();
    });

    it("authenticates tokens by hash and never stores the plaintext", async () => {
        const org = await repo.createOrg("Acme", { includedMinutes: 500, overageCentsPerMinute: 4 });
        const project = await repo.createProject(org.id, "api");
        const { id, token } = await repo.createToken({ orgId: org.id, projectId: project.id, scopes: ["builds:write", "builds:write"], name: "ci" });
        const principal = await repo.authenticate(token);
        expect(principal).toMatchObject({ tokenId: id, orgId: org.id, projectId: project.id });
        expect([...(principal?.scopes ?? [])]).toEqual(["builds:write"]);
        const [rows] = await pool.query("SELECT * FROM api_tokens WHERE id = ?", [id]);
        expect(JSON.stringify(rows)).not.toContain(token);
    });

    it("rejects unknown, malformed and revoked tokens", async () => {
        const org = await repo.createOrg("Globex", { includedMinutes: 500, overageCentsPerMinute: 4 });
        const { id, token } = await repo.createToken({ orgId: org.id, scopes: ["insights:read"], name: "dashboard" });
        expect(await repo.authenticate(generateToken())).toBeUndefined();
        expect(await repo.authenticate("' OR 1=1 --")).toBeUndefined();
        await repo.revokeToken(id);
        expect(await repo.authenticate(token)).toBeUndefined();
    });

    it("refuses project tokens for another org's project", async () => {
        const a = await repo.createOrg("A", { includedMinutes: 0, overageCentsPerMinute: 0 });
        const b = await repo.createOrg("B", { includedMinutes: 0, overageCentsPerMinute: 0 });
        const project = await repo.createProject(b.id, "web");
        await expect(repo.createToken({ orgId: a.id, projectId: project.id, scopes: ["builds:write"], name: "x" })).rejects.toThrow(/does not belong/);
    });

    it("lists an org's projects by name", async () => {
        const org = await repo.createOrg("Initech", { includedMinutes: 0, overageCentsPerMinute: 0 });
        await repo.createProject(org.id, "web");
        await repo.createProject(org.id, "api");
        expect((await repo.projects(org.id)).map((p) => p.name)).toEqual(["api", "web"]);
    });
});
