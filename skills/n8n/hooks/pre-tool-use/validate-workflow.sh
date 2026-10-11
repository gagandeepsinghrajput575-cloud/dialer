#!/usr/bin/env bash
# Portions of this file are adapted from the n8n-io/skills plugin
# (https://github.com/n8n-io/skills), licensed under Apache License 2.0.
# Adapted for the community n8n-mcp MCP server. See /NOTICES.
#
# Fires before validate_workflow / n8n_validate_workflow. Validation is the gate
# before activating; this is where the manual antipattern scan matters most,
# because validate_workflow does not catch any of the items below.
exec "$(dirname "$0")/_emit.sh" "validation-gate" \
"Before validating, run the antipattern scan node-by-node (invoke n8n-validation-expert and n8n-workflow-patterns via the Skill tool): Set nodes feeding only 1 consumer should be inlined; Code nodes doing pure field shaping should be Edit Fields with arrow functions; Merges with 3+ wires need numberOfInputs set explicitly; \$json.x in branchy workflows should be \$('Node').item.json.x; DateTime nodes should be Luxon expressions. validate_workflow does not catch any of these; only the manual scan does. Validation passing means the JSON is well-formed, not that the workflow is correct."
