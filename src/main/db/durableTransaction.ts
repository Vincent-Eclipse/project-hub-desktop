import type Database from 'better-sqlite3'

// Meilenstein 4.8B.2B - narrowly scoped SQLite durability helper.
//
// `PRAGMA synchronous` cannot be usefully changed from INSIDE an already-open
// transaction (SQLite applies a pragma change only to statements that follow
// it - a change made mid-transaction does not retroactively affect that same
// transaction's own durability). This helper therefore sets FULL strictly
// BEFORE opening the transaction, runs the caller's synchronous work as one
// better-sqlite3 transaction, and restores NORMAL in a `finally` - even if
// the wrapped function throws - so a failure here never leaves the
// connection permanently pinned at FULL for unrelated later writes.
//
// Reserved for the small set of writes whose durability actually matters
// across a crash (the durable apply-batch journal, starting with
// admitBatch()'s own ADMITTED transaction) - every other write in this app
// remains under the connection's ambient `synchronous = NORMAL` setting set
// by openDatabase() (connection.ts). This is a deliberate, scoped choice
// (Option A from the approved M4.8B.2B design) over a global FULL setting,
// which would fsync every unrelated write in the app, or a second dedicated
// connection, which adds concurrency/lifecycle surface this single-writer
// app does not need.
//
// Durability caveat, stated explicitly rather than overclaimed: `FULL`
// causes SQLite to call FlushFileBuffers (the same Win32 API the native
// windows-safe-apply module already relies on for its own write discipline)
// at the points its durability contract requires - this guarantees the OS
// has been told to persist the data and has acknowledged that instruction.
// It does NOT guarantee the physical storage medium itself is honest about
// that acknowledgment (a drive with volatile write-caching and no
// power-loss protection can report completion before data is physically
// durable) - no application-level setting can detect or correct that.
export function withFullDurability<T>(db: Database.Database, fn: () => T): T {
  db.pragma('synchronous = FULL')
  try {
    return db.transaction(fn)()
  } finally {
    db.pragma('synchronous = NORMAL')
  }
}
