use serde_json::Value;

fn tauri_config() -> Value {
    serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json should parse")
}

fn default_capability() -> Value {
    serde_json::from_str(include_str!("../capabilities/default.json"))
        .expect("default capability should parse")
}

#[test]
fn desktop_config_creates_only_the_main_window_explicitly() {
    let config = tauri_config();
    let windows = config["app"]["windows"]
        .as_array()
        .expect("desktop config should define windows");

    assert_eq!(windows.len(), 1, "desktop runtime must stay single-window");
    assert_eq!(windows[0]["label"], "main");
    assert_eq!(
        windows[0]["create"], false,
        "main window must be created by Rust so it can deny new-window requests"
    );
}

#[test]
fn desktop_capability_is_scoped_to_main_window() {
    let capability = default_capability();
    let windows = capability["windows"]
        .as_array()
        .expect("default capability should define window scope");

    assert_eq!(windows, &[Value::String("main".to_string())]);

    let permissions = capability["permissions"]
        .as_array()
        .expect("default capability should define permissions");
    assert!(
        permissions
            .iter()
            .any(|permission| permission == "core:app:deny-supports-multiple-windows"),
        "frontend must not be allowed to query multi-window support"
    );
}
