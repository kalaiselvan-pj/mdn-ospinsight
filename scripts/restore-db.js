import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dumpPath = path.join(root, "db", "medianet_ospinsight.sql.gz");

if (!process.env.DATABASE_URL) {
  console.error("Copy .env.example to .env and set DATABASE_URL to your local PostgreSQL database.");
  process.exit(1);
}
if (!fs.existsSync(dumpPath)) {
  console.error(`Database dump not found: ${dumpPath}`);
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL);
const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (!database || database === "postgres") {
  console.error("DATABASE_URL must name an application database, for example medianet_ospinsight.");
  process.exit(1);
}

const adminUrl = new URL(process.env.DATABASE_URL);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
if (!exists.rowCount) {
  await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(database)}`);
  console.log(`Created database ${database}`);
} else {
  console.log(`Restoring into existing database ${database}`);
}
await admin.end();

const psql = findTool("psql");
console.log("Loading the network into your local database.");
await new Promise((resolve, reject) => {
  const child = spawn(psql, ["-d", process.env.DATABASE_URL, "-v", "ON_ERROR_STOP=1"], {
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
    stdio: ["pipe", "inherit", "inherit"]
  });
  const input = createReadStream(dumpPath).pipe(createGunzip());
  input.pipe(child.stdin);
  input.on("error", reject);
  child.on("error", (error) => {
    if (error.code === "ENOENT") {
      reject(new Error("psql was not found. Install PostgreSQL and run this again."));
      return;
    }
    reject(error);
  });
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`psql exited with code ${code}`))));
});
console.log("Restore complete. Run npm start and open http://localhost:8080");

function findTool(name) {
  if (process.platform === "win32") {
    const base = "C:\\Program Files\\PostgreSQL";
    if (fs.existsSync(base)) {
      const versions = fs.readdirSync(base).sort().reverse();
      for (const version of versions) {
        const candidate = path.join(base, version, "bin", `${name}.exe`);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return name;
}
