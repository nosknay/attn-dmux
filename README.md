<p align="center">
  <img src="./dmux.png" alt="dmux logo" width="400" />
</p>

<h3 align="center">Parallel agents with tmux and worktrees</h3>

<p align="center">
  Manage multiple AI coding agents in isolated git worktrees.<br/>
  Branch, develop, and merge &mdash; all in parallel.
</p>

<p align="center">
  <a href="https://dmux.ai"><strong>Documentation</strong></a> &nbsp;&middot;&nbsp;
  <a href="https://dmux.ai#getting-started"><strong>Getting Started</strong></a> &nbsp;&middot;&nbsp;
  <a href="https://github.com/formkit/dmux/issues"><strong>Issues</strong></a>
</p>

---

<img src="./dmux.webp" alt="dmux demo" width="100%" />

## Install

```bash
npm install -g dmux
```

## Quick Start

```bash
cd /path/to/your/project
dmux
```

Press `n` to create a new pane, type a prompt, pick one or more agents (or none for a plain terminal), and dmux handles the rest &mdash; worktree, branch, and agent launch.

## What it does

dmux creates a tmux pane for each task. Every pane gets its own git worktree and branch so agents work in complete isolation. When a task is done, open the pane menu with `m` and choose Merge to bring it back into your main branch.

- **Worktree isolation** &mdash; each pane is a full working copy, no conflicts between agents
- **Agent support** &mdash; Claude Code, Codex, OpenCode, Cline CLI, Gemini CLI, Qwen CLI, Amp CLI, pi CLI, Cursor CLI, Copilot CLI, and Crush CLI
- **Multi-select launches** &mdash; choose any combination of enabled agents per prompt
- **AI naming** &mdash; branches and commit messages generated automatically
- **Smart merging** &mdash; auto-commit, merge, and clean up in one step
- **macOS notifications** &mdash; background panes can send native attention alerts when they settle and need you
- **Built-in file browser** &mdash; inspect a pane's worktree, search files, and preview code or diffs without leaving dmux
- **Pane visibility controls** &mdash; hide individual panes, isolate one project, or restore everything later without stopping work
- **Multi-project** &mdash; add multiple repos to the same session
- **Lifecycle hooks** &mdash; run scripts on worktree create, pre-merge, post-merge, and more
- **Message bus** &mdash; agents communicate and spawn new panes via a shared SQLite-backed bus

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `n` | New pane (worktree + agent) |
| `t` | New terminal pane |
| `j` / `Enter` | Jump to pane |
| `m` | Open pane menu |
| `f` | Browse files in selected pane's worktree |
| `x` | Close pane |
| `h` | Hide/show selected pane |
| `H` | Hide/show all other panes |
| `p` | New pane in another project |
| `P` | Show only the selected project's panes, then show all |
| `s` | Settings |
| `q` | Quit |

## Requirements

- tmux 3.0+
- Node.js 18+
- Git 2.20+
- At least one supported agent CLI (for example [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [OpenCode](https://github.com/opencode-ai/opencode), [Cline CLI](https://docs.cline.bot/cline-cli/getting-started), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Qwen CLI](https://github.com/QwenLM/qwen-code), [Amp CLI](https://ampcode.com/manual), [pi CLI](https://www.npmjs.com/package/@mariozechner/pi-coding-agent), [Cursor CLI](https://docs.cursor.com/en/cli/overview), [Copilot CLI](https://github.com/github/copilot-cli), [Crush CLI](https://github.com/charmbracelet/crush))
- [OpenRouter API key](https://openrouter.ai/) (optional, for AI branch names and commit messages)

## Message Bus

dmux runs a lightweight HTTP server that agents can use to coordinate across panes. Each worktree gets shell helpers sourced automatically via the `worktree_created` hook.

```bash
source "$DMUX_ROOT/.dmux-hooks/lib/attentive.sh"

# Publish messages to the shared bus
bus_publish "intent"    "about to modify AccountService.java"
bus_publish "discovery" "found an unused config key in param store"
bus_publish "done"      "PR opened: $DMUX_SLUG"

# Request dmux to spawn a new agent pane
# task hints: code-generation | test-writing | research | review | planning | debugging
bus_publish "needs-agent:sibling"  "write unit tests for AccountService.java" "test-writing"
bus_publish "needs-agent:worktree" "extract PaymentGateway into its own service" "code-generation"

# Read messages from other agents
bus_read                  # all messages this session
bus_read "since=42"       # incremental — only messages after id 42
```

When an agent publishes a `needs-agent` message, dmux resolves the best available agent (using `taskAgentMap` in `~/.dmux.global.json`) and spawns a new pane automatically. The resolved agent and new pane slug are written back to the bus as a `spawned` message.

## Documentation

Full documentation is available at **[dmux.ai](https://dmux.ai)**, including setup guides, configuration, and hooks.

## Contributing

See **[CONTRIBUTING.md](./CONTRIBUTING.md)** for the recommended local "dmux-on-dmux" development loop, hook setup, and PR workflow.

## License

MIT
