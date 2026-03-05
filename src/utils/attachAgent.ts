/**
 * Attach a second (or Nth) agent to an existing worktree pane.
 *
 * Creates a new tmux pane that `cd`s into the same worktree directory,
 * launches the chosen agent, and returns a sibling DmuxPane that shares
 * the same worktreePath/branchName/projectRoot.
 */

import * as fs from 'fs';
import path from 'path';
import type { DmuxPane, DmuxConfig } from '../types.js';
import type { AgentName } from './agentLaunch.js';
import { launchAgentInPane } from './agentLaunch.js';
import { autoApproveTrustPrompt } from './paneCreation.js';
import { TmuxService } from '../services/TmuxService.js';
import { splitPane, getTerminalDimensions } from './tmux.js';
import { recalculateAndApplyLayout } from './layoutManager.js';
import { buildWorktreePaneTitle } from './paneTitle.js';
import { SettingsManager } from './settingsManager.js';
import { LogService } from '../services/LogService.js';
import { randomUUID } from 'crypto';
import { StateManager } from '../shared/StateManager.js';
import { triggerHook } from './hooks.js';

export interface AttachAgentOptions {
  targetPane: DmuxPane;
  prompt: string;
  agent: AgentName;
  existingPanes: DmuxPane[];
  sessionProjectRoot: string;
  sessionConfigPath: string;
}

/**
 * Generate a unique sibling slug like `fix-auth-a2`, `fix-auth-a3`, etc.
 */
