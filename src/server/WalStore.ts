import { DuckDBInstance } from '@duckdb/node-api';
import path from 'path';
import os from 'os';
import fs from 'fs';
import PQueue from 'p-queue';

export interface WalEntry {
  id?: number;
  session_id: string;
  ts?: string;
  pane_id: string;
  slug: string;
  jira_key?: string | null;
  agent: string;
  type: 'discovery' | 'intent' | 'blocked' | 'done';
  payload: string;
}

const DATA_DIR = path.join(os.homedir(), '.dmux-workspaces');
const DB_PATH  = path.join(DATA_DIR, 'attn-wal.db');

/**
 * WalStore — append-only NDJSON log for live sessions, DuckDB for history.
 *
 * Hot path (wal_write / wal_read):
 *   - Entries are appended to a per-session NDJSON file and pushed to an
 *     in-memory array. No DuckDB connection is held during normal operation,
 *     so the DB file is never locked and can be queried externally at any time.
 *
 * Cold path (wal_history):
 *   - Opens DuckDB transiently, imports any unarchived session log files,
 *     runs the query, then closes the connection immediately.
 */
export class WalStore {
  private sessionId = '';
  private sessionEntries: WalEntry[] = [];
  private logFile = '';
  private nextId = 1;
  // Serializes transient DuckDB opens so concurrent wal_history calls
  // don't race to acquire the DB file lock.
  private historyQueue = new PQueue({ concurrency: 1 });

  async init(): Promise<void> {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  async upsertSession(id: string, _project: string): Promise<void> {
    this.sessionId = id;
    this.logFile = path.join(DATA_DIR, `session-${id}.ndjson`);

    // Reload entries if reconnecting to an existing session.
    if (fs.existsSync(this.logFile)) {
      const lines = fs.readFileSync(this.logFile, 'utf-8')
        .split('\n')
        .filter(Boolean);
      this.sessionEntries = lines.map(l => JSON.parse(l) as WalEntry);
      this.nextId = this.sessionEntries.length + 1;
    }
  }

  async append(entry: WalEntry): Promise<WalEntry> {
    const jiraKey = entry.slug.match(/^([a-z]+-\d+)/i)?.[1]?.toUpperCase() ?? null;
    const persisted: WalEntry = {
      ...entry,
      id: this.nextId++,
      ts: new Date().toISOString(),
      jira_key: jiraKey,
    };

    this.sessionEntries.push(persisted);
    fs.appendFileSync(this.logFile, JSON.stringify(persisted) + '\n');

    return persisted;
  }

  async getSession(_sessionId: string): Promise<WalEntry[]> {
    return this.sessionEntries;
  }

  async queryHistory(params: {
    jiraKey?: string; type?: string; agent?: string;
    since?: string; limit?: number;
  }): Promise<WalEntry[]> {
    return this.historyQueue.add(() => this.runHistoryQuery(params)) as Promise<WalEntry[]>;
  }

  private async runHistoryQuery(params: {
    jiraKey?: string; type?: string; agent?: string;
    since?: string; limit?: number;
  }): Promise<WalEntry[]> {
    // Open DuckDB transiently — import unarchived log files, query, close.
    const instance = await DuckDBInstance.create(DB_PATH);
    const conn = await instance.connect();

    try {
      await conn.run(`
        CREATE TABLE IF NOT EXISTS wal_entries (
          id         BIGINT,
          session_id VARCHAR,
          ts         TIMESTAMP,
          pane_id    VARCHAR,
          slug       VARCHAR,
          jira_key   VARCHAR,
          agent      VARCHAR,
          type       VARCHAR,
          payload    VARCHAR
        )
      `);
      await conn.run(`
        CREATE TABLE IF NOT EXISTS imported_sessions (
          session_id VARCHAR PRIMARY KEY
        )
      `);

      // Import any session log files not yet in DuckDB.
      const logFiles = fs.readdirSync(DATA_DIR)
        .filter(f => f.startsWith('session-') && f.endsWith('.ndjson'));

      for (const file of logFiles) {
        const sid = file.replace('session-', '').replace('.ndjson', '');
        const alreadyImported = await conn.runAndReadAll(
          `SELECT 1 FROM imported_sessions WHERE session_id = $sid`,
          { sid }
        );
        if (alreadyImported.getRowObjectsJS().length > 0) continue;

        const filePath = path.join(DATA_DIR, file);
        await conn.run(
          `INSERT INTO wal_entries SELECT * FROM read_ndjson($path, columns={
            id:'BIGINT', session_id:'VARCHAR', ts:'TIMESTAMP',
            pane_id:'VARCHAR', slug:'VARCHAR', jira_key:'VARCHAR',
            agent:'VARCHAR', type:'VARCHAR', payload:'VARCHAR'
          })`,
          { path: filePath }
        );
        await conn.run(
          `INSERT OR IGNORE INTO imported_sessions VALUES ($sid)`,
          { sid }
        );
      }

      const conditions: string[] = [];
      const values: Record<string, string | number> = {};

      if (params.jiraKey) { conditions.push(`jira_key = $jiraKey`); values['jiraKey'] = params.jiraKey; }
      if (params.type)    { conditions.push(`type = $type`);         values['type']    = params.type; }
      if (params.agent)   { conditions.push(`agent = $agent`);       values['agent']   = params.agent; }
      if (params.since)   { conditions.push(`ts >= $since`);         values['since']   = params.since; }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      values['limit'] = params.limit ?? 100;

      const reader = await conn.runAndReadAll(
        `SELECT * FROM wal_entries ${where} ORDER BY ts DESC LIMIT $limit`,
        values
      );
      return reader.getRowObjectsJS() as unknown as WalEntry[];
    } finally {
      conn.closeSync();
    }
  }
}
