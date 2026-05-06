#[tauri::command]
pub fn clipboard_file_paths() -> Result<Vec<String>, String> {
    Ok(platform_clipboard_file_paths())
}

#[cfg(not(target_os = "macos"))]
fn platform_clipboard_file_paths() -> Vec<String> {
    Vec::new()
}

#[cfg(target_os = "macos")]
fn platform_clipboard_file_paths() -> Vec<String> {
    macos::clipboard_file_paths()
}

#[cfg(target_os = "macos")]
mod macos {
    use std::collections::HashSet;
    use std::ffi::CStr;

    use objc2::rc::Retained;
    use objc2::ClassType;
    #[allow(deprecated)]
    use objc2_app_kit::NSFilenamesPboardType;
    use objc2_app_kit::NSPasteboard;
    use objc2_foundation::{NSArray, NSString, NSURL};

    pub fn clipboard_file_paths() -> Vec<String> {
        let pasteboard = NSPasteboard::generalPasteboard();
        let mut paths = Vec::new();
        paths.extend(file_urls(&pasteboard));
        paths.extend(legacy_filenames(&pasteboard));
        dedupe(paths)
    }

    fn file_urls(pasteboard: &NSPasteboard) -> Vec<String> {
        let classes = NSArray::from_slice(&[NSURL::class()]);
        let Some(objects) = (unsafe { pasteboard.readObjectsForClasses_options(&classes, None) })
        else {
            return Vec::new();
        };
        let urls: Retained<NSArray<NSURL>> = unsafe { Retained::cast_unchecked(objects) };
        let mut paths = Vec::new();

        for index in 0..urls.count() {
            let url = urls.objectAtIndex(index);
            if !url.isFileURL() {
                continue;
            }
            if let Some(path) = url.to_file_path() {
                let value = path.to_string_lossy().trim().to_string();
                if !value.is_empty() {
                    paths.push(value);
                }
            }
        }

        paths
    }

    fn legacy_filenames(pasteboard: &NSPasteboard) -> Vec<String> {
        #[allow(deprecated)]
        let Some(object) = (unsafe { pasteboard.propertyListForType(NSFilenamesPboardType) }) else {
            return Vec::new();
        };
        let filenames: Retained<NSArray<NSString>> = unsafe { Retained::cast_unchecked(object) };
        let mut paths = Vec::new();

        for index in 0..filenames.count() {
            let filename = filenames.objectAtIndex(index);
            if let Some(value) = ns_string_to_string(&filename) {
                let trimmed = value.trim().to_string();
                if !trimmed.is_empty() {
                    paths.push(trimmed);
                }
            }
        }

        paths
    }

    fn ns_string_to_string(value: &NSString) -> Option<String> {
        let ptr = value.UTF8String();
        if ptr.is_null() {
            return None;
        }
        Some(
            unsafe { CStr::from_ptr(ptr) }
                .to_string_lossy()
                .into_owned(),
        )
    }

    fn dedupe(paths: Vec<String>) -> Vec<String> {
        let mut seen = HashSet::new();
        paths
            .into_iter()
            .filter(|path| seen.insert(path.clone()))
            .collect()
    }
}
