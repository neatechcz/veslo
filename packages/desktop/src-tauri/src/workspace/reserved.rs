const RESERVED_INTERNAL_WORKSPACE_DIR_NAMES: &[&str] = &[".opencode"];

pub fn is_reserved_internal_workspace_dir_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty()
        && RESERVED_INTERNAL_WORKSPACE_DIR_NAMES
            .iter()
            .any(|reserved| trimmed.eq_ignore_ascii_case(reserved))
}
