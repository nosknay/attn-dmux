#!/bin/bash
# Attentive-specific helpers for dmux hooks.
# Source this from hook files via: source "$DMUX_ROOT/.dmux-hooks/lib/attentive.sh"

# Detects which Attentive repo dmux is running in.
# Returns "java" for the Java/Gradle monorepo, "frontend" for the Nx/Yarn frontend repo.
detect_repo_type() {
  if [ -f "$DMUX_ROOT/settings.gradle.kts" ]; then
    echo "java"
  elif [ -f "$DMUX_ROOT/nx.json" ]; then
    echo "frontend"
  else
    echo "unknown"
  fi
}

# Returns space-separated list of changed Gradle module tasks, e.g. ":foo :bar"
# Only meaningful in the java repo.
get_changed_gradle_modules() {
  git diff --name-only master...HEAD | \
    grep -oP '^[^/]+' | sort -u | \
    xargs -I{} sh -c '[ -f "{}/build.gradle.kts" ] && echo ":{}"' | tr '\n' ' '
}

# Extracts JIRA key from branch name, e.g. "jny-1234-fix-auth" -> "JNY-1234"
extract_jira_key() {
  echo "$DMUX_BRANCH" | grep -oiP '^[a-z]+-[0-9]+' | tr '[:lower:]' '[:upper:]'
}

# Publish a message to the dmux bus.
# Includes pane identity from env vars; retries up to 3 times to handle
# the case where the server isn't fully up yet (e.g. early hook execution).
# Usage: bus_publish <type> <payload> [task_hint]
# Types: intent | discovery | blocked | done | needs-agent:sibling | needs-agent:worktree
bus_publish() {
  local type="$1" payload="$2" task_hint="${3:-}"
  local body
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
}))" "$DMUX_PANE_ID" "$DMUX_SLUG" "$DMUX_AGENT" "$type" "$payload" "$task_hint")"
  for i in 1 2 3; do
    curl -s -X POST "http://localhost:$DMUX_SERVER_PORT/api/bus" \
      -H "Content-Type: application/json" -d "$body" > /dev/null && return 0
    sleep 1
  done
  echo "[dmux] bus_publish: server unavailable after 3 attempts" >&2
}

# Read recent messages for the current session (optionally filtered).
# Usage: bus_read [query_params]
# Examples:
#   bus_read                          # all recent messages
#   bus_read "since=42"               # incremental — only messages after id 42
#   bus_read "type=spawned&since=42"  # filtered
bus_read() {
  curl -s "http://localhost:$DMUX_SERVER_PORT/api/bus?${1:-}"
}

