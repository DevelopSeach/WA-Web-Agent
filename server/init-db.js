import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.resolve(__dirname, "../sql/schema.sql");
const databaseName = process.env.MYSQL_DATABASE || "wa_logger";
const appUser = process.env.MYSQL_USER || "root";
const appPassword = process.env.MYSQL_PASSWORD || "";
const adminUser = process.env.DB_MACHINE_ROOT_USER || process.env.MYSQL_ROOT_USER || process.env.DB_ROOT_USER || appUser;
const adminPassword = process.env.DB_MACHINE_ROOT_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || process.env.DB_ROOT_PASSWORD || appPassword;
const useAdminCredentials = Boolean(process.env.DB_MACHINE_ROOT_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || process.env.DB_ROOT_PASSWORD);
const sql = fs.readFileSync(schemaPath, "utf8").replaceAll("wa_logger", databaseName);

const conn = await mysql.createConnection({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: useAdminCredentials ? adminUser : appUser,
  password: useAdminCredentials ? adminPassword : appPassword,
  multipleStatements: true
});

await conn.query(sql);

if (useAdminCredentials && appUser) {
  const hosts = ["localhost", "127.0.0.1", "::1", "%"];
  for (const host of hosts) {
    await conn.query(`CREATE USER IF NOT EXISTS ${mysql.escapeId(appUser)}@${mysql.escape(host)} IDENTIFIED BY ${mysql.escape(appPassword)}`);
    await conn.query(`ALTER USER ${mysql.escapeId(appUser)}@${mysql.escape(host)} IDENTIFIED BY ${mysql.escape(appPassword)}`);
    await conn.query(`GRANT ALL PRIVILEGES ON ${mysql.escapeId(databaseName)}.* TO ${mysql.escapeId(appUser)}@${mysql.escape(host)}`);
  }
  await conn.query(`FLUSH PRIVILEGES`);
}

await conn.end();
console.log("Database initialized");
