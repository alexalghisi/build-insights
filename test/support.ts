import { createClient, type ClickHouseClient } from "@clickhouse/client";
import mysql from "mysql2/promise";

export const MYSQL_URL = process.env.BUILD_INSIGHTS_TEST_MYSQL_URL;
export const CLICKHOUSE_URL = process.env.BUILD_INSIGHTS_TEST_CLICKHOUSE_URL;
export const hasMysql = MYSQL_URL !== undefined;
export const hasServices = MYSQL_URL !== undefined && CLICKHOUSE_URL !== undefined;

export async function freshMysql(): Promise<mysql.Pool> {
    const pool = mysql.createPool({ uri: MYSQL_URL ?? "", connectionLimit: 10 });
    for (const table of ["api_tokens", "projects", "orgs"]) await pool.query(`DROP TABLE IF EXISTS ${table}`);
    return pool;
}

export async function freshClickhouse(database = "buildlog_test"): Promise<ClickHouseClient> {
    const admin = createClient({ url: CLICKHOUSE_URL ?? "" });
    await admin.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await admin.command({ query: `CREATE DATABASE ${database}` });
    await admin.close();
    return createClient({ url: CLICKHOUSE_URL ?? "", database });
}
