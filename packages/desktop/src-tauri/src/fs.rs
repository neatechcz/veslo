use std::fs;
use std::path::Path;

const MAX_COPY_DEPTH: u32 = 32;

pub fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    copy_dir_recursive_inner(src, dest, 0)
}

fn copy_dir_recursive_inner(src: &Path, dest: &Path, depth: u32) -> Result<(), String> {
    if depth > MAX_COPY_DEPTH {
        return Err(format!(
            "Maximum directory depth ({MAX_COPY_DEPTH}) exceeded at: {}",
            src.display()
        ));
    }

    if !src.is_dir() {
        return Err(format!("Source is not a directory: {}", src.display()));
    }

    fs::create_dir_all(dest)
        .map_err(|e| format!("Failed to create dir {}: {e}", dest.display()))?;

    for entry in
        fs::read_dir(src).map_err(|e| format!("Failed to read dir {}: {e}", src.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;

        // Skip symlinks to prevent infinite loops with circular links.
        if file_type.is_symlink() {
            continue;
        }

        let from = entry.path();
        let to = dest.join(entry.file_name());

        if file_type.is_dir() {
            copy_dir_recursive_inner(&from, &to, depth + 1)?;
            continue;
        }

        if file_type.is_file() {
            fs::copy(&from, &to).map_err(|e| {
                format!("Failed to copy {} -> {}: {e}", from.display(), to.display())
            })?;
            continue;
        }
    }

    Ok(())
}

pub fn collect_copy_conflicts(src: &Path, dest: &Path) -> Result<Vec<String>, String> {
    if !src.is_dir() {
        return Err(format!("Source is not a directory: {}", src.display()));
    }

    let mut conflicts = Vec::new();
    collect_copy_conflicts_inner(src, src, dest, &mut conflicts, 0)?;
    conflicts.sort();
    conflicts.dedup();
    Ok(conflicts)
}

fn collect_copy_conflicts_inner(
    root: &Path,
    current: &Path,
    dest: &Path,
    conflicts: &mut Vec<String>,
    depth: u32,
) -> Result<(), String> {
    if depth > MAX_COPY_DEPTH {
        return Err(format!(
            "Maximum directory depth ({MAX_COPY_DEPTH}) exceeded at: {}",
            current.display()
        ));
    }

    for entry in fs::read_dir(current)
        .map_err(|e| format!("Failed to read dir {}: {e}", current.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;

        // Skip symlinks to prevent infinite loops with circular links.
        if file_type.is_symlink() {
            continue;
        }

        let from = entry.path();
        let relative = from.strip_prefix(root).map_err(|e| {
            format!(
                "Failed to resolve relative path for {}: {e}",
                from.display()
            )
        })?;
        let target = dest.join(relative);

        if file_type.is_dir() {
            collect_copy_conflicts_inner(root, &from, dest, conflicts, depth + 1)?;
            continue;
        }

        if file_type.is_file() && target.exists() {
            conflicts.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time ok")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("veslo-{label}-{nonce}"));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    #[test]
    fn collect_copy_conflicts_reports_existing_files() {
        let src = temp_dir("src");
        let dest = temp_dir("dest");
        let nested = src.join("nested");
        fs::create_dir_all(&nested).expect("create nested");
        fs::write(src.join("keep.txt"), "keep").expect("write src keep");
        fs::write(nested.join("conflict.txt"), "source").expect("write src conflict");
        fs::create_dir_all(dest.join("nested")).expect("create dest nested");
        fs::write(dest.join("nested").join("conflict.txt"), "dest").expect("write dest conflict");

        let conflicts = collect_copy_conflicts(&src, &dest).expect("collect conflicts");

        assert_eq!(conflicts, vec!["nested/conflict.txt".to_string()]);

        let _ = fs::remove_dir_all(src);
        let _ = fs::remove_dir_all(dest);
    }

    #[test]
    fn copy_dir_recursive_overwrites_existing_files() {
        let src = temp_dir("copy-src");
        let dest = temp_dir("copy-dest");
        fs::write(src.join("sample.txt"), "source").expect("write src file");
        fs::write(dest.join("sample.txt"), "dest").expect("write dest file");

        copy_dir_recursive(&src, &dest).expect("copy dir");

        let copied = fs::read_to_string(dest.join("sample.txt")).expect("read copied file");
        assert_eq!(copied, "source");

        let _ = fs::remove_dir_all(src);
        let _ = fs::remove_dir_all(dest);
    }

    #[test]
    fn copy_dir_recursive_skips_symlinks() {
        let src = temp_dir("sym-src");
        let dest = temp_dir("sym-dest");

        fs::write(src.join("real.txt"), "real").expect("write real file");

        // Create a symlink pointing back to src (circular).
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&src, src.join("loop")).expect("create symlink");
        }
        #[cfg(windows)]
        {
            // On Windows, directory symlinks require elevated privileges in
            // many configurations. If the symlink cannot be created, the test
            // still verifies that non-symlink entries are copied correctly.
            let _ = std::os::windows::fs::symlink_dir(&src, src.join("loop"));
        }

        copy_dir_recursive(&src, &dest).expect("copy must not infinite-loop");

        assert!(dest.join("real.txt").exists(), "real file must be copied");
        assert!(
            !dest.join("loop").exists(),
            "symlink must not be followed or copied"
        );

        let _ = fs::remove_dir_all(src);
        let _ = fs::remove_dir_all(dest);
    }

    #[test]
    fn copy_dir_recursive_enforces_max_depth() {
        let src = temp_dir("depth-src");
        let dest = temp_dir("depth-dest");

        // Build a directory chain deeper than MAX_COPY_DEPTH.
        let mut deep = src.clone();
        for i in 0..=MAX_COPY_DEPTH + 1 {
            deep = deep.join(format!("d{i}"));
            fs::create_dir_all(&deep).expect("create deep dir");
        }

        let result = copy_dir_recursive(&src, &dest);
        assert!(result.is_err(), "must fail on excessive depth");
        assert!(
            result.unwrap_err().contains("Maximum directory depth"),
            "error must mention depth limit"
        );

        let _ = fs::remove_dir_all(src);
        let _ = fs::remove_dir_all(dest);
    }

    #[test]
    fn collect_copy_conflicts_skips_symlinks() {
        let src = temp_dir("csym-src");
        let dest = temp_dir("csym-dest");

        fs::write(src.join("a.txt"), "a").expect("write a");
        fs::write(dest.join("a.txt"), "a-dest").expect("write a-dest");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&src, src.join("loop")).expect("create symlink");
        }

        let conflicts =
            collect_copy_conflicts(&src, &dest).expect("must not infinite-loop on symlinks");

        assert_eq!(conflicts, vec!["a.txt".to_string()]);

        let _ = fs::remove_dir_all(src);
        let _ = fs::remove_dir_all(dest);
    }
}
