# Collaborative Snapshot Canvas — Implementation Plan

## 1. Product summary

Build a collaborative pixel drawing application on Cloudflare Workers and Containers.

Each canvas has:

- One stable canvas ID and URL.
- One Durable Object that coordinates collaboration.
- One Durable Object-managed Container that owns the image.
- A canvas width and height between 128 and 1024 pixels.
- A simple circular brush and eraser with a diameter between 1 and 64 pixels.
- Client-side zoom from 25% through 3200% with panning and crisp pixel rendering.
- Multiple users drawing concurrently over WebSockets.
- Live viewer presence with cloud-formation guest names, optional custom names, hoverable remote cursors, 20-second heartbeats, and 90-second stale-connection cleanup.
- Named and automatic container snapshots.
- A revision history that users can restore.

The first milestone is complete when two browser tabs can draw on the same 256×256 canvas, create a named snapshot, change the image, and restore the snapshot in both tabs.

### Commit model

Container snapshots are presented as immutable canvas commits. The live Container is the working tree, each canvas tracks a `HEAD` commit, and drawing after that commit is uncommitted work. A new commit records its parent; resetting to an older commit moves `HEAD`, so the next commit creates a branch. Forked canvases retain the source canvas commit as their shared parent. Browser reloads show the running shared working tree, but a stopped or replaced Container is restored from `HEAD`; unrecoverable uncommitted work is discarded rather than creating a blank or inconsistent canvas.

## 2. Goals

### MVP goals

- Provide a home page for creating a new canvas or joining one by ID.
- Create a canvas with validated dimensions and a shareable `/canvas/:id` URL.
- Assign one Durable Object and one Container to each canvas.
- Store the authoritative image as `/data/canvas.png` in the Container.
- Draw opaque, colored, circular brush strokes.
- Synchronize strokes across connected browsers in real time.
- Create, list, and restore named snapshots.
- Reset every connected browser to the restored image.
- Recover cleanly when a browser disconnects and reconnects.

### Later goals

- Automatic rolling snapshots.
- Canvas forking from a snapshot.
- Snapshot thumbnails.
- Collaborator cursors and presence.
- Fill, alpha, layers, and additional tools.
- Stroke replay and timeline scrubbing.
- Authentication and canvas permissions.

### Non-goals for the MVP

- Infinite canvases.
- Vector graphics.
- Offline editing and conflict resolution.
- Pixel-perfect undo for an individual user.
- Snapshotting after every pointer event.
- Long-term archival using container snapshots alone.

## 3. System architecture

```text
Browser clients
      │
      │ HTTP + WebSocket
      ▼
Cloudflare Worker
      │
      │ canvas ID → Durable Object ID
      ▼
Canvas Durable Object
  ├── accepts WebSockets
  ├── validates and orders strokes
  ├── broadcasts canonical events
  ├── manages one Container
  ├── coordinates snapshot and restore operations
  └── stores canvas and snapshot metadata
      │
      │ private HTTP over the Container TCP port
      ▼
Canvas Container
  ├── maintains an image.RGBA in memory
  ├── rasterizes canonical strokes
  ├── writes /data/canvas.png atomically
  ├── writes /data/metadata.json
  └── serves the current PNG
```

### Ownership model

The Worker derives the Durable Object from a canvas ID:

```ts
const id = env.CANVAS.idFromName(canvasId);
const stub = env.CANVAS.get(id);
```

The Canvas Durable Object owns the collaboration session and its attached Container. All requests for a canvas must pass through this Durable Object so that operations have one authoritative order.

### Source of truth

- The **Container** is authoritative for pixels.
- The **Durable Object** is authoritative for operation order, the current revision, collaborators, and snapshot metadata.
- The **browser** may render optimistically, but it is not authoritative.

## 4. Data model

### Canvas metadata

Store this in Durable Object storage and mirror the essential fields in `/data/metadata.json`:

```ts
type CanvasMetadata = {
  id: string;
  name: string;
  width: number;
  height: number;
  background: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
```

Validation:

- `width`: integer from 128 through 1024.
- `height`: integer from 128 through 1024.
- `background`: six-digit hexadecimal color.
- Canvas IDs: URL-safe and bounded in length.

### Canonical stroke

```ts
type Point = {
  x: number;
  y: number;
};

type CanonicalStroke = {
  type: "stroke";
  revision: number;
  strokeId: string;
  clientId: string;
  from: Point;
  to: Point;
  size: number;
  color: string;
};
```

Validation:

