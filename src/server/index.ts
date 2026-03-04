import { createServer, ServerResponse } from 'http';
import { WalStore } from './WalStore.js';
import { StateManager } from '../shared/StateManager.js';

export async function startDmuxServer(
  stateManager: StateManager,
  port: number
): Promise<void> {
  const walStore = new WalStore();
  await walStore.init();

  const { sessionName, projectName } = stateManager.getState();
  await walStore.upsertSession(sessionName, projectName);

  const sseClients: ServerResponse[] = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`);

    // GET /api/wal — current session entries
    if (req.method === 'GET' && url.pathname === '/api/wal') {
      const entries = await walStore.getSession(sessionName);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entries));
      return;
    }

    // POST /api/wal — append entry
    if (req.method === 'POST' && url.pathname === '/api/wal') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        const entry = await walStore.append({ sessionId: sessionName, ...JSON.parse(body) });
        const data = `data: ${JSON.stringify(entry)}\n\n`;
        sseClients.forEach(client => client.write(data));
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(entry));
      });
      return;
    }

    // GET /api/wal/stream — SSE stream for current session
    if (req.method === 'GET' && url.pathname === '/api/wal/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      const existing = await walStore.getSession(sessionName);
      existing.forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
      sseClients.push(res);
      req.on('close', () => sseClients.splice(sseClients.indexOf(res), 1));
      return;
    }

    // GET /api/wal/history?jiraKey=JNY-1234&type=discovery&limit=50
    if (req.method === 'GET' && url.pathname === '/api/wal/history') {
      const entries = await walStore.queryHistory({
        jiraKey: url.searchParams.get('jiraKey') ?? undefined,
        type:    url.searchParams.get('type')    ?? undefined,
        agent:   url.searchParams.get('agent')   ?? undefined,
        since:   url.searchParams.get('since')   ?? undefined,
        limit:   Number(url.searchParams.get('limit') ?? 100),
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(entries));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, '127.0.0.1', () => {
    stateManager.updateServerInfo(port, `http://127.0.0.1:${port}`);
  });
}
