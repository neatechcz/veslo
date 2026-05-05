ALTER TABLE `user_ai_access_policy`
  ADD COLUMN `assignment_origin` varchar(32) NOT NULL DEFAULT 'admin_assigned';
