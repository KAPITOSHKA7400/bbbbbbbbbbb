// admin/db.js
import "dotenv/config";
import mysql from "mysql2/promise";

const {
  DB_HOST = "127.0.0.1",
  DB_PORT = "3306",
  DB_USER = "root",
  DB_PASSWORD = "",
  DB_NAME = "neurobot",
} = process.env;

export const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  namedPlaceholders: true,
});

export async function assertDb() {
  const conn = await pool.getConnection();
  try { await conn.query("SELECT 1"); } finally { conn.release(); }
}

/* ---------- helpers for schema upgrades ---------- */
async function columnExists(table, column) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = :db
        AND TABLE_NAME   = :table
        AND COLUMN_NAME  = :column`,
    { db: DB_NAME, table, column }
  );
  return (rows?.[0]?.cnt || 0) > 0;
}
async function addColumnIfMissing(table, column, columnDef) {
  if (!(await columnExists(table, column))) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN ${columnDef}`);
  }
}

export async function ensureSchema() {
  // users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      telegram_id BIGINT NOT NULL,
      username_tg VARCHAR(64) NULL DEFAULT NULL,
      vkvl TINYINT(1) NOT NULL DEFAULT 0,
      vkvl_page VARCHAR(64) NULL DEFAULT NULL,
      ai_all TINYINT(1) NOT NULL DEFAULT 1,
      ai_random TINYINT(1) NOT NULL DEFAULT 0,
      ai_mention TINYINT(1) NOT NULL DEFAULT 0,
      prompt TEXT NULL,
      negative_prompt TEXT NULL,
      registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_telegram_id (telegram_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  await addColumnIfMissing("users", "username_tg",      `username_tg VARCHAR(64) NULL DEFAULT NULL AFTER telegram_id`);
  await addColumnIfMissing("users", "vkvl",             `vkvl TINYINT(1) NOT NULL DEFAULT 0 AFTER username_tg`);
  await addColumnIfMissing("users", "vkvl_page",        `vkvl_page VARCHAR(64) NULL DEFAULT NULL AFTER vkvl`);
  await addColumnIfMissing("users", "ai_all",           `ai_all TINYINT(1) NOT NULL DEFAULT 1 AFTER vkvl_page`);
  await addColumnIfMissing("users", "ai_random",        `ai_random TINYINT(1) NOT NULL DEFAULT 0 AFTER ai_all`);
  await addColumnIfMissing("users", "ai_mention",       `ai_mention TINYINT(1) NOT NULL DEFAULT 0 AFTER ai_random`);
  await addColumnIfMissing("users", "prompt",           `prompt TEXT NULL AFTER ai_mention`);
  await addColumnIfMissing("users", "negative_prompt",  `negative_prompt TEXT NULL AFTER prompt`);

  // vkvl_token
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vkvl_token (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      accessToken   VARCHAR(512) NOT NULL,
      refreshToken  VARCHAR(512) NOT NULL,
      expiresAt     BIGINT UNSIGNED NOT NULL COMMENT 'Unix time в миллисекундах',
      clientId      CHAR(36) NOT NULL,
      created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_clientId (clientId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // chat_messages (как раньше)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id    VARCHAR(64)   NOT NULL,
      platform   VARCHAR(16)   NOT NULL,
      channel    VARCHAR(255)  NOT NULL,
      msg_id     VARCHAR(128)  NOT NULL,
      username   VARCHAR(255)  NOT NULL,
      message    TEXT          NOT NULL,
      response   TEXT,
      created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_platform_msg (platform, msg_id),
      KEY idx_platform_channel_created (platform, channel, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // chat_history — память диалога
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_history (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      platform   VARCHAR(16)   NOT NULL,
      channel    VARCHAR(255)  NOT NULL,
      role       ENUM('user','assistant') NOT NULL,
      user_id    VARCHAR(64)   NULL,
      username   VARCHAR(255)  NULL,
      message    TEXT          NOT NULL,
      created_at TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_pc_time (platform, channel, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  // llama4_adm
  await pool.query(`
    CREATE TABLE IF NOT EXISTS llama4_adm (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      account_id VARCHAR(64)  NOT NULL,
      api_token  VARCHAR(256) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_account_id (account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

/* ---------- users ---------- */
export async function ensureTelegramUser(telegramId, username = null) {
  if (!telegramId) return false;
  const [res] = await pool.execute(
    `INSERT INTO users (telegram_id, username_tg)
     VALUES (:telegram_id, :username)
     ON DUPLICATE KEY UPDATE
       username_tg = COALESCE(VALUES(username_tg), username_tg)`,
    { telegram_id: telegramId, username }
  );
  return res.affectedRows === 1;
}
export async function getUserByTelegramId(telegramId) {
  const [rows] = await pool.execute(
    `SELECT id, telegram_id, username_tg, vkvl, vkvl_page,
            ai_all, ai_random, ai_mention,
            prompt, negative_prompt,
            registered_at
       FROM users WHERE telegram_id = :id LIMIT 1`,
    { id: telegramId }
  );
  return rows[0] || null;
}
export async function setUserVkvl(telegramId, enabled, page = null) {
  await pool.execute(
    `UPDATE users
       SET vkvl = :vkvl,
           vkvl_page = COALESCE(:page, vkvl_page)
     WHERE telegram_id = :id`,
    { vkvl: enabled ? 1 : 0, page, id: telegramId }
  );
}
export async function clearUserVkvl(telegramId) {
  await pool.execute(
    `UPDATE users SET vkvl = 0, vkvl_page = NULL WHERE telegram_id = :id`,
    { id: telegramId }
  );
}
export async function setUserPrompt(telegramId, promptText) {
  await pool.execute(
    `UPDATE users SET prompt = :p WHERE telegram_id = :id`,
    { p: promptText || null, id: telegramId }
  );
}
export async function setUserNegativePrompt(telegramId, negativeText) {
  await pool.execute(
    `UPDATE users SET negative_prompt = :p WHERE telegram_id = :id`,
    { p: negativeText || null, id: telegramId }
  );
}
export async function getAllVkvlPages() {
  const [rows] = await pool.execute(
    `SELECT vkvl_page FROM users WHERE vkvl = 1 AND vkvl_page IS NOT NULL AND vkvl_page <> ''`
  );
  return rows.map(r => r.vkvl_page);
}

/* ---------- AI modes & prompts ---------- */
export async function setAiModeAll(telegramId) {
  await pool.execute(
    `UPDATE users SET ai_all = 1, ai_random = 0, ai_mention = 0 WHERE telegram_id = :id`,
    { id: telegramId }
  );
}
export async function toggleAiModeRandom(telegramId) {
  await pool.execute(
    `UPDATE users SET ai_all = 0, ai_random = 1 - ai_random WHERE telegram_id = :id`,
    { id: telegramId }
  );
}
export async function toggleAiModeMention(telegramId) {
  await pool.execute(
    `UPDATE users SET ai_all = 0, ai_mention = 1 - ai_mention WHERE telegram_id = :id`,
    { id: telegramId }
  );
}
export async function getAiModeForVkvlPage(page) {
  const [rows] = await pool.execute(
    `SELECT ai_all, ai_random, ai_mention
       FROM users
      WHERE vkvl = 1 AND LOWER(vkvl_page) = LOWER(:page)
      LIMIT 1`,
    { page }
  );
  if (!rows[0]) return { ai_all: 1, ai_random: 0, ai_mention: 0 };
  return rows[0];
}
export async function getPromptsForVkvlPage(page) {
  const [rows] = await pool.execute(
    `SELECT prompt, negative_prompt
       FROM users
      WHERE vkvl = 1 AND LOWER(vkvl_page) = LOWER(:page)
      LIMIT 1`,
    { page }
  );
  return rows[0] || { prompt: null, negative_prompt: null };
}

/* ---------- VKVL токены ---------- */
export async function upsertVkvlToken({ accessToken, refreshToken, expiresAt, clientId }) {
  const sql = `
    INSERT INTO vkvl_token (accessToken, refreshToken, expiresAt, clientId)
    VALUES (:accessToken, :refreshToken, :expiresAt, :clientId)
    ON DUPLICATE KEY UPDATE
      accessToken = VALUES(accessToken),
      refreshToken = VALUES(refreshToken),
      expiresAt   = VALUES(expiresAt),
      updated_at  = CURRENT_TIMESTAMP
  `;
  await pool.execute(sql, { accessToken, refreshToken, expiresAt, clientId });
}
export async function getVkvlToken(clientId) {
  const [rows] = await pool.execute(
    `SELECT accessToken, refreshToken, expiresAt, clientId
       FROM vkvl_token
      WHERE clientId = :clientId
      LIMIT 1`,
    { clientId }
  );
  return rows[0] || null;
}

/* ---------- Llama-4 креды ---------- */
export async function getLlama4Creds() {
  const [rows] = await pool.execute(
    `SELECT account_id, api_token
       FROM llama4_adm
   ORDER BY updated_at DESC, id DESC
      LIMIT 1`
  );
  return rows[0] || null;
}

/* ---------- Лог сообщений (для отчётности) ---------- */
export async function logChatMessage({
  user_id, platform, channel, msg_id, username, message, response,
}) {
  const sql = `
    INSERT INTO chat_messages
      (user_id, platform, channel, msg_id, username, message, response)
    VALUES
      (:user_id, :platform, :channel, :msg_id, :username, :message, :response)
    ON DUPLICATE KEY UPDATE
      response = VALUES(response),
      created_at = created_at
  `;
  await pool.execute(sql, { user_id, platform, channel, msg_id, username, message, response });
}

/* ---------- Память диалога ---------- */
export async function appendHistory({ platform, channel, role, user_id=null, username=null, message }) {
  await pool.execute(
    `INSERT INTO chat_history (platform, channel, role, user_id, username, message)
     VALUES (:platform, :channel, :role, :user_id, :username, :message)`,
    {
      platform,
      channel: String(channel || "").toLowerCase(), // нормализуем
      role,
      user_id,
      username,
      message,
    }
  );
}
export async function getRecentHistory({ platform, channel, limit = 20 }) {
  const lim = Math.max(1, Math.min(Number(limit) || 20, 50));
  const [rows] = await pool.execute(
    `SELECT id, role, username, message, created_at
       FROM chat_history
      WHERE platform = :platform
        AND LOWER(channel) = LOWER(:channel)
      ORDER BY id DESC
      LIMIT ${lim}`,
    { platform, channel }
  );
  // получаем последние N (новые→старые) и разворачиваем (старые→новые)
  return rows.reverse();
}
