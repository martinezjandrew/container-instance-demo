import { DurableObject } from "cloudflare:workers";
import pRetry from "p-retry";

const CONTAINER_PORT = 8080;
const SNAPSHOT_PREFIX = "snapshot:";
const METADATA_KEY = "canvas:metadata";
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

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

type Point = { x: number; y: number };

type StrokeInput = {
  type: "stroke";
  strokeId: string;
  tool: "brush" | "eraser";
  from: Point;
  to: Point;
  size: number;
  color: string;
};

type CanonicalStroke = StrokeInput & {
  revision: number;
  clientId: string;
};

type StoredCanvasSnapshot = {
  id: string;
  name: string;
  snapshot: ContainerSnapshot;
  canvasRevision: number;
  createdAt: string;
  size: number;
  snapshotElapsedMs: number;
};

type SocketAttachment = { clientId: string };

export class Sandbox extends DurableObject<Env> {
  private operationQueue: Promise<void> = Promise.resolve();
  private recentStrokeIds = new Map<string, Set<string>>();
  private metadataCache?: CanvasMetadata;
  private pendingStrokes: CanonicalStroke[] = [];
  private strokeFlushScheduled = false;

  private get container(): Container {
    if (!this.ctx.container) {
      throw new Error("Canvas Durable Object has no Container attachment.");
    }
    return this.ctx.container;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async startContainer(): Promise<boolean> {
    if (this.container.running) return false;

    const image =
      this.container.images?.app ??
      this.env.EXPERIMENTAL_CLOUDFLARE_CONTAINER_IMAGES?.Sandbox?.app;
    if (!image) {
      throw new Error("No Container image is available for Sandbox.app.");
    }
    this.container.start({
      image,
      instance: "lite",
      entrypoint: ["/server", "8080"],
      enableInternet: false,
    });
    await this.waitForContainer();
    return true;
  }

  private async waitForContainer(): Promise<void> {
    await pRetry(
      async () => {
        const response = await this.containerFetch("/health");
        if (!response.ok) throw new Error(`health check returned ${response.status}`);
      },
      { retries: 8, minTimeout: 200, maxTimeout: 1_000 },
    );
  }

  private containerFetch(path: string, init?: RequestInit): Promise<Response> {
    return this.container
      .getTcpPort(CONTAINER_PORT)
      .fetch(`http://container${path}`, init);
  }

  private async metadata(): Promise<CanvasMetadata | undefined> {
    if (this.metadataCache) return this.metadataCache;
    this.metadataCache = await this.ctx.storage.get<CanvasMetadata>(METADATA_KEY);
    return this.metadataCache;
  }

  private async initialize(request: Request, canvasId: string): Promise<Response> {
    return await this.exclusive(async () => {
      let existing = await this.metadata();
      if (existing) {
        await this.startContainer();
        await this.initializeContainer(existing);
        return Response.json(existing);
      }

      const input = (await request.json()) as Record<string, unknown>;
      const width = Number(input.width);
      const height = Number(input.height);
      const background = typeof input.background === "string" ? input.background : "#ffffff";
      const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : canvasId;
      if (!Number.isInteger(width) || width < 128 || width > 1024 ||
          !Number.isInteger(height) || height < 128 || height > 1024) {
        return Response.json({ error: "Width and height must be integers from 128 to 1024." }, { status: 400 });
      }
      if (!COLOR_PATTERN.test(background)) {
        return Response.json({ error: "Background must be a six-digit hexadecimal color." }, { status: 400 });
      }

      const now = new Date().toISOString();
      existing = {
        id: canvasId,
        name: name.slice(0, 80),
        width,
        height,
        background,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      await this.startContainer();
      await this.initializeContainer(existing);
      this.metadataCache = existing;
      await this.ctx.storage.put(METADATA_KEY, existing);
      return Response.json(existing, { status: 201 });
    });
  }

  private async initializeContainer(metadata: CanvasMetadata): Promise<void> {
    const response = await this.containerFetch("/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        width: metadata.width,
        height: metadata.height,
        background: metadata.background,
        revision: metadata.revision,
      }),
    });
    if (!response.ok) throw new Error(`Container initialization failed: ${await response.text()}`);
  }

  private async imageResponse(): Promise<Response> {
    const metadata = await this.metadata();
    if (!metadata) return Response.json({ error: "Canvas does not exist." }, { status: 404 });
    const started = await this.startContainer();
    if (started) await this.initializeContainer(metadata);
    const response = await this.containerFetch("/canvas.png");
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("Content-Type") ?? "image/png",
        "Cache-Control": "no-store",
      },
    });
  }

  private validateStroke(value: unknown, metadata: CanvasMetadata): StrokeInput {
    if (!value || typeof value !== "object") throw new Error("Invalid message.");
    const input = value as Partial<StrokeInput>;
    const validPoint = (point: Point | undefined) =>
      point && Number.isFinite(point.x) && Number.isFinite(point.y) &&
      point.x >= 0 && point.y >= 0 && point.x < metadata.width && point.y < metadata.height;
    if (input.type !== "stroke" || typeof input.strokeId !== "string" || input.strokeId.length > 100 ||
        (input.tool !== "brush" && input.tool !== "eraser") ||
        !validPoint(input.from) || !validPoint(input.to) || !Number.isInteger(input.size) ||
        input.size! < 1 || input.size! > 64 || typeof input.color !== "string" ||
        !COLOR_PATTERN.test(input.color)) {
      throw new Error("Invalid stroke.");
    }
    return input as StrokeInput;
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || typeof message !== "string" || message.length > 4_096) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      socket.send(JSON.stringify({ type: "error", error: "Message must be valid JSON." }));
      return;
    }

    const metadata = await this.metadata();
    if (!metadata) return;
    let stroke: StrokeInput;
    try {
      stroke = this.validateStroke(parsed, metadata);
    } catch (error) {
      socket.send(JSON.stringify({ type: "error", error: error instanceof Error ? error.message : String(error) }));
      return;
    }

    let ids = this.recentStrokeIds.get(attachment.clientId);
    if (!ids) {
      ids = new Set();
      this.recentStrokeIds.set(attachment.clientId, ids);
    }
    if (ids.has(stroke.strokeId)) return;
    ids.add(stroke.strokeId);
    if (ids.size > 500) ids.delete(ids.values().next().value!);

    const canonical: CanonicalStroke = {
      ...stroke,
      revision: metadata.revision + 1,
      clientId: attachment.clientId,
    };
    metadata.revision = canonical.revision;
    metadata.updatedAt = new Date().toISOString();
    this.pendingStrokes.push(canonical);

    // Collaboration stays on the Durable Object's fast path. Container I/O and
    // storage persistence happen in a short micro-batch after the broadcast.
    this.broadcast(canonical);
    this.scheduleStrokeFlush();
  }

  private scheduleStrokeFlush(): void {
    if (this.strokeFlushScheduled) return;
    this.strokeFlushScheduled = true;
    setTimeout(() => {
      this.strokeFlushScheduled = false;
      const flush = this.exclusive(async () => await this.flushPendingStrokes());
      this.ctx.waitUntil(flush.catch((error) => {
        this.broadcast({
          type: "server-error",
          error: error instanceof Error ? error.message : String(error),
        });
        setTimeout(() => this.scheduleStrokeFlush(), 250);
      }));
    }, 16);
  }

  private async flushPendingStrokes(): Promise<void> {
    while (this.pendingStrokes.length > 0) {
      const batch = this.pendingStrokes.splice(0, 100);
      const metadata = await this.metadata();
      if (!metadata) return;

      try {
        const started = await this.startContainer();
        if (started) {
          await this.initializeContainer({ ...metadata, revision: batch[0].revision - 1 });
        }
        const response = await this.containerFetch("/strokes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            strokes: batch.map((stroke) => ({
              revision: stroke.revision,
              tool: stroke.tool,
              from: stroke.from,
              to: stroke.to,
              size: stroke.size,
              color: stroke.color,
            })),
          }),
        });
        if (!response.ok) throw new Error(await response.text());

        const lastRevision = batch[batch.length - 1].revision;
        await this.ctx.storage.put(METADATA_KEY, {
          ...metadata,
          revision: lastRevision,
        });
      } catch (error) {
        this.pendingStrokes.unshift(...batch);
        throw error;
      }
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment) this.recentStrokeIds.delete(attachment.clientId);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment) this.recentStrokeIds.delete(attachment.clientId);
  }

  private broadcast(message: unknown): void {
    const serialized = JSON.stringify(message);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(serialized);
      } catch {
        // A close event will remove transient state for disconnected clients.
      }
    }
  }

  private async acceptWebSocket(request: Request): Promise<Response> {
    await this.exclusive(async () => await this.flushPendingStrokes());
    const metadata = await this.metadata();
    if (!metadata) return Response.json({ error: "Canvas does not exist." }, { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const clientId = crypto.randomUUID();
    server.serializeAttachment({ clientId } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({
      type: "welcome",
      clientId,
      revision: metadata.revision,
      width: metadata.width,
      height: metadata.height,
      background: metadata.background,
      imageUrl: `/api/canvases/${encodeURIComponent(metadata.id)}/image?v=${metadata.revision}`,
    }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private snapshotDetails(stored: StoredCanvasSnapshot) {
    return {
      id: stored.id,
      name: stored.name,
      canvasRevision: stored.canvasRevision,
      createdAt: stored.createdAt,
      size: stored.size,
      snapshotElapsedMs: stored.snapshotElapsedMs,
    };
  }

  private async createSnapshot(request: Request): Promise<Response> {
    return await this.exclusive(async () => {
      await this.flushPendingStrokes();
      const metadata = await this.metadata();
      if (!metadata) return Response.json({ error: "Canvas does not exist." }, { status: 404 });
      const input = (await request.json()) as { name?: unknown };
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name || name.length > 80) {
        return Response.json({ error: "Snapshot name must contain 1 to 80 characters." }, { status: 400 });
      }
      const started = await this.startContainer();
      if (started) await this.initializeContainer(metadata);
      const flush = await this.containerFetch("/flush", { method: "POST" });
      if (!flush.ok) throw new Error(`Canvas flush failed: ${await flush.text()}`);

      const startedAt = performance.now();
      const snapshot = await this.container.snapshotContainer({ name });
      const stored: StoredCanvasSnapshot = {
        id: crypto.randomUUID(),
        name,
        snapshot,
        canvasRevision: metadata.revision,
        createdAt: new Date().toISOString(),
        size: snapshot.size,
        snapshotElapsedMs: performance.now() - startedAt,
      };
      await this.ctx.storage.put(`${SNAPSHOT_PREFIX}${stored.id}`, stored);
      this.broadcast({ type: "snapshot-created", snapshot: this.snapshotDetails(stored) });
      return Response.json(this.snapshotDetails(stored), { status: 201 });
    });
  }

  private async listSnapshots(): Promise<Response> {
    const entries = await this.ctx.storage.list<StoredCanvasSnapshot>({ prefix: SNAPSHOT_PREFIX });
    const snapshots = Array.from(entries.values(), (value) => this.snapshotDetails(value))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Response.json({ snapshots });
  }

  private async forkCanvas(request: Request): Promise<Response> {
    return await this.exclusive(async () => {
      const source = await this.metadata();
      if (!source) return Response.json({ error: "Canvas does not exist." }, { status: 404 });

      const input = await request.json() as { id?: unknown; name?: unknown };
      const targetId = typeof input.id === "string" ? input.id.trim() : "";
      const targetName = typeof input.name === "string" && input.name.trim()
        ? input.name.trim().slice(0, 80)
        : targetId;
      if (!validCanvasId(targetId)) {
        return Response.json(
          { error: "New canvas ID must use letters, numbers, underscores, or hyphens." },
          { status: 400 },
        );
      }
      if (targetId === source.id) {
        return Response.json({ error: "The fork must use a different canvas ID." }, { status: 400 });
      }

      const target = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(targetId));
      if (await target.canvasExists()) {
        return Response.json({ error: "That canvas ID already exists." }, { status: 409 });
      }

      await this.flushPendingStrokes();
      const forkRevision = source.revision;
      const started = await this.startContainer();
      if (started) await this.initializeContainer(source);
      const flush = await this.containerFetch("/flush", { method: "POST" });
      if (!flush.ok) throw new Error(`Canvas flush failed: ${await flush.text()}`);

      const startedAt = performance.now();
      const snapshot = await this.container.snapshotContainer({ name: `Fork: ${targetId}` });
      const stored: StoredCanvasSnapshot = {
        id: crypto.randomUUID(),
        name: `Forked to ${targetName}`,
        snapshot,
        canvasRevision: forkRevision,
        createdAt: new Date().toISOString(),
        size: snapshot.size,
        snapshotElapsedMs: performance.now() - startedAt,
      };
      await this.ctx.storage.put(`${SNAPSHOT_PREFIX}${stored.id}`, stored);

      await target.initializeFromFork(
        { id: snapshot.id },
        {
          ...source,
          id: targetId,
          name: targetName,
          revision: forkRevision,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      );
      this.broadcast({ type: "snapshot-created", snapshot: this.snapshotDetails(stored) });
      return Response.json({
        id: targetId,
        name: targetName,
        revision: forkRevision,
        url: `/canvas/${encodeURIComponent(targetId)}`,
      }, { status: 201 });
    });
  }

  async canvasExists(): Promise<boolean> {
    return (await this.metadata()) !== undefined;
  }

  async initializeFromFork(
    snapshot: ContainerSnapshotRestoreParams,
    metadata: CanvasMetadata,
  ): Promise<void> {
    await this.exclusive(async () => {
      if (await this.metadata()) throw new Error("That canvas ID already exists.");
      if (this.container.running) await this.container.destroy();
      this.container.start({ containerSnapshot: snapshot, enableInternet: false });
      await this.waitForContainer();

      const response = await this.containerFetch("/metadata");
      if (!response.ok) throw new Error(`Forked canvas metadata unavailable: ${await response.text()}`);
      const restored = await response.json() as { revision: number; width: number; height: number };
      metadata.revision = restored.revision;
      metadata.width = restored.width;
      metadata.height = restored.height;
      this.metadataCache = metadata;
      await this.ctx.storage.put(METADATA_KEY, metadata);
    });
  }

  private async restoreSnapshot(snapshotId: string): Promise<Response> {
    return await this.exclusive(async () => {
      const stored = await this.ctx.storage.get<StoredCanvasSnapshot>(`${SNAPSHOT_PREFIX}${snapshotId}`);
      const metadata = await this.metadata();
      if (!stored || !metadata) return Response.json({ error: "Snapshot does not exist." }, { status: 404 });

      // Restore intentionally discards all changes after the selected snapshot,
      // including strokes that have been broadcast but not flushed yet.
      this.pendingStrokes = [];
      this.broadcast({ type: "restore-started", snapshotId });
      if (this.container.running) await this.container.destroy();
      const startedAt = performance.now();
      this.container.start({ containerSnapshot: stored.snapshot, enableInternet: false });
      await this.waitForContainer();
      const response = await this.containerFetch("/metadata");
      if (!response.ok) throw new Error(`Restored metadata unavailable: ${await response.text()}`);
      const restored = await response.json() as { revision: number; width: number; height: number };
      metadata.revision = restored.revision;
      metadata.width = restored.width;
      metadata.height = restored.height;
      metadata.updatedAt = new Date().toISOString();
      await this.ctx.storage.put(METADATA_KEY, metadata);
      const restoreElapsedMs = performance.now() - startedAt;
      this.broadcast({
        type: "reset",
        revision: metadata.revision,
        imageUrl: `/api/canvases/${encodeURIComponent(metadata.id)}/image?v=${metadata.revision}&restored=${Date.now()}`,
      });
      return Response.json({ ...this.snapshotDetails(stored), restoreElapsedMs });
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const canvasIndex = segments.indexOf("canvases");
    const canvasId = canvasIndex >= 0 ? decodeURIComponent(segments[canvasIndex + 1] ?? "") : "";
    const action = canvasIndex >= 0 ? segments.slice(canvasIndex + 2) : [];

    try {
      if (!canvasId) return Response.json({ error: "Canvas ID is required." }, { status: 400 });
      if (action.length === 0 && request.method === "POST") return await this.initialize(request, canvasId);
      if (action.length === 0 && request.method === "GET") {
        const metadata = await this.metadata();
        return metadata ? Response.json(metadata) : Response.json({ error: "Canvas does not exist." }, { status: 404 });
      }
      if (action[0] === "image" && request.method === "GET") return await this.imageResponse();
      if (action[0] === "connect" && request.method === "GET") return await this.acceptWebSocket(request);
      if (action[0] === "snapshots" && action.length === 1 && request.method === "GET") return await this.listSnapshots();
      if (action[0] === "snapshots" && action.length === 1 && request.method === "POST") return await this.createSnapshot(request);
      if (action[0] === "fork" && action.length === 1 && request.method === "POST") return await this.forkCanvas(request);
      if (action[0] === "snapshots" && action[2] === "restore" && request.method === "POST") {
        return await this.restoreSnapshot(decodeURIComponent(action[1] ?? ""));
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
  }
}

function validCanvasId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/canvases/")) {
      const canvasId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
      if (!validCanvasId(canvasId)) {
        return Response.json({ error: "Canvas ID must use letters, numbers, underscores, or hyphens." }, { status: 400 });
      }
      const stub = env.SANDBOX.get(env.SANDBOX.idFromName(canvasId));
      return await stub.fetch(request);
    }
    if (url.pathname === "/") {
      return new Response(HOME_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    const canvasMatch = url.pathname.match(/^\/canvas\/([^/]+)$/);
    if (canvasMatch && validCanvasId(decodeURIComponent(canvasMatch[1]))) {
      return new Response(APP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

const HOME_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Snapshot Canvas</title>
<style>
:root{color-scheme:dark;--panel:#171923;--border:#303445;--accent:#7c5cff}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:30px;font:15px system-ui,sans-serif;background:radial-gradient(circle at 50% 0,#29234d 0,#11131c 45%,#090b10 100%);color:#f4f4f7}.page{width:min(820px,100%)}h1{font-size:42px;margin:0 0 8px;text-align:center}.tagline{text-align:center;color:#aeb4c4;margin:0 0 35px}.cards{display:grid;grid-template-columns:1fr 1fr;gap:18px}.card{background:#171923e8;border:1px solid var(--border);border-radius:14px;padding:24px;box-shadow:0 18px 60px #0005}.card h2{margin:0 0 5px}.card>p{color:#9ea5b6;margin:0 0 20px}label{display:block;color:#b8becc;margin:13px 0 6px}input,button{font:inherit}input[type=text],input[type=number]{width:100%;padding:10px 11px;color:#fff;background:#0e1017;border:1px solid #393e50;border-radius:7px}input[type=color]{width:100%;height:42px;background:none;border:0}.row{display:flex;gap:10px}.row>div{flex:1}button{width:100%;margin-top:18px;padding:11px;color:#fff;background:var(--accent);border:0;border-radius:8px;font-weight:650;cursor:pointer}button:hover{filter:brightness(1.12)}button:disabled{opacity:.55;cursor:wait}.message{min-height:20px;margin-top:12px;color:#ff929e}.foot{text-align:center;color:#73798a;margin-top:24px;font-size:13px}@media(max-width:680px){.cards{grid-template-columns:1fr}h1{font-size:34px}}
</style>
</head>
<body><main class="page"><h1>Snapshot Canvas</h1><p class="tagline">Draw together. Save a moment. Jump back anytime.</p><div class="cards">
<section class="card"><h2>Start a new canvas</h2><p>Choose a name and canvas size, then invite others with the URL.</p>
<label>Name</label><input id="newName" type="text" maxlength="80" placeholder="Weekend doodles">
<label>Canvas ID</label><input id="newId" type="text" maxlength="64" placeholder="weekend-doodles">
<div class="row"><div><label>Width</label><input id="newWidth" type="number" min="128" max="1024" value="512"></div><div><label>Height</label><input id="newHeight" type="number" min="128" max="1024" value="512"></div></div>
<label>Background</label><input id="newBackground" type="color" value="#ffffff"><button id="create">Create canvas</button><div id="createMessage" class="message"></div></section>
<section class="card"><h2>Join a canvas</h2><p>Enter the canvas ID shared by another artist.</p><label>Canvas ID</label><input id="joinId" type="text" maxlength="64" placeholder="weekend-doodles"><button id="join">Join canvas</button><div id="joinMessage" class="message"></div></section>
</div><p class="foot">Each canvas runs in its own Cloudflare Container and is backed by snapshots.</p></main>
<script>
const byId=id=>document.getElementById(id);const newName=byId('newName'),newId=byId('newId'),newWidth=byId('newWidth'),newHeight=byId('newHeight'),newBackground=byId('newBackground'),createButton=byId('create'),createMessage=byId('createMessage'),joinId=byId('joinId'),joinButton=byId('join'),joinMessage=byId('joinMessage');
const valid=id=>/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id);const slug=value=>value.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,50);const go=id=>location.href='/canvas/'+encodeURIComponent(id);
newName.addEventListener('input',()=>{if(!newId.dataset.edited)newId.value=slug(newName.value)});newId.addEventListener('input',()=>newId.dataset.edited='true');
createButton.onclick=async()=>{const id=newId.value.trim(),message=createMessage;if(!valid(id)){message.textContent='Use letters, numbers, underscores, or hyphens.';return}createButton.disabled=true;message.textContent='';try{const response=await fetch('/api/canvases/'+encodeURIComponent(id),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:newName.value.trim()||id,width:Number(newWidth.value),height:Number(newHeight.value),background:newBackground.value})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not create canvas.');if(response.status===200)throw new Error('That canvas ID already exists. Join it instead.');go(id)}catch(error){message.textContent=error.message}finally{createButton.disabled=false}};
joinButton.onclick=async()=>{const id=joinId.value.trim(),message=joinMessage;if(!valid(id)){message.textContent='Enter a valid canvas ID.';return}joinButton.disabled=true;message.textContent='';try{const response=await fetch('/api/canvases/'+encodeURIComponent(id));if(response.status===404)throw new Error('That canvas does not exist.');if(!response.ok){const data=await response.json();throw new Error(data.error||'Could not join canvas.')}go(id)}catch(error){message.textContent=error.message}finally{joinButton.disabled=false}};
joinId.addEventListener('keydown',event=>{if(event.key==='Enter')joinButton.click()});
</script></body></html>`;

const APP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Snapshot Canvas</title>
<style>
:root{color-scheme:dark;--panel:#171923;--border:#303445;--accent:#7c5cff}*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif;background:#0d0f15;color:#f4f4f7;height:100vh;overflow:hidden}button,input{font:inherit}button{color:#fff;background:#262a38;border:1px solid #3b4053;border-radius:7px;padding:7px 10px;cursor:pointer}button:hover{border-color:#7c5cff}button.active{background:#7c5cff;border-color:#9b87ff}button:disabled{opacity:.5;cursor:wait}header{height:54px;display:flex;align-items:center;gap:10px;padding:8px 14px;background:var(--panel);border-bottom:1px solid var(--border)}header strong{font-size:17px}header a{color:inherit;text-decoration:none}.spacer{flex:1}.status{color:#a7adbd}.app{height:calc(100vh - 54px);display:grid;grid-template-columns:220px 1fr 240px}.panel{padding:14px;background:var(--panel);overflow:auto}.left{border-right:1px solid var(--border)}.right{border-left:1px solid var(--border)}label{display:block;color:#aeb4c4;margin:12px 0 5px}input[type=text],input[type=number]{width:100%;padding:8px;background:#0f1119;color:#fff;border:1px solid #393e50;border-radius:6px}input[type=color]{width:100%;height:38px;background:none;border:0}.row{display:flex;gap:7px}.row>*{flex:1}.workspace{overflow:auto;background:#252836;position:relative}.stage{min-width:100%;min-height:100%;display:flex;align-items:center;justify-content:center;padding:80px}.canvas-wrap{box-shadow:0 8px 35px #0008;line-height:0}canvas{background:#fff;image-rendering:pixelated;touch-action:none;cursor:crosshair}.snapshot{padding:9px 0;border-bottom:1px solid var(--border)}.snapshot b{display:block}.snapshot small{display:block;color:#979dad;margin:4px 0 7px}.empty{color:#888e9e}.error{color:#ff8e9b}.zoom{min-width:64px;text-align:center}dialog{width:min(520px,calc(100vw - 32px));padding:0;color:#f4f4f7;background:#171923;border:1px solid #3a3f52;border-radius:14px;box-shadow:0 24px 90px #000b}dialog::backdrop{background:#080a10bf;backdrop-filter:blur(3px)}.dialog-head{display:flex;align-items:center;padding:16px 18px;border-bottom:1px solid var(--border)}.dialog-head h2{margin:0;font-size:19px}.dialog-head button{margin-left:auto;padding:4px 9px}.dialog-body{padding:18px}.dialog-section+ .dialog-section{margin-top:22px;padding-top:20px;border-top:1px solid var(--border)}.dialog-section h3{margin:0 0 4px}.dialog-section p{margin:0 0 10px;color:#969cad}.dialog-message{min-height:18px;margin-top:8px;color:#ff8e9b}
</style>
</head>
<body>
<header><strong><a href="/">Snapshot Canvas</a></strong><span id="title"></span><span class="spacer"></span><span id="status" class="status">Starting…</span><button id="forkBtn">Fork canvas</button><button id="snapshotBtn">Save snapshot</button></header>
<div class="app">
<aside class="panel left">
<button id="openBtn" style="width:100%">Open or create</button>
<hr style="border:0;border-top:1px solid #303445;margin:18px 0">
<label>Tool</label><div class="row"><button id="brushBtn" class="active">Brush</button><button id="eraserBtn">Eraser</button></div>
<label>Brush color</label><input id="color" type="color" value="#7c5cff">
<label>Brush size: <span id="sizeValue">8</span>px</label><input id="size" type="range" min="1" max="64" value="8" style="width:100%">
<label>Zoom</label><div class="row"><button id="zoomOut">−</button><button id="zoomReset" class="zoom">100%</button><button id="zoomIn">+</button></div>
<p class="status">Wheel to zoom. Hold Space and drag to pan.</p>
</aside>
<main id="workspace" class="workspace"><div class="stage"><div class="canvas-wrap"><canvas id="canvas" width="256" height="256"></canvas></div></div></main>
<aside class="panel right"><strong>Snapshots</strong><div id="snapshots"><p class="empty">No snapshots yet.</p></div></aside>
</div>
<dialog id="canvasDialog">
<div class="dialog-head"><h2>Open or create a canvas</h2><button id="closeDialog" aria-label="Close">✕</button></div>
<div class="dialog-body">
<section class="dialog-section"><h3>Create a new canvas</h3><p>Choose a unique ID and canvas dimensions.</p>
<label>Canvas ID</label><input id="createCanvasId" type="text" maxlength="64" placeholder="weekend-doodles">
<div class="row"><div><label>Width</label><input id="createWidth" type="number" min="128" max="1024" value="512"></div><div><label>Height</label><input id="createHeight" type="number" min="128" max="1024" value="512"></div></div>
<label>Background</label><input id="createBackground" type="color" value="#ffffff"><button id="createCanvasBtn" style="width:100%;margin-top:10px">Create new canvas</button><div id="createCanvasMessage" class="dialog-message"></div></section>
<section class="dialog-section"><h3>Open an existing canvas</h3><p>Enter its shared canvas ID.</p><label>Canvas ID</label><input id="existingCanvasId" type="text" maxlength="64" placeholder="weekend-doodles"><button id="openExistingBtn" style="width:100%;margin-top:10px">Open existing canvas</button><div id="openCanvasMessage" class="dialog-message"></div></section>
</div></dialog>
<script>
const $=id=>document.getElementById(id);const canvas=$('canvas'),ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
let socket,currentId='',revision=0,zoom=1,tool='brush',canvasBackground='#ffffff',drawing=false,lastPoint=null,sentPoint=null,lastSentAt=0,panning=false,panStart=null;
const status=(text,bad=false)=>{$('status').textContent=text;$('status').className=bad?'status error':'status'};
const api=(path,options)=>fetch('/api/canvases/'+encodeURIComponent(currentId)+path,options).then(async r=>{if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||('Request failed: '+r.status));return r});
function setZoom(next,cx,cy){const workspace=$('workspace'),old=zoom;zoom=Math.max(.25,Math.min(32,next));const rect=workspace.getBoundingClientRect();const x=cx===undefined?rect.left+rect.width/2:cx;const y=cy===undefined?rect.top+rect.height/2:cy;const imageX=(workspace.scrollLeft+x-rect.left)/old;const imageY=(workspace.scrollTop+y-rect.top)/old;canvas.style.width=(canvas.width*zoom)+'px';canvas.style.height=(canvas.height*zoom)+'px';workspace.scrollLeft=imageX*zoom-(x-rect.left);workspace.scrollTop=imageY*zoom-(y-rect.top);$('zoomReset').textContent=Math.round(zoom*100)+'%'}
function point(event){const rect=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(canvas.width-1,(event.clientX-rect.left)*canvas.width/rect.width)),y:Math.max(0,Math.min(canvas.height-1,(event.clientY-rect.top)*canvas.height/rect.height))}}
function draw(from,to,size,color){ctx.strokeStyle=color;ctx.lineWidth=size;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);ctx.stroke()}
function activeColor(selectedTool=tool,color=$('color').value){return selectedTool==='eraser'?canvasBackground:color}
function sendStroke(from,to){if(!socket||socket.readyState!==1)return;socket.send(JSON.stringify({type:'stroke',strokeId:crypto.randomUUID(),tool,from,to,size:Number($('size').value),color:$('color').value}))}
function loadImage(url){return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0);resolve()};image.onerror=reject;image.src=url+'&t='+Date.now()})}
const validCanvasId=id=>/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id);
async function loadCurrentCanvas(){status('Opening…');try{const response=await fetch('/api/canvases/'+encodeURIComponent(currentId));if(response.status===404){$('canvasDialog').showModal();throw new Error('Canvas does not exist. Create it or open another canvas.')}const meta=await response.json();if(!response.ok)throw new Error(meta.error||'Could not open canvas.');canvas.width=meta.width;canvas.height=meta.height;canvasBackground=meta.background;revision=meta.revision;$('title').textContent='— '+meta.name;setZoom(zoom);await loadImage('/api/canvases/'+encodeURIComponent(currentId)+'/image?v='+revision);connect();await listSnapshots();status('Connected')}catch(error){status(error.message,true)}}
async function createCanvas(){const id=$('createCanvasId').value.trim(),message=$('createCanvasMessage');if(!validCanvasId(id)){message.textContent='Use letters, numbers, underscores, or hyphens.';return}const button=$('createCanvasBtn');button.disabled=true;message.textContent='';try{const response=await fetch('/api/canvases/'+encodeURIComponent(id),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:id,width:Number($('createWidth').value),height:Number($('createHeight').value),background:$('createBackground').value})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not create canvas.');if(response.status===200)throw new Error('That canvas ID already exists. Open it below.');location.href='/canvas/'+encodeURIComponent(id)}catch(error){message.textContent=error.message}finally{button.disabled=false}}
async function openExistingCanvas(){const id=$('existingCanvasId').value.trim(),message=$('openCanvasMessage');if(!validCanvasId(id)){message.textContent='Enter a valid canvas ID.';return}const button=$('openExistingBtn');button.disabled=true;message.textContent='';try{const response=await fetch('/api/canvases/'+encodeURIComponent(id));if(response.status===404)throw new Error('That canvas does not exist.');if(!response.ok){const data=await response.json();throw new Error(data.error||'Could not open canvas.')}location.href='/canvas/'+encodeURIComponent(id)}catch(error){message.textContent=error.message}finally{button.disabled=false}}
function connect(){if(socket)socket.close();const protocol=location.protocol==='https:'?'wss:':'ws:';socket=new WebSocket(protocol+'//'+location.host+'/api/canvases/'+encodeURIComponent(currentId)+'/connect');socket.onopen=()=>status('Connected');socket.onclose=()=>{status('Disconnected',true);setTimeout(()=>{if(currentId)connect()},1500)};socket.onmessage=async event=>{const message=JSON.parse(event.data);if(message.type==='welcome'){revision=message.revision;canvas.width=message.width;canvas.height=message.height;canvasBackground=message.background;setZoom(zoom);await loadImage(message.imageUrl)}else if(message.type==='stroke'){revision=message.revision;draw(message.from,message.to,message.size,activeColor(message.tool,message.color))}else if(message.type==='reset'){revision=message.revision;await loadImage(message.imageUrl);status('Snapshot restored')}else if(message.type==='restore-started')status('Restoring…');else if(message.type==='snapshot-created')listSnapshots();else if(message.type==='stroke-rejected'){status('Stroke rejected; reloading',true);await loadImage('/api/canvases/'+encodeURIComponent(currentId)+'/image?v='+revision)}else if(message.type==='server-error')status('Canvas persistence is retrying…',true)}}
canvas.addEventListener('pointerdown',event=>{if(event.button!==0||panning)return;drawing=true;lastPoint=point(event);sentPoint=lastPoint;lastSentAt=performance.now();canvas.setPointerCapture(event.pointerId);draw(lastPoint,lastPoint,Number($('size').value),activeColor());sendStroke(lastPoint,lastPoint)});
canvas.addEventListener('pointermove',event=>{if(!drawing||!lastPoint||!sentPoint)return;const next=point(event);draw(lastPoint,next,Number($('size').value),activeColor());lastPoint=next;const now=performance.now();if(now-lastSentAt>=32){sendStroke(sentPoint,next);sentPoint=next;lastSentAt=now}});
canvas.addEventListener('pointerup',()=>{if(lastPoint&&sentPoint&&(lastPoint.x!==sentPoint.x||lastPoint.y!==sentPoint.y))sendStroke(sentPoint,lastPoint);drawing=false;lastPoint=null;sentPoint=null});canvas.addEventListener('pointercancel',()=>{drawing=false;lastPoint=null;sentPoint=null});
$('workspace').addEventListener('wheel',event=>{event.preventDefault();setZoom(zoom*(event.deltaY<0?1.15:1/1.15),event.clientX,event.clientY)},{passive:false});
window.addEventListener('keydown',event=>{if(event.code==='Space'&&!event.repeat){panning=true;$('workspace').style.cursor='grab';event.preventDefault()}});window.addEventListener('keyup',event=>{if(event.code==='Space'){panning=false;panStart=null;$('workspace').style.cursor=''}});
$('workspace').addEventListener('pointerdown',event=>{if(!panning)return;panStart={x:event.clientX,y:event.clientY,left:$('workspace').scrollLeft,top:$('workspace').scrollTop};$('workspace').setPointerCapture(event.pointerId)});$('workspace').addEventListener('pointermove',event=>{if(!panStart)return;$('workspace').scrollLeft=panStart.left-(event.clientX-panStart.x);$('workspace').scrollTop=panStart.top-(event.clientY-panStart.y)});$('workspace').addEventListener('pointerup',()=>panStart=null);
async function listSnapshots(){try{const data=await (await api('/snapshots')).json();const root=$('snapshots');root.innerHTML='';if(!data.snapshots.length){root.innerHTML='<p class="empty">No snapshots yet.</p>';return}for(const snapshot of data.snapshots){const item=document.createElement('div');item.className='snapshot';const title=document.createElement('b');title.textContent=snapshot.name;const info=document.createElement('small');info.textContent='Revision '+snapshot.canvasRevision+' · '+new Date(snapshot.createdAt).toLocaleString();const button=document.createElement('button');button.textContent='Restore';button.onclick=()=>restore(snapshot.id,snapshot.name);item.append(title,info,button);root.append(item)}}catch(error){status(error.message,true)}}
async function saveSnapshot(){const name=prompt('Snapshot name');if(!name)return;$('snapshotBtn').disabled=true;status('Saving snapshot…');try{await api('/snapshots',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});await listSnapshots();status('Snapshot saved')}catch(error){status(error.message,true)}finally{$('snapshotBtn').disabled=false}}
async function forkCanvas(){const suggested=currentId+'-fork',id=prompt('New canvas ID',suggested);if(!id)return;if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)){status('Invalid fork canvas ID',true);return}const name=prompt('New canvas name',id);if(name===null)return;$('forkBtn').disabled=true;status('Forking canvas…');try{const data=await (await api('/fork',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name:name||id})})).json();location.href=data.url}catch(error){status(error.message,true);$('forkBtn').disabled=false}}
async function restore(id,name){if(!confirm('Restore “'+name+'”? Current unsnapshotted changes will be lost.'))return;try{await api('/snapshots/'+encodeURIComponent(id)+'/restore',{method:'POST'});await listSnapshots()}catch(error){status(error.message,true)}}
function selectTool(next){tool=next;$('brushBtn').classList.toggle('active',tool==='brush');$('eraserBtn').classList.toggle('active',tool==='eraser');canvas.style.cursor=tool==='eraser'?'cell':'crosshair'}
$('openBtn').onclick=()=>$('canvasDialog').showModal();$('closeDialog').onclick=()=>$('canvasDialog').close();$('createCanvasBtn').onclick=createCanvas;$('openExistingBtn').onclick=openExistingCanvas;$('existingCanvasId').addEventListener('keydown',event=>{if(event.key==='Enter')openExistingCanvas()});$('snapshotBtn').onclick=saveSnapshot;$('forkBtn').onclick=forkCanvas;$('brushBtn').onclick=()=>selectTool('brush');$('eraserBtn').onclick=()=>selectTool('eraser');$('size').oninput=()=>$('sizeValue').textContent=$('size').value;$('zoomIn').onclick=()=>setZoom(zoom*1.25);$('zoomOut').onclick=()=>setZoom(zoom/1.25);$('zoomReset').onclick=()=>setZoom(1);
currentId=decodeURIComponent(location.pathname.split('/')[2]||'');loadCurrentCanvas();
</script>
</body></html>`;
