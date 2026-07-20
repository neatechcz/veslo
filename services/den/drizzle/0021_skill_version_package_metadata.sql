ALTER TABLE `skill_versions` ADD `package_metadata_json` longtext;
--> statement-breakpoint
UPDATE `skill_versions` AS version
JOIN `skills` AS skill ON skill.`id` = version.`skill_id`
SET version.`package_metadata_json` = CASE skill.`name`
  WHEN 'veslo-docx' THEN JSON_OBJECT(
    'name', 'veslo-docx',
    'description', 'Create, edit, analyze, convert, and validate Word DOCX documents using standard skill execution.',
    'tags', JSON_ARRAY('documents', 'docx', 'office', 'platform-core'),
    'language', 'en'
  )
  WHEN 'veslo-pdf' THEN JSON_OBJECT(
    'name', 'veslo-pdf',
    'description', 'Extract, create, merge, split, annotate, fill forms, and validate PDF documents using standard skill execution.',
    'tags', JSON_ARRAY('documents', 'pdf', 'office', 'platform-core'),
    'language', 'en'
  )
  WHEN 'veslo-pptx' THEN JSON_OBJECT(
    'name', 'veslo-pptx',
    'description', 'Create, edit, analyze, and visually validate PowerPoint PPTX presentations using standard skill execution.',
    'tags', JSON_ARRAY('presentations', 'pptx', 'office', 'platform-core'),
    'language', 'en'
  )
  WHEN 'veslo-xlsx' THEN JSON_OBJECT(
    'name', 'veslo-xlsx',
    'description', 'Create, edit, analyze, recalculate, and validate Excel XLSX workbooks using standard skill execution.',
    'tags', JSON_ARRAY('spreadsheets', 'xlsx', 'office', 'platform-core'),
    'language', 'en'
  )
  WHEN 'skill-creator' THEN JSON_OBJECT(
    'name', 'skill-creator',
    'description', 'Create and update Veslo skills for user, workspace, organization, and public registry-backed distribution.',
    'tags', JSON_ARRAY('skills', 'registry', 'authoring', 'platform-core'),
    'language', 'en'
  )
END
WHERE skill.`scope` = 'system'
  AND skill.`name` IN ('veslo-docx', 'veslo-pdf', 'veslo-pptx', 'veslo-xlsx', 'skill-creator')
  AND version.`package_metadata_json` IS NULL;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `skill_versions_prevent_update`;
--> statement-breakpoint
CREATE TRIGGER `skill_versions_prevent_update` BEFORE UPDATE ON `skill_versions` FOR EACH ROW SET NEW.id = IF(OLD.id <> NEW.id OR NOT (OLD.org_id <=> NEW.org_id) OR OLD.skill_id <> NEW.skill_id OR OLD.version_number <> NEW.version_number OR OLD.manifest_sha256 <> NEW.manifest_sha256 OR OLD.package_sha256 <> NEW.package_sha256 OR NOT (OLD.package_metadata_json <=> NEW.package_metadata_json) OR OLD.package_size_bytes <> NEW.package_size_bytes OR OLD.file_count <> NEW.file_count OR OLD.created_by_user_id <> NEW.created_by_user_id OR OLD.created_at <> NEW.created_at, NULL, NEW.id);
