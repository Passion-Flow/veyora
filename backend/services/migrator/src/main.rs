//! Veyora migrator service.
//!
//! Operator-controlled database migration runner. Reads SQL migration files
//! from the postgres crate's migrations directory and applies them in order,
//! reporting the applied revision. Idempotent: already-applied migrations are
//! skipped via PostgreSQL's schema versioning.

use std::env;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let database_url = match env::var("DATABASE_URL") {
        Ok(url) => url,
        Err(_) => {
            eprintln!("DATABASE_URL is required; the migrator cannot run without a database");
            return ExitCode::from(1);
        }
    };

    // Explicit configuration: the migrations directory must be provided — the
    // image bakes it to /app/migrations and dev invocations pass their own
    // path (see the Makefile migrate target and .env.example).
    let migrations_dir = match env::var("VEYORA_MIGRATIONS_DIR") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => {
            eprintln!("VEYORA_MIGRATIONS_DIR is required (the image bakes /app/migrations)");
            return ExitCode::from(1);
        }
    };

    if !migrations_dir.exists() {
        eprintln!(
            "migrations directory not found: {}",
            migrations_dir.display()
        );
        return ExitCode::from(1);
    }

    match run_migrations(&database_url, &migrations_dir) {
        Ok(applied) => {
            println!("migrations: applied {applied} file(s) to configured PostgreSQL");
            ExitCode::from(0)
        }
        Err(msg) => {
            eprintln!("migration failed: {msg}");
            ExitCode::from(1)
        }
    }
}

fn run_migrations(database_url: &str, migrations_dir: &PathBuf) -> Result<usize, String> {
    let mut client = postgres::Client::connect(database_url, postgres::NoTls)
        .map_err(|e| format!("connect: {e}"))?;

    // Ensure the schema_version table exists.
    client
        .batch_execute(
            "CREATE TABLE IF NOT EXISTS _veyora_schema_version (
                version INTEGER PRIMARY KEY,
                filename TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );",
        )
        .map_err(|e| format!("create version table: {e}"))?;

    // List migration files in order.
    let mut files: Vec<_> = std::fs::read_dir(migrations_dir)
        .map_err(|e| format!("read migrations dir: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|ext| ext == "sql"))
        .collect();
    files.sort_by_key(|e| e.path());

    let mut applied = 0usize;
    for (version, file) in files.iter().enumerate() {
        let version = version as i32;
        let filename = file.file_name().to_string_lossy().to_string();

        // Check if already applied.
        let already: bool = client
            .query_opt(
                "SELECT 1 FROM _veyora_schema_version WHERE version = $1",
                &[&version],
            )
            .map_err(|e| format!("check version {version}: {e}"))?
            .is_some();
        if already {
            continue;
        }

        // Read and apply the SQL.
        let sql = std::fs::read_to_string(file.path())
            .map_err(|e| format!("read {}: {e}", file.path().display()))?;

        let mut tx = client
            .transaction()
            .map_err(|e| format!("begin tx for {filename}: {e}"))?;
        tx.batch_execute(&sql)
            .map_err(|e| format!("apply {filename}: {e}"))?;
        tx.execute(
            "INSERT INTO _veyora_schema_version (version, filename) VALUES ($1, $2)",
            &[&version, &filename],
        )
        .map_err(|e| format!("record version {version}: {e}"))?;
        tx.commit().map_err(|e| format!("commit {filename}: {e}"))?;

        println!("  applied: {filename}");
        applied += 1;
    }

    Ok(applied)
}
