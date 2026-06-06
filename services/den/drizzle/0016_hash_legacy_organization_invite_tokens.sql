UPDATE `organization_invite`
SET `token_hash` = SHA2(`token_hash`, 256)
WHERE `token_hash` NOT REGEXP '^[0-9a-f]{64}$';
