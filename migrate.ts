import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf-8");
  console.log("Applico schema.sql al database...");
  await pool.query(sql);
  console.log("Migrazione completata.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Errore durante la migrazione:", err);
  process.exit(1);
});
