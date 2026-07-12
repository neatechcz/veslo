CREATE TABLE IF NOT EXISTS `platform_model_policy` (
  `id` varchar(32) NOT NULL PRIMARY KEY,
  `enabled_models_json` text NOT NULL,
  `active_provider` varchar(64) NOT NULL,
  `active_model` varchar(128) NOT NULL,
  `created_at` timestamp(3) NOT NULL,
  `updated_at` timestamp(3) NOT NULL
);