- Coordinates must be finite numbers and inside the canvas.
- Brush size must be an integer from 1 through 64.
- Color must match `#[0-9a-fA-F]{6}`.
- `strokeId` must be unique per client within a bounded deduplication window.
- WebSocket message size and frequency must be limited.

### Snapshot metadata

```ts
type StoredCanvasSnapshot = {
  id: string;
  name: string;
  snapshot: ContainerSnapshot;
  canvasRevision: number;
  createdAt: string;
  createdBy: string;
  kind: "manual" | "automatic";
  size: number;
  snapshotElapsedMs: number;
};
```

Snapshot handles remain in Durable Object storage. API responses expose metadata but never attempt to serialize the opaque handle.

## 5. Container design

Replace the current informational Go server in `container/main.go` with a canvas server.

### Filesystem layout

```text
/data/
├── canvas.png
└── metadata.json
```

The Container holds an `image.RGBA` in memory for efficient drawing. It flushes a complete PNG to disk periodically and whenever the Durable Object requests a flush.

### Container endpoints

#### `POST /initialize`

Create a new image if one does not already exist.

```json
{
  "width": 512,
  "height": 512,
  "background": "#ffffff"
}
```

Initialization must be idempotent. Starting an existing canvas must load `/data/canvas.png` rather than replace it.

#### `POST /strokes`

Apply one or more canonical strokes in revision order.

```json
{
  "strokes": [
    {
      "revision": 103,
      "from": { "x": 42, "y": 18 },
      "to": { "x": 51, "y": 23 },
      "size": 12,
      "color": "#ef4444"
    }
  ]
}
```

The response returns the last applied revision. The Container rejects unexpected revision gaps to expose ordering bugs.

#### `POST /flush`

Persist the in-memory image and metadata to disk. This endpoint is mandatory before creating a snapshot.

#### `GET /canvas.png`

Return the authoritative image with `Content-Type: image/png`.

#### `GET /metadata`

Return dimensions and the last applied revision.

#### `POST /clear`

Fill the image with a validated color and apply a new revision.

#### `GET /health`

Return readiness and the loaded canvas revision.

### Brush rasterization

For the initial brush:

1. Treat the requested size as a circular brush diameter.
2. Interpolate points from `from` to `to`.
3. Stamp a filled circle at each interpolated point.
4. Use spacing of approximately `max(1, brushSize / 4)` to avoid gaps.
5. Clip every stamp to the image bounds.
6. Use opaque RGB colors for the MVP.

The same server-side algorithm is canonical. The browser should approximate it closely for optimistic rendering.

### Atomic persistence

A flush must not expose a partially encoded PNG:

1. Encode to `/data/canvas.tmp`.
2. Close the file and check all errors.
3. Rename `canvas.tmp` to `canvas.png`.
4. Write `metadata.json` using the same temporary-file pattern.

## 6. Durable Object design

Refactor `src/index.ts` around a `Canvas` Durable Object.

### Main responsibilities

- Start and initialize the Container.
- Accept WebSocket upgrades.
- Track connected clients.
- Validate incoming events.
- Assign monotonically increasing revisions.
- Apply strokes to the Container in order.
- Broadcast accepted canonical strokes.
- Serialize strokes, clears, snapshots, and restores.
- Proxy the authoritative PNG.
- Store canvas and snapshot metadata.

### Operation serialization

All mutating operations must pass through one ordered queue:

```text
stroke → stroke → snapshot → stroke → restore → stroke
```

A snapshot or restore must never race with a stroke. The queue can initially be implemented as a chained Promise in the Durable Object. If Durable Object WebSocket hibernation is added, verify that the queue and client attachment metadata recover correctly after wake-up.

### Applying a stroke

1. Parse and validate the client message.
2. Reject duplicate `strokeId` values.
3. Allocate the next revision.
4. Send the canonical stroke to `POST /strokes` in the Container.
5. Update revision metadata in Durable Object storage.
6. Broadcast the canonical event to every connected client.
7. Acknowledge the originating client through that broadcast.

Only broadcast a stroke as accepted after the Container confirms it.

If application fails, return:

```json
{
  "type": "stroke-rejected",
  "strokeId": "...",
  "reason": "container unavailable"
}
```

The browser should reload the authoritative PNG after a rejection that may have left its optimistic rendering out of sync.

### Container startup

When the Durable Object needs the Container:

1. Start the configured image if it is not running.
2. Wait for the health endpoint.
3. Call `/initialize` with stored canvas metadata.
4. Verify dimensions and revision against Durable Object metadata.
5. Set an appropriate inactivity timeout.

