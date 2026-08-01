ALTER TABLE `feedback_report`
  MODIFY `status` enum('stored','pending','projected','failed') NOT NULL DEFAULT 'stored';
