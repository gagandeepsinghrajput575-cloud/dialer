#!/usr/bin/env bash
# Portions of this file are adapted from the n8n-io/skills plugin
# (https://github.com/n8n-io/skills), licensed under Apache License 2.0.
# Adapted for the community n8n-mcp MCP server. See /NOTICES.
#
# Fires before n8n_update_partial_workflow / n8n_update_full_workflow. Updates
# touch connections, where the most subtle bugs live (silently dropped wires,
# Merge index off-by-one).
exec "$(dirname "$0")/_emit.sh" "connections" \
"Before updating: after applying the operations, verify the connections object with n8n_get_workflow. validate_workflow does not catch every multi-input wiring trap. For Merge node specifics (numberOfInputs, input index off-by-one) see n8n-node-configuration; for wiring that survives into runtime see n8n-validation-expert; for per-node error outputs (onError + wiring main[1]) see n8n-error-handling. Invoke them via the Skill tool."