Restoring a snapshot uses `containerSnapshot` instead of `image`, as these startup options are mutually exclusive.

## 7. WebSocket protocol

### Client to server

#### Stroke

```json
{
  "type": "stroke",
  "strokeId": "01J...",
  "from": { "x": 10, "y": 20 },
  "to": { "x": 14, "y": 25 },
  "size": 8,
  "color": "#2563eb"
}
```

#### Cursor, deferred until presence work

```json
{
  "type": "cursor",
  "x": 10,
  "y": 20
}
```

Cursor events are ephemeral and never sent to the Container.

### Server to clients

#### Initial state

```json
{
  "type": "welcome",
  "clientId": "...",
  "revision": 180,
  "width": 512,
  "height": 512,
  "imageUrl": "/api/canvases/sunset-park/image?v=180"
}
```

#### Accepted canonical stroke

```json
{
  "type": "stroke",
  "revision": 203,
  "clientId": "alice",
  "strokeId": "01J...",
  "from": { "x": 10, "y": 20 },
  "to": { "x": 14, "y": 25 },
  "size": 8,
  "color": "#2563eb"
}
```

#### Full reset

Sent after restore or detected desynchronization:

```json
{
  "type": "reset",
  "revision": 180,
  "imageUrl": "/api/canvases/sunset-park/image?v=180"
}
```

Clients must discard local pixels and reload the canonical image.

## 8. Snapshot behavior

### Manual snapshot procedure

1. Enqueue the snapshot operation behind existing strokes.
2. Temporarily hold later mutations in the queue.
3. Call the Container's `/flush` endpoint.
4. Verify the flushed revision.
5. Call `snapshotContainer({ name })`.
6. Save the opaque handle and metadata in Durable Object storage.
7. Broadcast updated snapshot history.
8. Resume queued mutations.

Example names:

- `Initial sketch`
- `Added mountains`
- `Before the dragon`

### Restore procedure

Restoring replaces the current running Container and is disruptive:

1. Enqueue the restore operation.
2. Broadcast `restore-started`.
3. Stop accepting new mutation messages or leave them queued.
4. Destroy the running Container.
5. Start a Container using the selected `containerSnapshot`.
6. Wait for `/health`.
7. Read `/metadata` and verify the restored revision.
8. Update Durable Object metadata to the restored revision.
9. Broadcast a `reset` event with a cache-busted image URL.
10. Resume queued operations.

The UI must warn that unsnapshotted changes after the selected revision will be discarded.

### Automatic snapshots

Add after manual snapshots are reliable. Initial policy:

- Snapshot after 100 accepted strokes or 30 seconds of active drawing.
- Keep the latest 20 automatic snapshots.
- Do not automatically delete manually named snapshots.
- Coalesce triggers so only one snapshot can run at a time.

The exact policy should remain configurable.

### Retention and durability

Container snapshots are the product feature being demonstrated, but they should not be described as permanent backups. Snapshot APIs and retention behavior may be preview-dependent. Durable metadata must handle missing or expired snapshots gracefully.

A later archival option can export `canvas.png` to R2 while leaving the live authoritative file in the Container.

### Forking technical spike

Test whether one immutable `ContainerSnapshot` can be restored by multiple Canvas Durable Objects and whether the opaque handle can be transferred safely through Durable Object RPC or shared storage.

Desired workflow:

```text
sunset-park @ "Added mountains"
              ├── sunset-park-with-dragon
              └── sunset-park-at-night
```

If cross-Durable-Object restore is supported, expose snapshot forking after the MVP. If not, keep restore history within one canvas and investigate export/import as a fallback.

## 9. HTTP API

```text
POST   /api/canvases
GET    /api/canvases/:id
GET    /api/canvases/:id/image
GET    /api/canvases/:id/connect
POST   /api/canvases/:id/clear
POST   /api/canvases/:id/snapshots
GET    /api/canvases/:id/snapshots
POST   /api/canvases/:id/snapshots/:snapshotId/restore
POST   /api/canvases/:id/snapshots/:snapshotId/fork    # post-MVP
DELETE /api/canvases/:id                               # post-MVP
```

### Create canvas

```http
POST /api/canvases
Content-Type: application/json
```

```json
{
  "name": "Sunset Park",
  "width": 512,
  "height": 512,
  "background": "#ffffff"
}
```

Response:

```json
{
  "id": "sunset-park-a1b2",
  "url": "/canvas/sunset-park-a1b2",
  "width": 512,
  "height": 512,
  "revision": 0
}
```

### Create snapshot

