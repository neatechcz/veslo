fn read_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn read_build_env(name: &str) -> Option<String> {
    match name {
        "VESLO_GLITCHTIP_DSN" => option_env!("VESLO_GLITCHTIP_DSN"),
        "VESLO_GLITCHTIP_ENVIRONMENT" => option_env!("VESLO_GLITCHTIP_ENVIRONMENT"),
        "VESLO_GLITCHTIP_TRACES_SAMPLE_RATE" => {
            option_env!("VESLO_GLITCHTIP_TRACES_SAMPLE_RATE")
        }
        _ => None,
    }
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string)
}

fn read_env_or_build_env(name: &str) -> Option<String> {
    read_env(name).or_else(|| read_build_env(name))
}

fn parse_traces_sample_rate(value: Option<String>) -> f32 {
    value
        .and_then(|raw| raw.parse::<f32>().ok())
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.0, 1.0))
        .unwrap_or(0.0)
}

fn default_environment() -> String {
    if cfg!(debug_assertions) {
        "development".to_string()
    } else {
        "production".to_string()
    }
}

pub fn init_error_monitoring() -> Option<sentry::ClientInitGuard> {
    let dsn = read_env_or_build_env("VESLO_GLITCHTIP_DSN")?;
    let dsn = match dsn.parse() {
        Ok(dsn) => dsn,
        Err(error) => {
            eprintln!("[error-monitoring] invalid VESLO_GLITCHTIP_DSN: {error}");
            return None;
        }
    };

    let environment =
        read_env_or_build_env("VESLO_GLITCHTIP_ENVIRONMENT").unwrap_or_else(default_environment);
    let traces_sample_rate =
        parse_traces_sample_rate(read_env_or_build_env("VESLO_GLITCHTIP_TRACES_SAMPLE_RATE"));

    Some(sentry::init(sentry::ClientOptions {
        dsn: Some(dsn),
        environment: Some(environment.into()),
        release: sentry::release_name!(),
        traces_sample_rate,
        send_default_pii: false,
        ..Default::default()
    }))
}
