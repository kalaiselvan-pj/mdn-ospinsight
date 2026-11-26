import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function ensureSchema() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  await pool.query(`
    UPDATE features
    SET style = jsonb_build_object('kind', 'point', 'fill', '#FFFF00', 'stroke', '#000000', 'weight', 1)
    WHERE x_type = 'sp'
      AND (style->>'fill' IS NULL OR lower(style->>'fill') NOT IN ('#ffff00', '#ffe14d'))
  `);
}

export async function seedNetwork() {
  const existing = await pool.query("SELECT id FROM networks LIMIT 1");
  if (existing.rowCount) return;
  await pool.query(
    `INSERT INTO networks (name, designation, version, boundary)
     VALUES ('GPON', 'Production', '8.5.0.22', $1::jsonb)`,
    [JSON.stringify({
      type: "Polygon",
      coordinates: [[[73.50, 4.16], [73.58, 4.16], [73.58, 4.23], [73.50, 4.23], [73.50, 4.16]]]
    })]
  );
}

export async function seedUser() {
  const username = process.env.SEED_USER || "Medianet_Edit";
  const password = process.env.SEED_PASSWORD || "";
  if (!password) return;
  const existing = await pool.query("SELECT id FROM users WHERE username = $1", [username]);
  if (existing.rowCount) return;
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    "INSERT INTO users (username, display_name, password_hash) VALUES ($1, $2, $3)",
    [username, username, passwordHash]
  );
}

export async function logAction(username, action, detail = {}) {
  await pool.query(
    "INSERT INTO audit_log (username, action, detail) VALUES ($1, $2, $3::jsonb)",
    [username || "", action, JSON.stringify(detail)]
  );
}