```http
POST /api/canvases/sunset-park-a1b2/snapshots
Content-Type: application/json
```

```json
{
  "name": "Added mountains"
}
```

### Image caching

Use the revision in the image URL:

```text
/api/canvases/:id/image?v=:revision
```

The image endpoint can return immutable cache headers for a revision-specific URL. Restore messages always provide the restored revision so clients do not reuse stale browser cache entries.

## 10. Frontend plan

Use React with Vite, Svelte, or another lightweight framework for controls and page layout. Use the native Canvas 2D API for the drawing surface rather than storing pixel or pointer state in framework state on every movement.

### Main components

```text
web/src/
├── App
├── CanvasSurface
├── BrushToolbar
├── ConnectionStatus
├── CollaboratorList
├── SnapshotHistory
└── collaboration client
```

### UI layout

```text
┌─────────────────────────────────────────────────────────┐
│ Snapshot Canvas     3 collaborators     [Save snapshot] │
├───────────────┬─────────────────────────────────────────┤
│ Brush         │                                         │
│ Size: 12      │                                         │
│ Color: ■      │               Canvas                    │
│               │                                         │
│ History       │                                         │
│ ● Added trees │                                         │
│ ● Base sketch │                                         │
│               │                                         │
└───────────────┴─────────────────────────────────────────┘
```

### Pointer handling

- Listen to pointer events, not separate mouse and touch events.
- Capture the pointer while drawing.
- Convert CSS coordinates to image coordinates.
- Coalesce frequent movement into line segments.
- Limit outgoing messages to a reasonable rate, initially 60 per second.
- Render locally before server confirmation.
- Match a canonical broadcast to the optimistic stroke using `strokeId`.
- Reload the full PNG on reconnect, restore, or rejection-related desynchronization.

Coordinate conversion:

```ts
const x = Math.floor((event.offsetX / displayedWidth) * canvasWidth);
const y = Math.floor((event.offsetY / displayedHeight) * canvasHeight);
```

## 11. Security and limits

Implement before exposing a public deployment:

- Validate every field on both the Worker and Container boundaries.
- Restrict canvas dimensions to 128–1024.
- Restrict brush size to 1–64.
- Restrict colors to six-digit hexadecimal RGB.
- Cap WebSocket message size.
- Rate-limit strokes and snapshot creation per client.
- Cap snapshot names and canvas names.
- Prevent arbitrary Container commands or filesystem paths from the API.
- Do not expose the Container directly to the Internet.
- Require authorization for restore, clear, and deletion once identities are added.
- Limit collaborators and queued operations per canvas.

## 12. Failure handling

### Client disconnect

On reconnect:

1. Open a new WebSocket.
2. Receive the current revision and image URL.
3. Reload the authoritative PNG.
4. Resume drawing only after synchronization.

### Container unavailable

- Retry startup and readiness checks with bounded backoff.
- Reject uncommitted optimistic strokes if the Container cannot apply them.
- Tell clients to reload after recovery.
- Never broadcast an operation the Container did not confirm.

### Snapshot failure

- Leave the current Container running.
- Return a clear error.
- Keep drawing state intact.
- Do not add failed snapshot metadata to history.

### Restore failure

- Report `restore-failed` to all clients.
- Attempt to restart from the current image if possible.
- Keep snapshot metadata so the operation can be retried.
- Do not silently accept strokes while the authoritative state is uncertain.

### Revision mismatch

If the Durable Object and Container report different revisions:

- Pause mutation handling.
- Treat the Container image as authoritative for pixels.
- Broadcast a reset after selecting the correct revision metadata.
- Log enough context to diagnose the mismatch.

## 13. Observability

Log structured events with:

- Canvas ID.
- Durable Object ID.
- Operation type.
- Revision.
- Client ID when relevant.
- Container startup time.
- Stroke apply latency.
- Flush latency.
- Snapshot ID, size, and elapsed time.
- Restore elapsed time.
- Error category.

Useful initial metrics:

- Connected clients per canvas.
- Strokes accepted and rejected.
- Container request latency.
- Snapshot and restore latency.
- Snapshot failure rate.
- WebSocket reconnect count.
- Full image reset count.

## 14. Testing strategy

### Go unit tests

- Canvas initialization and dimension validation.
- Hex color parsing.
- Filled-circle rasterization.
- Segment interpolation with no gaps.
- Edge clipping.
- Revision ordering and gap rejection.
- PNG flush and reload.

### Worker unit tests

