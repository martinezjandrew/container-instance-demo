# Snapshot Canvas

A collaborative pixel drawing app built with Cloudflare Workers, Durable Objects, Containers, and Container snapshots.

Each canvas ID maps to one Durable Object and one Durable Object-managed Container. The Durable Object orders and broadcasts brush strokes over WebSockets, while the Container owns the authoritative RGBA image and stores it at `/data/canvas.png`. Named Container snapshots provide revision checkpoints and restore.

See [`plan.md`](./plan.md) for the full architecture and delivery plan.

## Current features

- Home page for creating a canvas or joining one by ID
- Shareable canvas URLs at `/canvas/:id`
- Canvas dimensions from 128×128 through 1024×1024
- Circular brush and eraser from 1 through 64 pixels
- Color and background pickers
- Collaborative drawing over WebSockets
- Client-side zoom from 25% through 3200%
- Space-drag panning
- Named Container snapshots
- Snapshot history and collaborative restore
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
7. Select **Save snapshot** to create a named checkpoint.
8. Select **Restore** beside a snapshot to return every collaborator to that revision.
9. Select **Fork canvas** to clone the current image into a new canvas with its own URL and Container.

Canvas creation is idempotent. Reopening an existing ID uses its original dimensions and background.

## HTTP and WebSocket API

```text
POST /api/canvases/:id
GET  /api/canvases/:id
GET  /api/canvases/:id/image
GET  /api/canvases/:id/connect       # WebSocket upgrade
POST /api/canvases/:id/snapshots
GET  /api/canvases/:id/snapshots
POST /api/canvases/:id/fork
POST /api/canvases/:id/snapshots/:snapshotId/restore
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

Create a snapshot:

```bash
curl -X POST "$BASE/api/canvases/demo/snapshots" \
  -H 'Content-Type: application/json' \
  --data '{"name":"First sketch"}'
```

List snapshots:

```bash
curl "$BASE/api/canvases/demo/snapshots"
```

Restore using an ID returned by the list endpoint:

```bash
curl -X POST "$BASE/api/canvases/demo/snapshots/SNAPSHOT_ID/restore"
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

Before taking a snapshot, the Durable Object calls `/flush` so the checkpoint includes an atomically written PNG and metadata file. A restore destroys the running Container, starts from the selected immutable snapshot, verifies its metadata, and broadcasts a full image reset to connected clients.

## Current limitations

- Snapshots are preview functionality and should not be treated as permanent backups.
- The current MVP creates manual snapshots; automatic rolling snapshots are still planned.
- A canvas without a snapshot is not yet recovered from an unexpected Container replacement.
- Authentication, permissions, and presence cursors are not implemented yet.
- Forking depends on snapshot handles being reusable across Durable Object-managed Containers in the deployed preview runtime.
- Optimistic browser rendering uses Canvas 2D strokes while the Container uses its own circle-stamping rasterizer, so a reconnect may produce very small edge differences until the browser reloads the canonical PNG.
