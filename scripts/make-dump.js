import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";

dotenv.config();

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sqlPath = path.join(root, "db", "medianet_ospinsight.sql");
const gzPath = path.join(root, "db", "medianet_ospinsight.sql.gz");
const url = new URL(process.env.DATABASE_URL || "");
const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
if (!database) {
  console.error("Set DATABASE_URL in .env before creating a dump.");
  process.exit(1);
}

fs.mkdirSync(path.dirname(sqlPath), { recursive: true });
const pgDump = findTool("pg_dump");
await new Promise((resolve, reject) => {
  const child = spawn(pgDump, [
    "-h", url.hostname,
    "-p", url.port || "5432",
    "-U", decodeURIComponent(url.username),
    "-d", database,
    "--no-owner",
    "--no-acl",
    "--clean",
    "--if-exists",
    "--format=p",
    "--file", sqlPath
  ], {
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password) },
    stdio: "inherit"
  });
  child.on("error", reject);
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited with code ${code}`))));
});

const text = fs.readFileSync(sqlPath, "utf8")
  .split(/\r?\n/)
  .filter((line) => !line.startsWith("\\restrict ") && !line.startsWith("\\unrestrict ") && line !== "SET transaction_timeout = 0;")
  .join("\n");
await pipeline(Readable.from([text]), createGzip({ level: 9 }), fs.createWriteStream(gzPath));
fs.unlinkSync(sqlPath);
const size = fs.statSync(gzPath).size;
console.log(`Wrote ${gzPath} (${Math.round(size / 1024 / 1024)} MB)`);

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
