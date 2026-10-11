#!/usr/bin/env bash
# Portions of this file are adapted from the n8n-io/skills plugin
# (https://github.com/n8n-io/skills), licensed under Apache License 2.0.
# Adapted for the community n8n-mcp MCP server. See /NOTICES.
#
# Fires before n8n_manage_credentials. Credentials hold live secrets, so this
# is the highest-stakes call: a misrouted write puts a secret on the wrong
# instance, and on multi-instance accounts nothing downstream stops it. The
# reminder serves single-instance users too (credential discipline). One-shot.
exec "$(dirname "$0")/_emit.sh" "credentials" \
"Before a credential operation: invoke n8n-mcp-tools-expert via the Skill tool. Credentials hold live secrets — use the credential system and getSchema, never inline tokens into text fields. If this account has multiple n8n instances (the n8n_instances tool is present), ALSO invoke n8n-multi-instance: a credential create/update/delete routes to the currently-selected instance. The server fail-closes only the AMBIGUOUS case with INSTANCE_AMBIGUOUS (this session never switched; switch on this session, then retry) — an explicit switch to the wrong instance still writes the secret there, so verify current (n8n_instances list) immediately before the write."
