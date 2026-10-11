#!/usr/bin/env bash
# Portions of this file are adapted from the n8n-io/skills plugin
# (https://github.com/n8n-io/skills), licensed under Apache License 2.0.
# Adapted for the community n8n-mcp MCP server. See /NOTICES.
#
# Fires before n8n_instances (list/switch). This tool only exists on
# multi-instance accounts, where every other n8n tool routes to the
# currently-targeted instance with no per-call override and no error on a
# misroute. One-shot per session — the rules are a mental model, not a
# per-call checklist.
exec "$(dirname "$0")/_emit.sh" "multi-instance" \
"Before listing or switching instances: invoke the n8n-multi-instance skill via the Skill tool. Every n8n tool routes to the currently-targeted instance — there is no per-call instance argument, and a wrong target is usually silent (reads/non-credential writes). Switch in its OWN turn (never batch a switch with a dependent call; parallel-batch order isn't guaranteed, so the dependent call can resolve against the previous instance). Verify current with n8n_instances list immediately before any credential create/update/delete — the server fail-closes only the ambiguous case (INSTANCE_AMBIGUOUS), not an explicit wrong switch. An unexpected NOT_FOUND is almost always a wrong-instance misroute, not a deletion: verify and retry, do not recreate."
