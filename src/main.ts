import { createClient } from "@clickhouse/client";
import mysql from "mysql2/promise";
import { AccountsRepo } from "./accounts/AccountsRepo.ts";
import { StepsRepo } from "./analytics/StepsRepo.ts";
import { createApiServer } from "./server.ts";

const env = (name: string, fallback?: string) => {
    const value = process.env[name] ?? fallback;
    if (value === undefined) throw new Error(`${name} is not set`);
    return value;
};

const pool = mysql.createPool({ uri: env("MYSQL_URL"), connectionLimit: 20 });
const clickhouse = createClient({ url: env("CLICKHOUSE_URL"), database: env("CLICKHOUSE_DATABASE", "default") });
await AccountsRepo.migrate(pool);
const steps = new StepsRepo(clickhouse);
await steps.migrate();

const port = Number(env("PORT", "8080"));
const corsOrigin = process.env.CORS_ORIGIN;
createApiServer({ accounts: new AccountsRepo(pool), steps, ...(corsOrigin ? { corsOrigin } : {}) }).listen(port, () => {
    console.log(`build-insights API listening on :${port}`);
});
