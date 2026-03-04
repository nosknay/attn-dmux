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

# WAL helpers — require DMUX_SERVER_PORT to be set (injected by dmux into hook/pane environments)

# Append an entry to the WAL
# Usage: wal_write <type> <payload>
# Types: discovery | intent | blocked | done
wal_write() {
  local type="$1" payload="$2"
  curl -s -X POST "http://localhost:$DMUX_SERVER_PORT/api/wal" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg paneId  "$DMUX_PANE_ID" \
      --arg slug    "$DMUX_SLUG" \
      --arg agent   "$DMUX_AGENT" \
      --arg type    "$type" \
      --arg payload "$payload" \
      '{paneId:$paneId,slug:$slug,agent:$agent,type:$type,payload:$payload}')" > /dev/null
}

# Read all WAL entries for the current session
wal_read() {
  curl -s "http://localhost:$DMUX_SERVER_PORT/api/wal"
}

# Query WAL history across sessions
# Usage: wal_history "jiraKey=JNY-1234&type=discovery&limit=50"
wal_history() {
  curl -s "http://localhost:$DMUX_SERVER_PORT/api/wal/history?${1:-}"
}
