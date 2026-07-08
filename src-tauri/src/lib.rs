use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// Hive config, read from ~/.hive/config.json (git-ignored, never in the repo).
#[derive(serde::Serialize, Default)]
struct HiveConfig {
    notion_token: Option<String>,
    capture_page_id: Option<String>,
    scratchpad_page_id: Option<String>,
}

#[tauri::command]
fn get_config() -> HiveConfig {
    let Some(home) = std::env::var_os("HOME") else {
        return HiveConfig::default();
    };
    let path = std::path::Path::new(&home).join(".hive").join("config.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HiveConfig::default();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return HiveConfig::default();
    };
    let token = json
        .get("notionToken")
        .or_else(|| json.get("notion_token"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let capture = json
        .get("capturePageId")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let scratchpad = json
        .get("scratchpadPageId")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    HiveConfig {
        notion_token: token,
        capture_page_id: capture,
        scratchpad_page_id: scratchpad,
    }
}

/// Render-vs-embed spike: notion.so refuses to be iframed (X-Frame-Options),
/// so the embedded view is a separate webview window reusing the label "embed".
#[tauri::command]
async fn open_embed(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|e| e.to_string())?;
    if parsed.scheme() != "https"
        || !matches!(parsed.host_str(), Some("www.notion.so") | Some("notion.so"))
    {
        return Err("embed window only accepts https notion.so URLs".into());
    }
    if let Some(existing) = app.get_webview_window("embed") {
        existing.navigate(parsed).map_err(|e| e.to_string())?;
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "embed", tauri::WebviewUrl::External(parsed))
        .title("Notion (embedded)")
        .inner_size(1100.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Built-in Finicky: when Hive is the default browser, non-Notion links get
/// forwarded to the real browser (config `fallbackBrowser`, default "Arc").
#[tauri::command]
fn forward_url(url: String) -> Result<(), String> {
    let parsed = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only web URLs are forwarded".into());
    }
    let browser = std::env::var_os("HOME")
        .map(|h| std::path::Path::new(&h).join(".hive").join("config.json"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|j| j.get("fallbackBrowser").and_then(|v| v.as_str()).map(str::to_owned))
        .unwrap_or_else(|| "Arc".to_string());
    std::process::Command::new("open")
        .args(["-a", &browser, url.as_str()])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Escape hatch: open a page in the native Notion app via its notion://
/// protocol — immune to browser routing (https links would boomerang back
/// into Hive once Hive is the default browser).
#[tauri::command]
fn open_in_notion(page_id: String) -> Result<(), String> {
    let clean: String = page_id.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if clean.len() != 32 {
        return Err("not a Notion page id".into());
    }
    std::process::Command::new("open")
        .arg(format!("notion://www.notion.so/{clean}"))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// OAuth tokens for Notion's hosted MCP (personal identity). Stored beside
/// the API token in ~/.hive — chmod 600, never in the repo or logs.
fn mcp_auth_path() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME")
        .map(|h| std::path::Path::new(&h).join(".hive").join("mcp_auth.json"))
}

#[tauri::command]
fn save_mcp_auth(json: String) -> Result<(), String> {
    let path = mcp_auth_path().ok_or("no HOME")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    if json.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tauri::command]
fn load_mcp_auth() -> Option<String> {
    std::fs::read_to_string(mcp_auth_path()?).ok()
}

/// Unread-count badge on the macOS dock icon (Notifications Tier A).
#[tauri::command]
fn set_badge(app: tauri::AppHandle, count: i64) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_count(if count > 0 { Some(count) } else { None });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Phase 1 creates only the content-plane cache. Org-plane tables
    // (space, sidebar_item, folder, ...) arrive as migration 2 in Phase 2.
    // IMPORTANT: one statement per migration. tauri-plugin-sql executes each
    // migration's `sql` as a single prepared statement, so only the FIRST
    // statement of a multi-statement string runs — the rest silently no-op
    // and the migration chain effectively stalls. (Cost us a real bug: v2–v4
    // were authored multi-statement and never applied on real SQLite; every
    // verification had run against the localStorage fallback.) Keep these
    // atomic and append-only; never edit an already-shipped migration's body.
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_page_cache",
            sql: "CREATE TABLE IF NOT EXISTS page_cache (
                    notion_page_id TEXT PRIMARY KEY,
                    blocks_json TEXT NOT NULL,
                    properties_json TEXT NOT NULL,
                    fetched_at TEXT NOT NULL,
                    etag TEXT
                  );",
            kind: MigrationKind::Up,
        },
        // Phase 2: the organization plane (ARCHITECTURE.md §4).
        // Local, private, mutable — never written to Notion.
        Migration {
            version: 2,
            description: "create_space",
            sql: "CREATE TABLE IF NOT EXISTS space (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    color TEXT NOT NULL,
                    theme TEXT,
                    sort_order INTEGER NOT NULL,
                    created_at TEXT NOT NULL
                  );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create_folder",
            sql: "CREATE TABLE IF NOT EXISTS folder (
                    id TEXT PRIMARY KEY,
                    space_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    parent_folder_id TEXT,
                    sort_order INTEGER NOT NULL
                  );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "create_sidebar_item",
            sql: "CREATE TABLE IF NOT EXISTS sidebar_item (
                    id TEXT PRIMARY KEY,
                    space_id TEXT,
                    notion_page_id TEXT NOT NULL,
                    tier TEXT NOT NULL,
                    parent_folder_id TEXT,
                    sort_order INTEGER NOT NULL,
                    title_cache TEXT,
                    icon_cache TEXT,
                    last_opened_at TEXT,
                    auto_archive_at TEXT
                  );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "index_sidebar_space",
            sql: "CREATE INDEX IF NOT EXISTS idx_sidebar_space
                    ON sidebar_item(space_id, tier, sort_order);",
            kind: MigrationKind::Up,
        },
        // Arc parity: Spaces get an assignable icon (emoji).
        Migration {
            version: 6,
            description: "space_icon",
            sql: "ALTER TABLE space ADD COLUMN icon TEXT;",
            kind: MigrationKind::Up,
        },
        // Phase 3: navigation intelligence + change detection.
        Migration {
            version: 7,
            description: "create_frecency",
            sql: "CREATE TABLE IF NOT EXISTS frecency (
                    notion_page_id TEXT PRIMARY KEY,
                    hit_count INTEGER NOT NULL DEFAULT 0,
                    last_hit_at TEXT,
                    title_cache TEXT,
                    icon_cache TEXT,
                    score_cache REAL
                  );",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "page_cache_last_edited_time",
            sql: "ALTER TABLE page_cache ADD COLUMN last_edited_time TEXT;",
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:hive.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_config,
            open_embed,
            set_badge,
            forward_url,
            open_in_notion,
            save_mcp_auth,
            load_mcp_auth
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
