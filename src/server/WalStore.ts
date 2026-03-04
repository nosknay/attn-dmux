import { DuckDBInstance } from '@duckdb/node-api';
import path from 'path';
import os from 'os';

export interface WalEntry {
  id?: number;
  sessionId: string;
  ts?: string;
  paneId: string;
  slug: string;
  jiraKey?: string;
  agent: string;
  type: 'discovery' | 'intent' | 'blocked' | 'done';
  payload: string;
}

export class WalStore {
  private db!: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  private static readonly DB_PATH = path.join(
    os.homedir(), '.dmux-workspaces', 'attn-wal.db'
  );

  async init(): Promise<void> {
    this.db = await DuckDBInstance.create(WalStore.DB_PATH);
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id VARCHAR PRIMARY KEY, project VARCHAR,
        started_at TIMESTAMP DEFAULT now(), ended_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS wal_entries (
        id INTEGER PRIMARY KEY,
        session_id VARCHAR REFERENCES sessions(id),
        ts TIMESTAMP DEFAULT now(),
        pane_id VARCHAR, slug VARCHAR, jira_key VARCHAR,
        agent VARCHAR, type VARCHAR, payload VARCHAR
      );
      CREATE INDEX IF NOT EXISTS idx_wal_jira    ON wal_entries(jira_key);
      CREATE INDEX IF NOT EXISTS idx_wal_session ON wal_entries(session_id);
      CREATE INDEX IF NOT EXISTS idx_wal_type    ON wal_entries(type);
    `);
  }

  async upsertSession(id: string, project: string): Promise<void> {
    await this.db.run(
      `INSERT OR IGNORE INTO sessions(id, project) VALUES (?, ?)`,
      [id, project]
    );
  }

  async append(entry: WalEntry): Promise<WalEntry> {
    const jiraKey = entry.slug.match(/^([a-z]+-\d+)/i)?.[1]?.toUpperCase() ?? null;
    const result = await this.db.run(
      `INSERT INTO wal_entries(session_id, pane_id, slug, jira_key, agent, type, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      [entry.sessionId, entry.paneId, entry.slug, jiraKey,
       entry.agent, entry.type, entry.payload]
    );
    return result.rows[0] as WalEntry;
  }

  async getSession(sessionId: string): Promise<WalEntry[]> {
    const result = await this.db.run(
      `SELECT * FROM wal_entries WHERE session_id = ? ORDER BY ts`,
      [sessionId]
    );
    return result.rows as WalEntry[];
  }

  async queryHistory(params: {
    jiraKey?: string; type?: string; agent?: string;
    since?: string; limit?: number;
  }): Promise<WalEntry[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params.jiraKey) { conditions.push('jira_key = ?'); values.push(params.jiraKey); }
    if (params.type)    { conditions.push('type = ?');     values.push(params.type); }
    if (params.agent)   { conditions.push('agent = ?');    values.push(params.agent); }
    if (params.since)   { conditions.push('ts >= ?');      values.push(params.since); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = params.limit ?? 100;
    const result = await this.db.run(
      `SELECT * FROM wal_entries ${where} ORDER BY ts DESC LIMIT ?`,
      [...values, limit]
    );
    return result.rows as WalEntry[];
  }
}
