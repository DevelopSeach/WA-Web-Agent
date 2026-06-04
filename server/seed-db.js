import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "wa_logger"
});

await connection.execute(
  `INSERT INTO wa_commands (action, status, command_json)
   SELECT ?, ?, CAST(? AS JSON)
   WHERE NOT EXISTS (
     SELECT 1 FROM wa_commands WHERE action = ? AND status = ?
   )`,
  [
    "get_state",
    "done",
    JSON.stringify({
      action: "get_state",
      seeded: true,
      note: "Idempotent seed command to verify DB wiring"
    }),
    "get_state",
    "done"
  ]
);

await connection.end();
console.log("Database seed completed");
