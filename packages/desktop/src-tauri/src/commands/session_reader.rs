use crate::paths::home_dir;
use rusqlite::{params, Connection, OpenFlags};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSessionRow {
    pub id: String,
    pub title: String,
    pub directory: String,
    pub parent_id: Option<String>,
    pub time_created: f64,
    pub time_updated: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbMessageRow {
    pub id: String,
    pub session_id: String,
    pub data: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbPartRow {
    pub id: String,
    pub message_id: String,
    pub session_id: String,
    pub data: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTranscriptResult {
    pub messages: Vec<DbMessageRow>,
    pub parts: Vec<DbPartRow>,
}

fn open_opencode_db_readonly() -> Result<Option<Connection>, String> {
    let home = home_dir().ok_or("Cannot determine home directory")?;
    let db_path = home.join(".local/share/opencode/opencode.db");
    if !db_path.exists() {
        return Ok(None);
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(&db_path, flags).map_err(|e| {
        format!(
            "Failed to open OpenCode database at {}: {e}",
            db_path.display()
        )
    })?;
    Ok(Some(conn))
}

fn read_sessions_from_connection(
    conn: &Connection,
    directory: &str,
) -> Result<Vec<DbSessionRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, directory, parent_id, time_created, time_updated \
             FROM session \
             WHERE directory = ?1 \
             ORDER BY time_updated DESC",
        )
        .map_err(|e| format!("Failed to prepare session query: {e}"))?;

    let rows = stmt
        .query_map(params![directory], |row| {
            Ok(DbSessionRow {
                id: row.get(0)?,
                title: row.get::<_, String>(1).unwrap_or_default(),
                directory: row.get::<_, String>(2).unwrap_or_default(),
                parent_id: row.get::<_, Option<String>>(3).unwrap_or(None),
                time_created: row.get::<_, f64>(4).unwrap_or(0.0),
                time_updated: row.get::<_, f64>(5).unwrap_or(0.0),
            })
        })
        .map_err(|e| format!("Failed to query sessions: {e}"))?;

    let mut result = Vec::new();
    for row in rows {
        match row {
            Ok(r) => result.push(r),
            Err(e) => eprintln!("[session_reader] skipping session row: {e}"),
        }
    }

    Ok(result)
}

#[tauri::command]
pub fn opencode_db_read_sessions(directory: String) -> Result<Vec<DbSessionRow>, String> {
    let directory = directory.trim().to_string();
    if directory.is_empty() {
        return Err("directory is required".to_string());
    }

    let conn = match open_opencode_db_readonly()? {
        Some(c) => c,
        None => return Ok(vec![]),
    };

    read_sessions_from_connection(&conn, &directory)
}

#[tauri::command]
pub fn opencode_db_read_transcript(
    session_id: String,
    limit: Option<u32>,
) -> Result<DbTranscriptResult, String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("session_id is required".to_string());
    }

    let conn = match open_opencode_db_readonly()? {
        Some(c) => c,
        None => {
            return Ok(DbTranscriptResult {
                messages: vec![],
                parts: vec![],
            })
        }
    };

    // Messages
    let limit_val = limit.unwrap_or(200);
    let mut msg_stmt = conn
        .prepare(
            "SELECT id, session_id, data \
             FROM message \
             WHERE session_id = ?1 \
             ORDER BY id ASC \
             LIMIT ?2",
        )
        .map_err(|e| format!("Failed to prepare message query: {e}"))?;

    let msg_rows = msg_stmt
        .query_map(params![session_id, limit_val], |row| {
            Ok(DbMessageRow {
                id: row.get(0)?,
                session_id: row.get(1)?,
                data: row.get::<_, String>(2).unwrap_or_default(),
            })
        })
        .map_err(|e| format!("Failed to query messages: {e}"))?;

    let mut messages = Vec::new();
    for row in msg_rows {
        match row {
            Ok(r) => messages.push(r),
            Err(e) => eprintln!("[session_reader] skipping message row: {e}"),
        }
    }

    // Parts
    let mut part_stmt = conn
        .prepare(
            "SELECT id, message_id, session_id, data \
             FROM part \
             WHERE session_id = ?1 \
             ORDER BY id ASC",
        )
        .map_err(|e| format!("Failed to prepare part query: {e}"))?;

    let part_rows = part_stmt
        .query_map(params![session_id], |row| {
            Ok(DbPartRow {
                id: row.get(0)?,
                message_id: row.get::<_, String>(1).unwrap_or_default(),
                session_id: row.get::<_, String>(2).unwrap_or_default(),
                data: row.get::<_, String>(3).unwrap_or_default(),
            })
        })
        .map_err(|e| format!("Failed to query parts: {e}"))?;

    let mut parts = Vec::new();
    for row in part_rows {
        match row {
            Ok(r) => parts.push(r),
            Err(e) => eprintln!("[session_reader] skipping part row: {e}"),
        }
    }

    Ok(DbTranscriptResult { messages, parts })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_sessions_from_connection_returns_parent_ids() {
        let conn = Connection::open_in_memory().expect("open in-memory sqlite");
        conn.execute(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                directory TEXT NOT NULL,
                parent_id TEXT,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL
            )",
            [],
        )
        .expect("create session table");

        conn.execute(
            "INSERT INTO session (id, title, directory, parent_id, time_created, time_updated)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                "root-parent",
                "root-parent",
                "/tmp/workspace",
                Option::<String>::None,
                100,
                300
            ],
        )
        .expect("insert root session");
        conn.execute(
            "INSERT INTO session (id, title, directory, parent_id, time_created, time_updated)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                "child-subagent",
                "child-subagent",
                "/tmp/workspace",
                "root-parent",
                200,
                400
            ],
        )
        .expect("insert child session");

        let rows = read_sessions_from_connection(&conn, "/tmp/workspace").expect("query sessions");
        let child = rows
            .iter()
            .find(|row| row.id == "child-subagent")
            .expect("child session present");

        assert_eq!(child.parent_id.as_deref(), Some("root-parent"));
    }
}
