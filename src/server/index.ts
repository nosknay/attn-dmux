import { createServer, type ServerResponse } from 'http';
import { mkdirSync, writeFileSync, chmodSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import type { StateManager } from '../shared/StateManager.js';
import { BusStore, type BusMessageType } from './BusStore.js';
import type { AgentName } from '../utils/agentLaunch.js';
import { isAgentName } from '../utils/agentLaunch.js';
import { filterEnabledAgents, getInstalledAgents } from '../utils/agentDetection.js';

const DMUX_BIN = path.join(homedir(), '.dmux', 'bin');

function installBusScripts(): void {
  mkdirSync(DMUX_BIN, { recursive: true });

  const publish = path.join(DMUX_BIN, 'bus_publish');
  writeFileSync(publish, `#!/bin/bash
# Publish a message to the dmux bus.
# Usage: bus_publish <type> <payload> [task_hint]
type="$1" payload="$2" task_hint="\${3:-}"
if [ -z "$type" ] || [ -z "$payload" ]; then
  echo "Usage: bus_publish <type> <payload> [task_hint]" >&2; exit 1
fi
if [ -z "$DMUX_SERVER_PORT" ]; then
  echo "[dmux] bus_publish: DMUX_SERVER_PORT not set" >&2; exit 1
fi
body="$(python3 -c "
import json, sys
hint = sys.argv[6]
print(json.dumps({
  'pane_id':  sys.argv[1],
  'slug':     sys.argv[2],
  'agent':    sys.argv[3],
  'type':     sys.argv[4],
  'payload':  sys.argv[5],
  'task_hint': hint if hint else None,
}))" "\${DMUX_PANE_ID:-}" "\${DMUX_SLUG:-}" "\${DMUX_AGENT:-}" "$type" "$payload" "$task_hint")"
for i in 1 2 3; do
  curl -s -X POST "http://localhost:$DMUX_SERVER_PORT/api/bus" \\
    -H "Content-Type: application/json" -d "$body" > /dev/null && exit 0
  sleep 1
done
echo "[dmux] bus_publish: server unavailable after 3 attempts" >&2; exit 1
`);
  chmodSync(publish, 0o755);

  const read = path.join(DMUX_BIN, 'bus_read');
  writeFileSync(read, `#!/bin/bash
# Read messages from the dmux bus for the current session.
# Usage: bus_read [query_params]
if [ -z "$DMUX_SERVER_PORT" ]; then
  echo "[dmux] bus_read: DMUX_SERVER_PORT not set" >&2; exit 1
fi
curl -s "http://localhost:$DMUX_SERVER_PORT/api/bus?\${1:-}"
`);
  chmodSync(read, 0o755);

  const batch = path.join(DMUX_BIN, 'dmux-batch');
  writeFileSync(batch, `#!/bin/bash
# Run a batch of tasks through dmux.
# dmux must already be running (or will be started detached).
#
# Usage: dmux-batch <tasks.json> [project-dir]
#
# tasks.json format:
#   [
#     { "prompt": "JNY-1234: implement foo", "hint": "code-generation" },
#     { "prompt": "JNY-1235: write tests for foo", "hint": "test-writing" }
#   ]
#
# Attach to the session at any time:
#   tmux attach -t <session printed on start>

set -e

TASKS_FILE="\${1:-}"
PROJECT_DIR="\${2:-\$(pwd)}"
PORT="\${DMUX_SERVER_PORT:-3142}"

if [ -z "$TASKS_FILE" ] || [ ! -f "$TASKS_FILE" ]; then
  echo "Usage: dmux-batch <tasks.json> [project-dir]" >&2
  exit 1
fi

# ── Start dmux if not already running ────────────────────────────────────────
if ! curl -s "http://localhost:\${PORT}/api/bus" > /dev/null 2>&1; then
  echo "[dmux-batch] Starting dmux in detached session..."
  SESSION="dmux-batch-\$(date +%s)"
  tmux new-session -d -s "\$SESSION" -c "\$PROJECT_DIR" "cd '\$PROJECT_DIR' && dmux"

  echo "[dmux-batch] Waiting for server on port \${PORT}..."
  for i in \$(seq 1 30); do
    curl -s "http://localhost:\${PORT}/api/bus" > /dev/null 2>&1 && break
    sleep 1
    if [ "\$i" -eq 30 ]; then
      echo "[dmux-batch] Timed out waiting for dmux server" >&2; exit 1
    fi
  done
  echo "[dmux-batch] Server ready."
  echo ""
  echo "  Connect: tmux attach -t \$SESSION"
  echo "  Detach:  Ctrl-b d"
  echo ""
else
  echo "[dmux-batch] dmux server already running on port \${PORT}"
fi

# ── Post tasks to the bus ─────────────────────────────────────────────────────
TOTAL=\$(python3 -c "import json; print(len(json.load(open('\$TASKS_FILE'))))")
echo "[dmux-batch] Posting \$TOTAL task(s) from \$TASKS_FILE..."

python3 << PYEOF
import json, urllib.request, urllib.error, os, time

port = os.environ.get('DMUX_SERVER_PORT', '3142')
tasks = json.load(open('\$TASKS_FILE'))

for i, task in enumerate(tasks, 1):
    prompt   = task.get('prompt', '')
    hint     = task.get('hint', '') or None

    if not prompt:
        print(f"  [{i}/{len(tasks)}] skipped (no prompt)")
        continue

    body = json.dumps({
        'pane_id':   '',
        'slug':      '',
        'agent':     '',
        'type':      'needs-agent:worktree',
        'payload':   prompt,
        'task_hint': hint,
    }).encode()

    req = urllib.request.Request(
        f'http://localhost:{port}/api/bus',
        data=body,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            msg = json.loads(r.read())
            print(f"  [{i}/{len(tasks)}] queued id={msg['id']} hint={hint or '-'}: {prompt[:60]}")
    except Exception as e:
        print(f"  [{i}/{len(tasks)}] FAILED: {e}")

    # Small delay so coordinator doesn't get flooded
    time.sleep(0.3)
PYEOF

echo ""
echo "[dmux-batch] All tasks queued. Panes are being spawned by dmux."
echo "             Monitor: bus_read | python3 -m json.tool"
`);
  chmodSync(batch, 0o755);
}

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
  installBusScripts();
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

    console.error(`[dmux-coordinator] received ${msg.type} id=${msg.id} pane=${msg.pane_id} hint=${msg.task_hint ?? '-'}`);

    const state = stateManager.getState();

    // Backpressure: ignore if a previous spawn is already in-flight for this pane
    if (busStore.hasPendingSpawn(msg.session_id, msg.pane_id, msg.id)) {
      console.error(`[dmux-coordinator] backpressure: pending spawn for pane=${msg.pane_id}, skipping id=${msg.id}`);
      return;
    }

    const agent = await resolveAgent(msg.task_hint, stateManager);
    if (!agent) {
      console.error(`[dmux-coordinator] no agent resolved (hint=${msg.task_hint ?? '-'}, settings=${JSON.stringify((state.settings as any)?.enabledAgents ?? 'unset')})`);
      return;
    }

    console.error(`[dmux-coordinator] spawning agent=${agent} for id=${msg.id}`);

    try {
      if (msg.type === 'needs-agent:sibling') {
        const panes: any[] = state.panes ?? [];
        const targetPane = panes.find((p: any) => p.id === msg.pane_id);
        if (!targetPane?.worktreePath) {
          console.error(`[dmux-coordinator] sibling: target pane ${msg.pane_id} not found or has no worktreePath`);
          return;
        }

        const { attachAgentToWorktree } = await import('../utils/attachAgent.js');
        const result = await attachAgentToWorktree({
          targetPane,
          prompt: msg.payload,
          agent,
          existingPanes: panes,
          sessionProjectRoot: state.projectRoot ?? '',
          sessionConfigPath: state.panesFile ?? '',
        });

        console.error(`[dmux-coordinator] spawned sibling pane slug=${result.pane.slug}`);
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

        if (result.pane) {
          console.error(`[dmux-coordinator] spawned worktree pane slug=${result.pane.slug}`);
          busStore.append({
            session_id: msg.session_id,
            pane_id:    'dmux',
            slug:       'dmux',
            agent:      'dmux',
            type:       'spawned',
            payload:    JSON.stringify({ requestId: String(msg.id), slug: result.pane.slug, agent }),
          });
        } else {
          console.error(`[dmux-coordinator] createPane returned no pane (needsAgentChoice=${result.needsAgentChoice})`);
        }
      }
    } catch (err) {
      // Don't crash the server on spawn errors
      console.error('[dmux-coordinator] spawn error:', err);
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
