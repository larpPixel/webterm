# webterm-7421

Minimal monorepo for a web-exposed terminal behind Cloudflare Tunnel.

## Workspace layout

- `apps/web`: SvelteKit app for the browser client
- `apps/server`: Bun server that owns terminal sessions, PTYs, and WebSockets
- `packages/protocol`: shared request and WebSocket message types

## Current scope

This first cut focuses on terminal logic instead of terminal polish:

- PTY-backed shell sessions
- WebSocket streaming for input and output
- idle session cleanup for reconnect-friendly behavior
- a plain Svelte page to exercise the session lifecycle

## Commands

```bash
bun run dev:server
bun run dev:web
```

```bash
bun run build
bun run build:web
bun run build:server
```

```bash
bun run check:server
bun run check:web
bun run lint:web
```

## Environment

Copy these as needed:

- `apps/server/.env.example`
- `apps/web/.env.example`

Cloudflare Tunnel can point at the web app, the Bun server, or a future single-entry reverse proxy once the terminal UI is in place.
