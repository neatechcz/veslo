use std::fs;
use std::path::Path;

pub fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), String> {
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

        let from = entry.path();
        let to = dest.join(entry.file_name());

        if file_type.is_dir() {
            copy_dir_recursive(&from, &to)?;
            continue;
        }

        if file_type.is_file() {
            fs::copy(&from, &to).map_err(|e| {
                format!("Failed to copy {} -> {}: {e}", from.display(), to.display())
            })?;
            continue;
        }

        // Skip symlinks and other non-regular entries.
    }

    Ok(())
}

pub fn collect_copy_conflicts(src: &Path, dest: &Path) -> Result<Vec<String>, String> {
    if !src.is_dir() {
        return Err(format!("Source is not a directory: {}", src.display()));
    }

    let mut conflicts = Vec::new();
    collect_copy_conflicts_inner(src, src, dest, &mut conflicts)?;
    conflicts.sort();
    conflicts.dedup();
    Ok(conflicts)
}

fn collect_copy_conflicts_inner(
    root: &Path,
    current: &Path,
    dest: &Path,
    conflicts: &mut Vec<String>,
) -> Result<(), String> {
    for entry in
        fs::read_dir(current).map_err(|e| format!("Failed to read dir {}: {e}", current.display()))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let from = entry.path();
        let relative = from
            .strip_prefix(root)
            .map_err(|e| format!("Failed to resolve relative path for {}: {e}", from.display()))?;
        let target = dest.join(relative);

        if file_type.is_dir() {
            collect_copy_conflicts_inner(root, &from, dest, conflicts)?;
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
}
