import { createServer, type ServerResponse } from 'http';
import type { StateManager } from '../shared/StateManager.js';
import { BusStore, type BusMessageType } from './BusStore.js';
import type { AgentName } from '../utils/agentLaunch.js';
import { isAgentName } from '../utils/agentLaunch.js';
import { filterEnabledAgents, getInstalledAgents } from '../utils/agentDetection.js';

// Task hint → capability tier fallback mapping
const TASK_HINT_TIER: Record<string, 'fast' | 'smart'> = {
  'code-generation': 'fast',
  'test-writing':    'fast',
  'research':        'smart',
  'review':          'smart',
  'planning':        'smart',
  'debugging':       'smart',
};

async function resolveAgent(
  taskHint: string | null | undefined,
  stateManager: StateManager,
): Promise<AgentName | undefined> {
  const state = stateManager.getState();
  const settings = state.settings ?? {};
  const taskAgentMap: Record<string, string> = (settings as any).taskAgentMap ?? {};

  const installedAgents = await getInstalledAgents();
  const enabledAgents = filterEnabledAgents(installedAgents, (settings as any).enabledAgents);
  const available = enabledAgents.length > 0 ? enabledAgents : installedAgents;

  const isAvailable = (name: string): name is AgentName =>
    isAgentName(name) && available.includes(name as AgentName);

  // Tier 1: task category lookup
  if (taskHint && taskAgentMap[taskHint] && isAvailable(taskAgentMap[taskHint])) {
    return taskAgentMap[taskHint] as AgentName;
  }

  // Tier 2: task hint → built-in tier fallback
  if (taskHint) {
    const tier = TASK_HINT_TIER[taskHint];
    if (tier && taskAgentMap[tier] && isAvailable(taskAgentMap[tier])) {
      return taskAgentMap[tier] as AgentName;
    }
  }

  // Tier 3: session default
  const defaultAgent = (settings as any).defaultAgent;
  if (defaultAgent && isAvailable(defaultAgent)) return defaultAgent as AgentName;

  // Final fallback: first available
  return available[0];
}

export async function startDmuxServer(
  stateManager: StateManager,
  port: number,
): Promise<void> {
  const busStore = new BusStore();
  const sseClients: ServerResponse[] = [];

  // Push new bus messages to all SSE clients
  busStore.on('message', (msg) => {
    const data = `data: ${JSON.stringify(msg)}\n\n`;
    for (const client of sseClients) {
      try { client.write(data); } catch { /* client disconnected */ }
    }
  });

  // Internal coordinator: watch for needs-agent messages and spawn panes
  busStore.on('message', async (msg) => {
    if (msg.type !== 'needs-agent:sibling' && msg.type !== 'needs-agent:worktree') return;

    const state = stateManager.getState();

    // Backpressure: ignore if a previous spawn is already in-flight for this pane
    if (busStore.hasPendingSpawn(msg.session_id, msg.pane_id, msg.id)) return;

    const agent = await resolveAgent(msg.task_hint, stateManager);
    if (!agent) return;

    try {
      if (msg.type === 'needs-agent:sibling') {
        const panes: any[] = state.panes ?? [];
        const targetPane = panes.find((p: any) => p.id === msg.pane_id);
        if (!targetPane?.worktreePath) return;

        const { attachAgentToWorktree } = await import('../utils/attachAgent.js');
        const result = await attachAgentToWorktree({
          targetPane,
          prompt: msg.payload,
          agent,
          existingPanes: panes,
          sessionProjectRoot: state.projectRoot ?? '',
          sessionConfigPath: state.panesFile ?? '',
        });

        busStore.append({
          session_id: msg.session_id,
          pane_id:    'dmux',
          slug:       'dmux',
          agent:      'dmux',
          type:       'spawned',
          payload:    JSON.stringify({ requestId: String(msg.id), slug: result.pane.slug, agent }),
        });
      } else {
        // needs-agent:worktree
        const { createPane } = await import('../utils/paneCreation.js');
        const panes: any[] = state.panes ?? [];
        const result = await createPane(
          {
            prompt:           msg.payload,
            agent,
            projectName:      state.projectName ?? '',
            existingPanes:    panes,
            projectRoot:      state.projectRoot,
            sessionConfigPath: state.panesFile,
            sessionProjectRoot: state.projectRoot,
          },
          [agent],
        );

        if ('pane' in result) {
          busStore.append({
            session_id: msg.session_id,
            pane_id:    'dmux',
            slug:       'dmux',
            agent:      'dmux',
            type:       'spawned',
            payload:    JSON.stringify({ requestId: String(msg.id), slug: result.pane.slug, agent }),
          });
        }
      }
    } catch (err) {
      // Don't crash the server on spawn errors
      console.error('[dmux-server] spawn error:', err);
    }
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`);

    // ── GET /api/bus ──────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/bus') {
      const sessionId = stateManager.getState().sessionName ?? '';
      const sinceRaw = Number(url.searchParams.get('since'));
      const since = url.searchParams.has('since') && !isNaN(sinceRaw) ? sinceRaw : undefined;
      const type = url.searchParams.get('type') ?? undefined;
      const messages = busStore.query(sessionId, { since, type });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages));
      return;
    }

    // ── POST /api/bus ─────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/bus') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const sessionId = stateManager.getState().sessionName ?? '';
          const msg = busStore.append({
            session_id: sessionId,
            pane_id:    parsed.pane_id ?? '',
            slug:       parsed.slug    ?? '',
            agent:      parsed.agent   ?? '',
            type:       parsed.type    as BusMessageType,
            payload:    parsed.payload ?? '',
            task_hint:  parsed.task_hint ?? null,
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(msg));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
      });
      return;
    }

    // ── GET /api/bus/stream ───────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/bus/stream') {
      res.writeHead(200, {
        'Content-Type':  'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection':    'keep-alive',
      });
      // Send existing messages as initial replay
      const sessionId = stateManager.getState().sessionName ?? '';
      const lastSeenRaw = Number(url.searchParams.get('since'));
      const lastSeen = url.searchParams.has('since') && !isNaN(lastSeenRaw) ? lastSeenRaw : undefined;
      const existing = busStore.query(sessionId, { since: lastSeen });
      for (const msg of existing) {
        res.write(`data: ${JSON.stringify(msg)}\n\n`);
      }
      sseClients.push(res);
      req.on('close', () => {
        const idx = sseClients.indexOf(res);
        if (idx !== -1) sseClients.splice(idx, 1);
      });
      return;
    }

    // ── PUT /api/panes/:id/test ───────────────────────────────────────
    if (req.method === 'PUT' && url.pathname.match(/^\/api\/panes\/[^/]+\/test$/)) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const paneId = url.pathname.split('/')[3];
          stateManager.updatePaneTestStatus(paneId, parsed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    // ── PUT /api/panes/:id/dev ────────────────────────────────────────
    if (req.method === 'PUT' && url.pathname.match(/^\/api\/panes\/[^/]+\/dev$/)) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const paneId = url.pathname.split('/')[3];
          stateManager.updatePaneDevStatus(paneId, parsed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, '127.0.0.1', () => {
    stateManager.updateServerInfo(port, `http://127.0.0.1:${port}`);
  });
}