- Route parsing.
- Canvas metadata validation.
- Stroke validation.
- Revision allocation.
- Duplicate stroke rejection.
- Snapshot metadata serialization.
- Restore state transitions.

### Integration tests

- Create a canvas and fetch the initial PNG.
- Draw a stroke and verify changed pixels.
- Connect two WebSockets and verify broadcast order.
- Create a snapshot, modify pixels, restore, and verify the original PNG.
- Disconnect and reconnect a client without divergence.
- Attempt strokes during snapshot and restore operations.
- Restart an inactive Container and verify its current image behavior.

### Manual acceptance test

1. Create a 256×256 white canvas.
2. Open it in two browser tabs.
3. Draw red in tab A and verify it appears in tab B.
4. Draw blue in tab B and verify it appears in tab A.
5. Save a snapshot named `Before green`.
6. Draw green over the image.
7. Restore `Before green`.
8. Verify green disappears in both tabs.
9. Reload both tabs and verify the restored image remains.

## 15. Delivery phases

### Phase 1 — Container canvas engine

- Replace `container/main.go` with the image server.
- Implement initialize, strokes, flush, image, metadata, and health endpoints.
- Implement circular brush rasterization.
- Add Go tests.

**Exit condition:** HTTP requests can create an image, draw strokes, flush it, restart the process, and load the same PNG.

### Phase 2 — Single-user Worker flow

- Rename/refactor the Durable Object around canvases.
- Add canvas creation and metadata.
- Start and initialize one Container per canvas.
- Proxy stroke requests and PNG responses.
- Add a minimal browser drawing surface.

**Exit condition:** One browser can create and draw on a persistent canvas.

### Phase 3 — Collaboration

- Add WebSocket upgrades.
- Assign client IDs and canvas revisions.
- Validate, apply, and broadcast canonical strokes.
- Add optimistic rendering and reconnect resets.

**Exit condition:** Two tabs draw on the same canvas with consistent results.

### Phase 4 — Manual snapshots

- Flush before snapshot.
- Create and list named snapshots.
- Restore snapshots through an ordered state transition.
- Broadcast full resets after restore.
- Display snapshot size and timing in the UI.
- Add wheel zoom, zoom controls, and Space-drag panning without changing image-space coordinates.

**Exit condition:** The full milestone acceptance test passes.

### Phase 5 — Reliability and polish

- Add rate limits and operation bounds.
- Improve startup and failure recovery.
- Add automatic snapshots and retention cleanup.
- Add snapshot thumbnails and collaborator presence.
- Measure stroke, snapshot, and restore latency.

### Commit preview pages

- Each commit has a shareable read-only route at `/canvas/:canvasId/commits/:commitId`.
- Preview pages restore the commit into a deterministic ephemeral preview Container, never the live canvas Container.
- Preview Containers stop after inactivity and can be recreated from the immutable snapshot.
- Commit history exposes 👁 Preview, ⑂ Fork, and ↶ Reset actions.

### Phase 6 — Canvas forking

- Create an immutable snapshot of the current flushed canvas.
- Restore that snapshot into a new canvas Durable Object and Container.
- Give the fork an independent ID, URL, collaboration session, and snapshot history.
- Clearly distinguish a fork from restoring the current canvas.

## 16. Immediate implementation order

1. Define shared request and event schemas.
2. Implement and test the Go rasterizer.
3. Implement `/initialize`, `/strokes`, `/flush`, and `/canvas.png`.
4. Change the Worker from document operations to canvas operations.
5. Create a minimal HTML Canvas frontend.
6. Add Durable Object WebSockets and canonical revisions.
7. Adapt the repository's existing snapshot methods to flush image state first.
8. Add restore broadcasts and browser reset behavior.
9. Run the two-tab snapshot acceptance test on a deployed Worker.
10. Only then add automatic snapshots, presence, and forking.

## 17. Open technical questions

Resolve these during implementation:

- Does the available Container snapshot implementation preserve only filesystem state or additional runtime state, and what readiness behavior follows restore?
- Can the same immutable snapshot handle restore multiple independent Containers?
- Can a snapshot handle cross Durable Object boundaries through RPC or storage?
- What snapshot retention and account limits apply to this deployment?
- How does Container inactivity interact with unsnapshotted canvas files?
- Should every accepted stroke force a disk flush, or should the MVP use a short flush interval plus explicit snapshot flushes?
- Which WebSocket hibernation APIs are available with the current Durable Object runtime and Container attachment model?

The safest initial correctness policy is to flush frequently and always flush before snapshots or intentional Container shutdown. Performance tuning can follow once end-to-end behavior is measured.
