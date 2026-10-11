#!/usr/bin/env bash
# Portions of this file are adapted from the n8n-io/skills plugin
# (https://github.com/n8n-io/skills), licensed under Apache License 2.0.
# Adapted for the community n8n-mcp MCP server. See /NOTICES.
#
# Fires before n8n_create_workflow. A new workflow means architecture, naming,
# and reuse decisions need to happen before the JSON lands.
exec "$(dirname "$0")/_emit.sh" "create-workflow" \
"Before creating: invoke n8n-workflow-patterns (pick the right architecture — webhook / HTTP API / database / AI agent / scheduled / batch — name nodes for what they do, add sticky notes capturing the why) and n8n-subworkflows (search existing workflows with n8n_list_workflows and reuse a sub-workflow before duplicating logic) via the Skill tool. Pass skillsUsed if your server's create tool accepts it."