export function generateSiblingSlugForTargetPane(
  targetPane: Pick<DmuxPane, 'slug' | 'worktreePath'>,
  existingPanes: ReadonlyArray<Pick<DmuxPane, 'slug'>>,
): string {
  // Always anchor attached-agent slugs to the real worktree directory name.
  // This avoids repeated suffixes when attaching from an already attached pane.
  const worktreeSlug = targetPane.worktreePath
    ? path.basename(targetPane.worktreePath)
    : '';
  const baseSlug = worktreeSlug || targetPane.slug;

  const siblingPrefix = `${baseSlug}-a`;
  let maxSibling = 1;

  for (const pane of existingPanes) {
    if (!pane.slug.startsWith(siblingPrefix)) continue;
    const suffix = pane.slug.slice(siblingPrefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    maxSibling = Math.max(maxSibling, Number.parseInt(suffix, 10));
  }

  return `${baseSlug}-a${maxSibling + 1}`;
}

export async function attachAgentToWorktree(
  options: AttachAgentOptions
): Promise<{ pane: DmuxPane }> {
  const {
    targetPane,
    prompt,
    agent,
    existingPanes,
    sessionProjectRoot,
    sessionConfigPath,
  } = options;

  if (!targetPane.worktreePath) {
    throw new Error('Target pane has no worktree to attach to');
  }

  const projectRoot = targetPane.projectRoot || sessionProjectRoot;
  const settingsManager = new SettingsManager(projectRoot);
  const settings = settingsManager.getSettings();

  // Generate a unique slug for this sibling
  const slug = generateSiblingSlugForTargetPane(targetPane, existingPanes);
  const siblingPaneId = `dmux-${randomUUID()}`;

  const tmuxService = TmuxService.getInstance();
  const originalPaneId = tmuxService.getCurrentPaneIdSync();

  // Load config to get control pane info
  let controlPaneId: string | undefined;
  try {
    const configContent = fs.readFileSync(sessionConfigPath, 'utf-8');
    const config: DmuxConfig = JSON.parse(configContent);
    controlPaneId = config.controlPaneId;
  } catch {
    controlPaneId = originalPaneId;
  }

  // Split from the last existing pane (standard grid placement)
  const dmuxPaneIds = existingPanes.map(p => p.paneId);
  const splitTarget = dmuxPaneIds[dmuxPaneIds.length - 1];
  const paneInfo = splitPane({ targetPane: splitTarget, cwd: projectRoot });

  // Wait for pane to be ready
  const start = Date.now();
  while ((Date.now() - start) < 600) {
    if (await tmuxService.paneExists(paneInfo)) break;
    await new Promise(r => setTimeout(r, 30));
  }

  // Set pane title
  try {
    const paneProjectName = targetPane.projectName || path.basename(projectRoot);
    const paneTitle = projectRoot === sessionProjectRoot
      ? slug
      : buildWorktreePaneTitle(slug, projectRoot, paneProjectName);
    await tmuxService.setPaneTitle(paneInfo, paneTitle);
  } catch {
    // Ignore title errors
  }

  // Recalculate layout
  if (controlPaneId) {
    const dimensions = getTerminalDimensions();
    const allContentPaneIds = [...existingPanes.map(p => p.paneId), paneInfo];
    await recalculateAndApplyLayout(
      controlPaneId,
      allContentPaneIds,
      dimensions.width,
      dimensions.height,
    );
    await tmuxService.refreshClient();
  }

  // cd into the existing worktree (no git worktree add)
  const cdCmd = `cd "${targetPane.worktreePath}"`;
  await tmuxService.sendShellCommand(paneInfo, cdCmd);
  await tmuxService.sendTmuxKeys(paneInfo, 'Enter');

  // Small delay for cd to complete
  await new Promise(r => setTimeout(r, 300));

  // Inject DMUX env vars so WAL helpers work in this pane's shell (Gap 1).
  // Values are single-quoted and internal single quotes escaped to handle any
  // special characters ($, ", `, etc.) that may appear in file system paths.
  const sq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  const serverPort = StateManager.getInstance().getState().serverPort ?? 3142;
  const envCmd = [
    'export',
    `DMUX_ROOT=${sq(projectRoot)}`,
    `DMUX_SERVER_PORT=${serverPort}`,
    `DMUX_PANE_ID=${sq(siblingPaneId)}`,
    `DMUX_SLUG=${sq(slug)}`,
    `DMUX_AGENT=${sq(agent)}`,
    `DMUX_WORKTREE_PATH=${sq(targetPane.worktreePath)}`,
    // Use the parent pane's branch/slug — siblings share the same git branch
    `DMUX_BRANCH=${sq(targetPane.branchName || targetPane.slug)}`,
  ].join(' ');
  await tmuxService.sendShellCommand(paneInfo, envCmd);
  await tmuxService.sendTmuxKeys(paneInfo, 'Enter');

  // Launch the agent
  await launchAgentInPane({
    paneId: paneInfo,
    agent,
    prompt,
    slug,
    projectRoot,
    permissionMode: settings.permissionMode,
  });

  // Auto-approve trust prompts for Claude
  if (agent === 'claude') {
    autoApproveTrustPrompt(paneInfo, prompt).catch(() => {
      // Ignore errors in background monitoring
    });
  }

  // Keep focus on the new pane
  await tmuxService.selectPane(paneInfo);

  // Build the sibling pane object — shares worktree/branch with target
  const newPane: DmuxPane = {
    id: siblingPaneId,
    slug,
    branchName: targetPane.branchName,
    prompt: prompt || 'No initial prompt',
    paneId: paneInfo,
    projectRoot,
    projectName: targetPane.projectName,
    worktreePath: targetPane.worktreePath,
    agent,
    autopilot: settings.enableAutopilotByDefault ?? false,
  };

  // Fire pane_created hook so sibling is visible to hook scripts (Gap 2).
  // DMUX_IS_SIBLING=1 lets hook scripts distinguish this from a fresh pane
  // with a newly created worktree and skip any worktree-init side effects.
  triggerHook('pane_created', projectRoot, newPane, { DMUX_IS_SIBLING: '1' }).catch(() => {
    // Ignore hook errors — don't block agent launch
  });

  // Switch focus back to control pane
  await tmuxService.selectPane(originalPaneId);

  // Re-set the dmux sidebar title
  try {
    await tmuxService.setPaneTitle(originalPaneId, "dmux");
  } catch {
    // Ignore title errors
  }

  LogService.getInstance().info(
    `Attached ${agent} to worktree ${targetPane.worktreePath} as ${slug}`,
    'attachAgent',
  );

  return { pane: newPane };
}
