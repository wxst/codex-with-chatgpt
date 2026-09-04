# Architecture

```text
ChatGPT standby Chats (one Project)
        │ background direct messages
        ▼
Codex App tools: list_threads / read_thread / send_message_to_thread
        │
        ▼
Global C2C Router ── existing OpenAI Secure MCP Tunnel ── ChatGPT connector
        │ route_token per MCP call
        ▼
Fresh read-only Workspace instance
        │
        ▼
Codex edits, commands, tests, and Git
```

## Router

`src/router/state.ts` stores the anchor, registered workspace paths, health
metadata, and hashed task route capabilities. `src/router/server.ts` starts a
normal Bridge at the anchor but supplies a routed MCP factory. The existing
Tunnel alias, port, and connector remain attached to the anchor.

`src/mcp/server.ts` retains the eight read-only tools. Legacy single-workspace
bridges use their original schemas. Router bridges require `route_token` on all
eight tool schemas and resolve the workspace per request.

## Session pool

`src/session/state.ts` holds task delivery state plus a global standby-pool
registry. Pool entries carry the verified Project id, marker user-message id,
marker class, FIFO time, and irreversible task claim. Only metadata is stored;
no raw capability token or claimed Chat model name is fabricated.

## Boundaries

- ChatGPT executes no shell, writes, deletes, package actions, or Git mutations.
- Codex App direct tools are the Chat control plane.
- The MCP Router is the source-data plane.
- ChatGPT Work, web pages, browser automation, UIA, ChatGPT Classic, drafts,
  and clipboard interaction are excluded.
