import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const client = new Client({ connectionString });
await client.connect();
try {
  await client.query("CREATE TABLE IF NOT EXISTS bp_schema_migration (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  const files = (await readdir(new URL("../migrations/", import.meta.url))).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    const applied = await client.query("SELECT 1 FROM bp_schema_migration WHERE name = $1", [name]);
    if (applied.rowCount) continue;
    const sql = await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO bp_schema_migration (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      process.stdout.write(`applied ${name}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.end();
}
