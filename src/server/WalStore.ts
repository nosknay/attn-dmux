import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import path from 'path';
import os from 'os';
import { mkdirSync } from 'fs';

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

export class WalStore {
  private conn!: DuckDBConnection;
  private static readonly DB_PATH = path.join(
    os.homedir(), '.dmux-workspaces', 'attn-wal.db'
  );

  async init(): Promise<void> {
    mkdirSync(path.dirname(WalStore.DB_PATH), { recursive: true });
    const instance = await DuckDBInstance.create(WalStore.DB_PATH);
    this.conn = await instance.connect();

    await this.conn.run(`CREATE SEQUENCE IF NOT EXISTS wal_entries_id_seq`);
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        id          VARCHAR PRIMARY KEY,
        project     VARCHAR,
        started_at  TIMESTAMP DEFAULT now(),
        ended_at    TIMESTAMP
      )
    `);
    await this.conn.run(`
      CREATE TABLE IF NOT EXISTS wal_entries (
        id          BIGINT DEFAULT nextval('wal_entries_id_seq') PRIMARY KEY,
        session_id  VARCHAR REFERENCES sessions(id),
        ts          TIMESTAMP DEFAULT now(),
        pane_id     VARCHAR,
        slug        VARCHAR,
        jira_key    VARCHAR,
        agent       VARCHAR,
        type        VARCHAR,
        payload     VARCHAR
      )
    `);
    await this.conn.run(`CREATE INDEX IF NOT EXISTS idx_wal_jira    ON wal_entries(jira_key)`);
    await this.conn.run(`CREATE INDEX IF NOT EXISTS idx_wal_session ON wal_entries(session_id)`);
    await this.conn.run(`CREATE INDEX IF NOT EXISTS idx_wal_type    ON wal_entries(type)`);
  }

  async upsertSession(id: string, project: string): Promise<void> {
    await this.conn.run(
      `INSERT OR IGNORE INTO sessions(id, project) VALUES ($id, $project)`,
      { id, project }
    );
  }

  async append(entry: WalEntry): Promise<WalEntry> {
    const jiraKey = entry.slug.match(/^([a-z]+-\d+)/i)?.[1]?.toUpperCase() ?? null;
    const reader = await this.conn.runAndReadAll(
      `INSERT INTO wal_entries(session_id, pane_id, slug, jira_key, agent, type, payload)
       VALUES ($session_id, $pane_id, $slug, $jira_key, $agent, $type, $payload)
       RETURNING *`,
      {
        session_id: entry.session_id,
        pane_id: entry.pane_id,
        slug: entry.slug,
        jira_key: jiraKey,
        agent: entry.agent,
        type: entry.type,
        payload: entry.payload,
      }
    );
    return reader.getRowObjectsJS()[0] as unknown as WalEntry;
  }

  async getSession(sessionId: string): Promise<WalEntry[]> {
    const reader = await this.conn.runAndReadAll(
      `SELECT * FROM wal_entries WHERE session_id = $session_id ORDER BY ts`,
      { session_id: sessionId }
    );
    return reader.getRowObjectsJS() as unknown as WalEntry[];
  }

  async queryHistory(params: {
    jiraKey?: string; type?: string; agent?: string;
    since?: string; limit?: number;
  }): Promise<WalEntry[]> {
    const conditions: string[] = [];
    const values: Record<string, string | number> = {};

    if (params.jiraKey) { conditions.push('jira_key = $jiraKey'); values['jiraKey'] = params.jiraKey; }
    if (params.type)    { conditions.push('type = $type');         values['type'] = params.type; }
    if (params.agent)   { conditions.push('agent = $agent');       values['agent'] = params.agent; }
    if (params.since)   { conditions.push('ts >= $since');         values['since'] = params.since; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    values['limit'] = params.limit ?? 100;

    const reader = await this.conn.runAndReadAll(
      `SELECT * FROM wal_entries ${where} ORDER BY ts DESC LIMIT $limit`,
      values
    );
    return reader.getRowObjectsJS() as unknown as WalEntry[];
  }
}
