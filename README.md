# Snapshot Canvas

A collaborative pixel drawing app built with Cloudflare Workers, Durable Objects, Containers, and Container snapshots.

Each canvas ID maps to one Durable Object and one Durable Object-managed Container. The Durable Object orders and broadcasts brush strokes over WebSockets, while the Container owns the authoritative RGBA image and stores it at `/data/canvas.png`. Immutable Container snapshots act as commits in each canvas's history.

See [`plan.md`](./plan.md) for the full architecture and delivery plan.

## Current features

- Home page for creating a canvas or joining one by ID
- Shareable canvas URLs at `/canvas/:id`
- Canvas dimensions from 128×128 through 1024×1024
- Circular brush and eraser from 1 through 64 pixels
- Color and background pickers
- Collaborative drawing, live viewer presence, and remote cursors over WebSockets
- Hoverable remote cursors that reveal each viewer's display name
- Cloud-formation guest names with optional custom display names
- Presence heartbeats and stale-viewer cleanup
- Client-side zoom from 25% through 3200%
- Space-drag panning
- Container snapshots represented as named commits
- Parent-linked commit history and collaborative reset
- Forking the current canvas into a new canvas and Container
- One Container per canvas ID

## Architecture

```text
Browser ──HTTP/WebSocket──> Worker ──> Canvas Durable Object
                                             │
                                             │ private HTTP
                                             ▼
                                      Canvas Container
                                      /data/canvas.png
```

The Container is authoritative for pixels. The Durable Object is authoritative for stroke ordering, revisions, connected clients, and snapshot metadata.

## Prerequisites

- Node.js and pnpm
- Docker
- Go 1.24 for local Container tests
- A Cloudflare account with Workers, Containers, Container snapshots, and the new runtime enabled

The project currently uses Wrangler's latest `main` preview build because the Container instance and snapshot APIs are preview features.

## Install and verify

```bash
pnpm install
pnpm exec tsc --noEmit
cd container && go test ./...
```

## Deploy

Authenticate and deploy with the preview Wrangler build:

```bash
pnpm run wrangler -- whoami
pnpm run deploy
```

Wrangler builds and pushes `container/Dockerfile`, deploys the Worker, and creates the Durable Object-managed Container application.

Open the resulting Worker URL to reach the home page. Create a new canvas with a unique ID, or join an existing canvas using an ID shared by another user. Canvas URLs are directly shareable:

```text
https://your-worker.your-subdomain.workers.dev/canvas/weekend-doodles
```

## Using the canvas

1. On the home page, choose a name, unique canvas ID, and dimensions.
2. Select **Create canvas**.
3. Share the resulting `/canvas/:id` URL, or have another user enter its ID under **Join a canvas**.
4. Choose a brush color and size, then draw.
5. Use the mouse wheel to zoom.
6. Hold Space and drag to pan.
7. Select **Commit snapshot** and enter a commit message.
8. Use the 👁, ⑂, and ↶ commit actions to preview, fork, or reset to a commit.
9. Commit previews open at a shareable, read-only `/canvas/:id/commits/:commitId` page.
10. Select **Fork** in the header to clone the current working image into a new canvas.

Canvas creation is idempotent. Reopening an existing ID uses its original dimensions and background.

## HTTP and WebSocket API

```text
POST /api/canvases/:id
GET  /api/canvases/:id
GET  /api/canvases/:id/image
GET  /api/canvases/:id/connect       # WebSocket upgrade
POST /api/canvases/:id/commits
GET  /api/canvases/:id/commits
GET  /api/canvases/:id/commits/:commitId
GET  /api/canvases/:id/commits/:commitId/image
POST /api/canvases/:id/commits/:commitId/fork
POST /api/canvases/:id/commits/:commitId/reset
POST /api/canvases/:id/fork
```

Create or open a canvas:

```bash
export BASE="https://your-worker.your-subdomain.workers.dev"

curl -X POST "$BASE/api/canvases/demo" \
  -H 'Content-Type: application/json' \
  --data '{"name":"Demo","width":256,"height":256,"background":"#ffffff"}'
```

Fetch the authoritative PNG:

```bash
curl "$BASE/api/canvases/demo/image" --output demo.png
```

Create a commit backed by a Container snapshot:

```bash
curl -X POST "$BASE/api/canvases/demo/commits" \
  -H 'Content-Type: application/json' \
  --data '{"message":"First sketch","author":"Cirrus"}'
```

List commits:

```bash
curl "$BASE/api/canvases/demo/commits"
```

Reset using an ID returned by the list endpoint:

```bash
curl -X POST "$BASE/api/canvases/demo/commits/COMMIT_ID/reset"
```

## Container API

The Container is only reached through its owning Durable Object:

```text
POST /initialize
POST /strokes
POST /flush
GET  /canvas.png
GET  /metadata
GET  /health
```

Before creating a commit, the Durable Object calls `/flush` so its Container snapshot includes an atomically written PNG and metadata file. Reset destroys the running Container, starts from the selected immutable snapshot, verifies its metadata, and broadcasts a full image reset to connected clients. Read-only commit pages use an ephemeral preview Container restored from the commit and stopped after inactivity.

## Presence lifecycle

Open tabs send a small heartbeat every 20 seconds. Normal navigation and tab closure explicitly close the WebSocket through `pagehide`. A Durable Object alarm runs every 30 seconds and removes connections that have not been seen for 90 seconds. Heartbeats stay entirely in the Durable Object and never contact the canvas Container or write a timestamp to persistent storage.

## Current limitations

- Snapshots are preview functionality and should not be treated as permanent backups.
- The current MVP creates manual snapshots; automatic rolling snapshots are still planned.
- When a stopped or replaced Container is needed again, the canvas restores its `HEAD` commit. Uncommitted work that existed only in the previous Container is discarded.
- A canvas with no commits has no recovery checkpoint if its Container is replaced.
- Authentication, permissions, and presence cursors are not implemented yet.
- Forking depends on snapshot handles being reusable across Durable Object-managed Containers in the deployed preview runtime.
- Optimistic browser rendering uses Canvas 2D strokes while the Container uses its own circle-stamping rasterizer, so a reconnect may produce very small edge differences until the browser reloads the canonical PNG.
