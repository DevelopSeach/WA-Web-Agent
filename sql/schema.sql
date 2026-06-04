CREATE DATABASE IF NOT EXISTS wa_logger
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE wa_logger;

CREATE TABLE IF NOT EXISTS wa_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  message_uid VARCHAR(255) NOT NULL,
  event_type VARCHAR(100) NULL,
  source VARCHAR(120) NULL,
  chat_title VARCHAR(255) NULL,
  sender VARCHAR(255) NULL,
  direction VARCHAR(50) NULL,
  sent_at_text VARCHAR(100) NULL,
  captured_at DATETIME NULL,
  message_text LONGTEXT NULL,
  media_json JSON NULL,
  reactions_json JSON NULL,
  raw_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_message_uid (message_uid),
  KEY idx_chat_title (chat_title),
  KEY idx_sender (sender),
  KEY idx_created_at (created_at),
  KEY idx_event_type (event_type)
);

CREATE TABLE IF NOT EXISTS wa_commands (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  status ENUM('pending','running','done','failed') NOT NULL DEFAULT 'pending',
  action VARCHAR(100) NOT NULL,
  command_json JSON NOT NULL,
  result_json JSON NULL,
  error_text TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  picked_at DATETIME NULL,
  completed_at DATETIME NULL,
  KEY idx_status_created (status, created_at)
);
