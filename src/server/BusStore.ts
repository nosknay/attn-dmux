import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import path from 'path';

export type BusMessageType =
  | 'intent'
  | 'discovery'
  | 'blocked'
  | 'done'
  | 'needs-agent:sibling'
  | 'needs-agent:worktree'
  | 'spawned';

export interface BusMessage {
  id: number;
  session_id: string;
  pane_id: string;
  slug: string;
  agent: string;
  type: BusMessageType;
  payload: string;
  task_hint: string | null;
  ts: string;
}

export interface AppendBusMessage {
  session_id: string;
  pane_id: string;
  slug: string;
  agent: string;
  type: BusMessageType;
  payload: string;
  task_hint?: string | null;
}

export interface QueryOptions {
  since?: number;
  type?: string;
}

const DB_DIR = path.join(homedir(), '.dmux');
const DB_PATH = path.join(DB_DIR, 'bus.db');

export class BusStore extends EventEmitter {
  private db: Database.Database;

  constructor(dbPath: string = DB_PATH) {
    super();
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        pane_id    TEXT NOT NULL,
        slug       TEXT NOT NULL,
        agent      TEXT NOT NULL,
        type       TEXT NOT NULL,
        payload    TEXT NOT NULL,
        task_hint  TEXT,
        ts         DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_type    ON messages(type);
    `);
  }

  append(msg: AppendBusMessage): BusMessage {
    const stmt = this.db.prepare(`
      INSERT INTO messages (session_id, pane_id, slug, agent, type, payload, task_hint)
      VALUES (@session_id, @pane_id, @slug, @agent, @type, @payload, @task_hint)
    `);
    const result = stmt.run({ ...msg, task_hint: msg.task_hint ?? null });
    const inserted = this.get(result.lastInsertRowid as number)!;
    this.emit('message', inserted);
    return inserted;
  }

  get(id: number): BusMessage | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as BusMessage | undefined;
  }

  query(sessionId: string, opts: QueryOptions = {}): BusMessage[] {
    let sql = 'SELECT * FROM messages WHERE session_id = ?';
    const params: (string | number)[] = [sessionId];

    if (opts.since !== undefined) {
      sql += ' AND id > ?';
      params.push(opts.since);
    }
    if (opts.type) {
      sql += ' AND type = ?';
      params.push(opts.type);
    }

    sql += ' ORDER BY id ASC';
    return this.db.prepare(sql).all(...params) as BusMessage[];
  }

  // Check if there is a previous unresolved needs-agent request from a pane
  // (published before beforeId but not yet answered by a spawned message).
  // beforeId should be the id of the current incoming message so we only
  // look at earlier requests, not the one being processed right now.
  hasPendingSpawn(sessionId: string, paneId: string, beforeId: number): boolean {
    const pending = this.db.prepare(`
      SELECT id FROM messages
      WHERE session_id = ? AND pane_id = ? AND id < ?
        AND type IN ('needs-agent:sibling', 'needs-agent:worktree')
      ORDER BY id DESC LIMIT 1
    `).get(sessionId, paneId, beforeId) as { id: number } | undefined;

    if (!pending) return false;

    const spawned = this.db.prepare(`
      SELECT id FROM messages
      WHERE session_id = ? AND type = 'spawned' AND id > ?
        AND json_extract(payload, '$.requestId') = ?
    `).get(sessionId, pending.id, String(pending.id));

    return spawned === undefined;
  }

  close(): void {
    this.db.close();
  }
}
