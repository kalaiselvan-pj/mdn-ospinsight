import pg from "pg";
import dotenv from "dotenv";
import { ensureSchema, seedUser, pool } from "../server/db.js";
import { importData } from "./import-data.js";

dotenv.config();

const url = new URL(process.env.DATABASE_URL);
const database = url.pathname.replace(/^\//, "");
const adminUrl = new URL(process.env.DATABASE_URL);
adminUrl.pathname = "/postgres";

const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
if (!exists.rowCount) {
  await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(database)}`);
  console.log(`Created database ${database}`);
} else {
  console.log(`Database ${database} already exists`);
}
await admin.end();

await ensureSchema();
await seedUser();
const result = await importData();
console.log(`Setup complete. Features imported: ${result.imported}`);
await pool.end();
