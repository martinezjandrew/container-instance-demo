import { DurableObject } from "cloudflare:workers";
import pRetry from "p-retry";

const CONTAINER_PORT = 8080;
const COMMIT_PREFIX = "commit:";
const METADATA_KEY = "canvas:metadata";
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const CLOUD_NAMES = [
  "Cirrus", "Cumulus", "Stratus", "Nimbus", "Altocumulus", "Altostratus",
  "Cirrostratus", "Cirrocumulus", "Stratocumulus", "Nimbostratus", "Mammatus",
  "Lenticular", "Noctilucent", "Contrail", "Virga", "Kelvin-Helmholtz",
] as const;

type CommitRef = {
  canvasId: string;
  commitId: string;
  message: string;
  revision: number;
};

type CanvasMetadata = {
  id: string;
  name: string;
  width: number;
  height: number;
  background: string;
  revision: number;
  headCommit?: CommitRef;
  forkedFrom?: CommitRef;
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

type StoredCanvasCommit = {
  id: string;
  canvasId: string;
  name: string;
  snapshot: ContainerSnapshot;
  canvasRevision: number;
  parent?: CommitRef;
  author?: string;
  createdAt: string;
  size: number;
  snapshotElapsedMs: number;
};

type SocketAttachment = { clientId: string; name: string; lastSeen: number };

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

    const metadata = await this.metadata();
    if (metadata?.headCommit) {
      const commit = await this.ctx.storage.get<StoredCanvasCommit>(
        `${COMMIT_PREFIX}${metadata.headCommit.commitId}`,
      );
      if (!commit) throw new Error("The canvas HEAD commit is missing.");

      this.container.start({ containerSnapshot: commit.snapshot, enableInternet: false });
      await this.waitForContainer();
      metadata.revision = commit.canvasRevision;
      metadata.updatedAt = new Date().toISOString();
      await this.ctx.storage.put(METADATA_KEY, metadata);
      this.broadcast({
        type: "reset",
        revision: metadata.revision,
        imageUrl: `/api/canvases/${encodeURIComponent(metadata.id)}/image?v=${metadata.revision}&head=${Date.now()}`,
        reason: "container-restored-from-head",
      });
      return true;
    }

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

  private displayName(value: unknown, exclude?: WebSocket): string {
    if (typeof value === "string") {
      const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ");
      if (cleaned) return cleaned.slice(0, 32);
    }

    const used = new Set(
      this.ctx.getWebSockets()
        .filter((socket) => socket !== exclude && socket.readyState === 1)
        .map((socket) => (socket.deserializeAttachment() as SocketAttachment | null)?.name)
        .filter((name): name is string => Boolean(name)),
    );
    return CLOUD_NAMES.find((name) => !used.has(name)) ??
      `${CLOUD_NAMES[this.ctx.getWebSockets().filter((socket) => socket.readyState === 1).length % CLOUD_NAMES.length]} ${this.ctx.getWebSockets().filter((socket) => socket.readyState === 1).length + 1}`;
  }

  private broadcastPresence(): void {
    const users = this.ctx.getWebSockets().filter((socket) => socket.readyState === 1).flatMap((socket) => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      return attachment ? [{ clientId: attachment.clientId, name: attachment.name }] : [];
    });
    this.broadcast({ type: "presence", users });
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

    const messageType = parsed && typeof parsed === "object"
      ? (parsed as { type?: unknown }).type
      : undefined;
    const now = Date.now();
    if (messageType === "heartbeat" || now - attachment.lastSeen >= 10_000) {
      attachment.lastSeen = now;
      socket.serializeAttachment(attachment);
    }
    if (messageType === "heartbeat") return;

    if (messageType === "set-name") {
      attachment.name = this.displayName((parsed as { name?: unknown }).name, socket);
      socket.serializeAttachment(attachment);
      this.broadcastPresence();
      return;
    }

    const metadata = await this.metadata();
    if (!metadata) return;
    if (parsed && typeof parsed === "object" && (parsed as { type?: unknown }).type === "cursor") {
      const cursor = parsed as { x?: unknown; y?: unknown; visible?: unknown };
      if (cursor.visible === false) {
        this.broadcast({ type: "cursor", clientId: attachment.clientId, name: attachment.name, visible: false });
        return;
      }
      if (typeof cursor.x !== "number" || typeof cursor.y !== "number" ||
          !Number.isFinite(cursor.x) || !Number.isFinite(cursor.y) ||
          cursor.x < 0 || cursor.y < 0 || cursor.x >= metadata.width || cursor.y >= metadata.height) {
        return;
      }
      this.broadcast({
        type: "cursor",
        clientId: attachment.clientId,
        name: attachment.name,
        x: cursor.x,
        y: cursor.y,
        visible: true,
      });
      return;
    }

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
        if (started && metadata.headCommit && batch[0].revision !== metadata.revision + 1) {
          // Earlier uncommitted strokes were lost with the old Container, so
          // continuing this revision sequence would corrupt the working tree.
          this.pendingStrokes = [];
          return;
        }
        if (started && !metadata.headCommit) {
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
    if (attachment) {
      this.recentStrokeIds.delete(attachment.clientId);
      this.broadcast({ type: "cursor", clientId: attachment.clientId, visible: false });
    }
    this.broadcastPresence();
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment) {
      this.recentStrokeIds.delete(attachment.clientId);
      this.broadcast({ type: "cursor", clientId: attachment.clientId, visible: false });
    }
    this.broadcastPresence();
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
    const requestedName = new URL(request.url).searchParams.get("name");
    const name = this.displayName(requestedName);
    server.serializeAttachment({ clientId, name, lastSeen: Date.now() } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({
      type: "welcome",
      clientId,
      name,
      revision: metadata.revision,
      width: metadata.width,
      height: metadata.height,
      background: metadata.background,
      imageUrl: `/api/canvases/${encodeURIComponent(metadata.id)}/image?v=${metadata.revision}`,
    }));
    this.broadcastPresence();
    await this.ensurePresenceAlarm();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async ensurePresenceAlarm(): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  async alarm(): Promise<void> {
    const cutoff = Date.now() - 90_000;
    let removed = false;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (socket.readyState !== 1 || !attachment || typeof attachment.lastSeen !== "number" || attachment.lastSeen < cutoff) {
        removed = true;
        try {
          socket.close(4000, "presence timeout");
        } catch {
          // The socket may already be gone.
        }
      }
    }
    if (removed) this.broadcastPresence();
    if (this.ctx.getWebSockets().some((socket) => socket.readyState === 1)) {
      await this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  private commitDetails(stored: StoredCanvasCommit) {
    return {
      id: stored.id,
      canvasId: stored.canvasId,
      name: stored.name,
      canvasRevision: stored.canvasRevision,
      parent: stored.parent,
      author: stored.author ?? "Unknown artist",
      createdAt: stored.createdAt,
      size: stored.size,
      snapshotElapsedMs: stored.snapshotElapsedMs,
    };
  }

  private async createCommit(request: Request): Promise<Response> {
    return await this.exclusive(async () => {
      await this.flushPendingStrokes();
      const metadata = await this.metadata();
      if (!metadata) return Response.json({ error: "Canvas does not exist." }, { status: 404 });
      const input = (await request.json()) as { name?: unknown; message?: unknown; author?: unknown };
      const messageValue = typeof input.message === "string" ? input.message : input.name;
      const name = typeof messageValue === "string" ? messageValue.trim() : "";
      const author = typeof input.author === "string" && input.author.trim()
        ? input.author.trim().slice(0, 32)
        : "Anonymous cloud";
      if (!name || name.length > 80) {
        return Response.json({ error: "Commit message must contain 1 to 80 characters." }, { status: 400 });
      }
      const started = await this.startContainer();
      if (started) await this.initializeContainer(metadata);
      const flush = await this.containerFetch("/flush", { method: "POST" });
      if (!flush.ok) throw new Error(`Canvas flush failed: ${await flush.text()}`);

      const startedAt = performance.now();
      const snapshot = await this.container.snapshotContainer({ name });
      const stored: StoredCanvasCommit = {
        id: crypto.randomUUID(),
        canvasId: metadata.id,
        name,
        snapshot,
        canvasRevision: metadata.revision,
        parent: metadata.headCommit,
        author,
        createdAt: new Date().toISOString(),
        size: snapshot.size,
        snapshotElapsedMs: performance.now() - startedAt,
      };
      const commitRef: CommitRef = {
        canvasId: stored.canvasId,
        commitId: stored.id,
        message: stored.name,
        revision: stored.canvasRevision,
      };
      metadata.headCommit = commitRef;
      metadata.updatedAt = stored.createdAt;
      await this.ctx.storage.put({
        [`${COMMIT_PREFIX}${stored.id}`]: stored,
        [METADATA_KEY]: metadata,
      });
      this.broadcast({ type: "commit-created", commit: this.commitDetails(stored), headCommit: commitRef });
      return Response.json(this.commitDetails(stored), { status: 201 });
    });
  }

  private async listCommits(): Promise<Response> {
    const entries = await this.ctx.storage.list<StoredCanvasCommit>({ prefix: COMMIT_PREFIX });
    const commits = Array.from(entries.values(), (value) => this.commitDetails(value))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Response.json({ commits });
  }

  private async commitMetadata(commitId: string): Promise<Response> {
    const stored = await this.ctx.storage.get<StoredCanvasCommit>(`${COMMIT_PREFIX}${commitId}`);
    const metadata = await this.metadata();
    if (!stored || !metadata) return Response.json({ error: "Commit does not exist." }, { status: 404 });
    return Response.json({
      ...this.commitDetails(stored),
      isHead: metadata.headCommit?.commitId === stored.id,
      forkedFrom: metadata.forkedFrom,
      canvas: { id: metadata.id, name: metadata.name, width: metadata.width, height: metadata.height },
    });
  }

  private async commitImage(commitId: string): Promise<Response> {
    const stored = await this.ctx.storage.get<StoredCanvasCommit>(`${COMMIT_PREFIX}${commitId}`);
    if (!stored) return Response.json({ error: "Commit does not exist." }, { status: 404 });
    const previewId = this.env.SANDBOX.idFromName(`commit-preview:${stored.canvasId}:${stored.id}`);
    const preview = this.env.SANDBOX.get(previewId);
    return await preview.renderCommitPreview({ id: stored.snapshot.id }, stored.id);
  }

  async renderCommitPreview(
    snapshot: ContainerSnapshotRestoreParams,
    commitId: string,
  ): Promise<Response> {
    return await this.exclusive(async () => {
      const loadedCommit = await this.ctx.storage.get<string>("preview:commit");
      if (!this.container.running || loadedCommit !== commitId) {
        if (this.container.running) await this.container.destroy();
        this.container.start({ containerSnapshot: snapshot, enableInternet: false });
        await this.waitForContainer();
        await this.ctx.storage.put("preview:commit", commitId);
      }
      await this.container.setInactivityTimeout(60_000);
      const response = await this.containerFetch("/canvas.png");
      return new Response(response.body, {
        status: response.status,
        headers: {
          "Content-Type": response.headers.get("Content-Type") ?? "image/png",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    });
  }

  private async forkFromCommit(request: Request, commitId: string): Promise<Response> {
    return await this.exclusive(async () => {
      const source = await this.metadata();
      const stored = await this.ctx.storage.get<StoredCanvasCommit>(`${COMMIT_PREFIX}${commitId}`);
      if (!source || !stored) return Response.json({ error: "Commit does not exist." }, { status: 404 });

      const input = await request.json() as { id?: unknown; name?: unknown };
      const targetId = typeof input.id === "string" ? input.id.trim() : "";
      const targetName = typeof input.name === "string" && input.name.trim()
        ? input.name.trim().slice(0, 80)
        : targetId;
      if (!validCanvasId(targetId) || targetId === source.id) {
        return Response.json({ error: "Choose a different valid canvas ID." }, { status: 400 });
      }
      const target = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(targetId));
      if (await target.canvasExists()) {
        return Response.json({ error: "That canvas ID already exists." }, { status: 409 });
      }

      const baseRef: CommitRef = {
        canvasId: stored.canvasId,
        commitId: stored.id,
        message: stored.name,
        revision: stored.canvasRevision,
      };
      const now = new Date().toISOString();
      await target.initializeFromFork(
        { id: stored.snapshot.id },
        {
          ...source,
          id: targetId,
          name: targetName,
          revision: stored.canvasRevision,
          headCommit: baseRef,
          forkedFrom: baseRef,
          createdAt: now,
          updatedAt: now,
        },
        stored,
      );
      return Response.json({
        id: targetId,
        name: targetName,
        revision: stored.canvasRevision,
        url: `/canvas/${encodeURIComponent(targetId)}`,
      }, { status: 201 });
    });
  }

  private async forkCanvas(request: Request): Promise<Response> {
    return await this.exclusive(async () => {
      const source = await this.metadata();
      if (!source) return Response.json({ error: "Canvas does not exist." }, { status: 404 });

      const input = await request.json() as { id?: unknown; name?: unknown; author?: unknown };
      const targetId = typeof input.id === "string" ? input.id.trim() : "";
      const targetName = typeof input.name === "string" && input.name.trim()
        ? input.name.trim().slice(0, 80)
        : targetId;
      const author = typeof input.author === "string" && input.author.trim()
        ? input.author.trim().slice(0, 32)
        : "Anonymous cloud";
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
      const stored: StoredCanvasCommit = {
        id: crypto.randomUUID(),
        canvasId: source.id,
        name: `Forked to ${targetName}`,
        snapshot,
        canvasRevision: forkRevision,
        parent: source.headCommit,
        author,
        createdAt: new Date().toISOString(),
        size: snapshot.size,
        snapshotElapsedMs: performance.now() - startedAt,
      };
      const forkCommit: CommitRef = {
        canvasId: source.id,
        commitId: stored.id,
        message: stored.name,
        revision: forkRevision,
      };
      source.headCommit = forkCommit;
      await this.ctx.storage.put({
        [`${COMMIT_PREFIX}${stored.id}`]: stored,
        [METADATA_KEY]: source,
      });

      await target.initializeFromFork(
        { id: snapshot.id },
        {
          ...source,
          id: targetId,
          name: targetName,
          revision: forkRevision,
          headCommit: forkCommit,
          forkedFrom: forkCommit,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        stored,
      );
      this.broadcast({ type: "commit-created", commit: this.commitDetails(stored), headCommit: forkCommit });
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
    baseCommit: StoredCanvasCommit,
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
      await this.ctx.storage.put({
        [METADATA_KEY]: metadata,
        [`${COMMIT_PREFIX}${baseCommit.id}`]: baseCommit,
      });
    });
  }

  private async resetToCommit(commitId: string): Promise<Response> {
    return await this.exclusive(async () => {
      const stored = await this.ctx.storage.get<StoredCanvasCommit>(`${COMMIT_PREFIX}${commitId}`);
      const metadata = await this.metadata();
      if (!stored || !metadata) return Response.json({ error: "Commit does not exist." }, { status: 404 });

      // Reset intentionally discards all changes after the selected commit,
      // including strokes that have been broadcast but not flushed yet.
      this.pendingStrokes = [];
      this.broadcast({ type: "reset-started", commitId });
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
      metadata.headCommit = {
        canvasId: stored.canvasId,
        commitId: stored.id,
        message: stored.name,
        revision: stored.canvasRevision,
      };
      metadata.updatedAt = new Date().toISOString();
      await this.ctx.storage.put(METADATA_KEY, metadata);
      const resetElapsedMs = performance.now() - startedAt;
      this.broadcast({
        type: "reset",
        revision: metadata.revision,
        imageUrl: `/api/canvases/${encodeURIComponent(metadata.id)}/image?v=${metadata.revision}&restored=${Date.now()}`,
      });
      return Response.json({ ...this.commitDetails(stored), resetElapsedMs });
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
      if (action[0] === "commits" && action.length === 1 && request.method === "GET") return await this.listCommits();
      if (action[0] === "commits" && action.length === 1 && request.method === "POST") return await this.createCommit(request);
      if (action[0] === "commits" && action.length === 2 && request.method === "GET") return await this.commitMetadata(decodeURIComponent(action[1] ?? ""));
      if (action[0] === "commits" && action[2] === "image" && request.method === "GET") return await this.commitImage(decodeURIComponent(action[1] ?? ""));
      if (action[0] === "commits" && action[2] === "fork" && request.method === "POST") return await this.forkFromCommit(request, decodeURIComponent(action[1] ?? ""));
      if (action[0] === "fork" && action.length === 1 && request.method === "POST") return await this.forkCanvas(request);
      if (action[0] === "commits" && action[2] === "reset" && request.method === "POST") {
        return await this.resetToCommit(decodeURIComponent(action[1] ?? ""));
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
    const commitMatch = url.pathname.match(/^\/canvas\/([^/]+)\/commits\/([^/]+)$/);
    if (commitMatch && validCanvasId(decodeURIComponent(commitMatch[1]))) {
      return new Response(COMMIT_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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

const COMMIT_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Commit Preview · Snapshot Canvas</title>
<style>
:root{color-scheme:dark;--panel:#171923;--border:#303445;--accent:#7c5cff}*{box-sizing:border-box}body{margin:0;min-height:100vh;font:14px system-ui,sans-serif;background:#0d0f15;color:#f4f4f7}header{position:relative;z-index:50;height:58px;display:flex;align-items:center;gap:10px;padding:9px 16px;background:var(--panel);border-bottom:1px solid var(--border)}header a{color:inherit;text-decoration:none}.back{padding:7px 10px;background:#262a38;border:1px solid #3b4053;border-radius:7px}.back:hover{border-color:var(--accent)}header .spacer{flex:1}button{position:relative;padding:8px 11px;color:#fff;background:#262a38;border:1px solid #3b4053;border-radius:7px;cursor:pointer}button:hover{border-color:var(--accent)}button::after{content:attr(data-tooltip);position:absolute;top:calc(100% + 8px);right:0;width:max-content;max-width:220px;padding:6px 8px;color:#fff;background:#090b10;border:1px solid #3b4053;border-radius:5px;opacity:0;visibility:hidden;z-index:10;pointer-events:none}button:hover::after{opacity:1;visibility:visible}.page{height:calc(100vh - 58px);display:grid;grid-template-rows:auto 1fr}.meta{padding:16px 20px;background:#131620;border-bottom:1px solid var(--border)}.meta h1{margin:0 0 6px;font-size:20px}.muted{color:#9299aa}.workspace{overflow:auto;display:flex;align-items:center;justify-content:center;padding:70px;background:#252836}.image-wrap{line-height:0;box-shadow:0 10px 40px #0009}img{display:block;image-rendering:pixelated}.status{color:#aeb4c4}.danger{border-color:#82404a}dialog{width:min(430px,calc(100vw - 30px));padding:20px;color:#fff;background:var(--panel);border:1px solid var(--border);border-radius:12px}dialog::backdrop{background:#000a}dialog input{width:100%;margin:6px 0 12px;padding:9px;color:#fff;background:#0d0f15;border:1px solid #3b4053;border-radius:6px}.row{display:flex;gap:8px;justify-content:flex-end}
</style></head><body>
<header><a id="backButton" class="back" href="#">← Back</a><strong><a href="/">Snapshot Canvas</a></strong><span>/ Commit preview</span><span class="spacer"></span><span id="status" class="status">Loading…</span><button id="previewFork" data-tooltip="Create a new canvas from this exact commit.">⑂ Fork</button><button id="previewReset" class="danger" data-tooltip="Move the original canvas HEAD back to this commit.">↶ Reset</button></header>
<main class="page"><section class="meta"><h1 id="message">Commit</h1><div id="details" class="muted"></div></section><section id="workspace" class="workspace"><div class="image-wrap"><img id="image" alt="Read-only canvas commit"></div></section></main>
<dialog id="forkDialog"><h2>Fork this commit</h2><label>New canvas ID</label><input id="forkId" maxlength="64"><label>New canvas name</label><input id="forkName" maxlength="80"><div id="forkError" class="muted"></div><div class="row"><button id="forkCancel">Cancel</button><button id="forkCreate">⑂ Fork</button></div></dialog>
<script>
const parts=location.pathname.split('/'),canvasId=decodeURIComponent(parts[2]||''),commitId=decodeURIComponent(parts[4]||''),$=id=>document.getElementById(id);let commit,scale=1;
const endpoint='/api/canvases/'+encodeURIComponent(canvasId)+'/commits/'+encodeURIComponent(commitId);$('backButton').href='/canvas/'+encodeURIComponent(canvasId);
async function load(){try{const response=await fetch(endpoint);commit=await response.json();if(!response.ok)throw new Error(commit.error||'Commit not found');$('message').textContent=commit.name;$('details').textContent=commit.author+' committed revision '+commit.canvasRevision+' · '+new Date(commit.createdAt).toLocaleString()+(commit.isHead?' · HEAD':'');$('image').src=endpoint+'/image';$('image').onload=()=>{$('status').textContent='Read-only';fit()};$('image').onerror=()=>{$('status').textContent='Preview failed'}}catch(error){$('status').textContent=error.message}}
function applyScale(){const image=$('image');image.style.width=(image.naturalWidth*scale)+'px';image.style.height=(image.naturalHeight*scale)+'px'}function fit(){const image=$('image'),workspace=$('workspace');scale=Math.min(1,(workspace.clientWidth-100)/image.naturalWidth,(workspace.clientHeight-100)/image.naturalHeight);applyScale()}
$('previewFork').onclick=()=>{$('forkId').value=canvasId+'-fork';$('forkName').value=canvasId+' fork';$('forkDialog').showModal()};$('forkCancel').onclick=()=>$('forkDialog').close();$('forkCreate').onclick=async()=>{const id=$('forkId').value.trim(),name=$('forkName').value.trim()||id;$('forkError').textContent='';try{const response=await fetch(endpoint+'/fork',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not fork commit');location.href=data.url}catch(error){$('forkError').textContent=error.message}};
$('previewReset').onclick=async()=>{if(!confirm('Reset '+canvasId+' to this commit? Current uncommitted work will be lost.'))return;const response=await fetch(endpoint+'/reset',{method:'POST'});if(response.ok)location.href='/canvas/'+encodeURIComponent(canvasId);else{const data=await response.json();$('status').textContent=data.error||'Reset failed'}};$('workspace').addEventListener('wheel',event=>{event.preventDefault();scale=Math.max(.25,Math.min(32,scale*(event.deltaY<0?1.15:1/1.15)));applyScale()},{passive:false});window.addEventListener('resize',fit);load();
</script></body></html>`;

const APP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Snapshot Canvas</title>
<style>
:root{color-scheme:dark;--panel:#171923;--border:#303445;--accent:#7c5cff}*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif;background:#0d0f15;color:#f4f4f7;height:100vh;overflow:hidden}button,input{font:inherit}button{color:#fff;background:#262a38;border:1px solid #3b4053;border-radius:7px;padding:7px 10px;cursor:pointer}button:hover{border-color:#7c5cff}button.tooltip{position:relative}button.tooltip::after{content:attr(data-tooltip);position:absolute;top:calc(100% + 8px);right:0;width:max-content;max-width:240px;padding:7px 9px;color:#f4f4f7;background:#0b0d13;border:1px solid #3b4053;border-radius:6px;box-shadow:0 8px 24px #0008;font-size:12px;font-weight:400;line-height:1.35;text-align:left;white-space:normal;opacity:0;visibility:hidden;transform:translateY(-3px);transition:opacity .12s,transform .12s,visibility .12s;pointer-events:none;z-index:30}button.tooltip:hover::after,button.tooltip:focus-visible::after{opacity:1;visibility:visible;transform:translateY(0)}button.active{background:#7c5cff;border-color:#9b87ff}button:disabled{opacity:.5;cursor:wait}header{position:relative;z-index:50;height:54px;display:flex;align-items:center;gap:10px;padding:8px 14px;background:var(--panel);border-bottom:1px solid var(--border)}header strong{font-size:17px}header a{color:inherit;text-decoration:none}.presence{display:flex;align-items:center;gap:6px;min-width:0;overflow-x:auto;scrollbar-width:thin}.presence-label{color:#858c9d;font-size:12px}.person{max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 8px;border:1px solid #41475c;border-radius:999px;background:#232735;color:#dce0ec;font-size:12px}.person.me{border-color:#8068ff;background:#312958}.fork-badge{padding:4px 8px;border-radius:999px;color:#bfc4d2;background:#202431;border-color:#3a4053;font-size:12px}.spacer{flex:1}.status{color:#a7adbd}.app{height:calc(100vh - 54px);display:grid;grid-template-columns:220px 1fr 240px}.panel{padding:14px;background:var(--panel);overflow:auto}.left{border-right:1px solid var(--border)}.right{border-left:1px solid var(--border)}label{display:block;color:#aeb4c4;margin:12px 0 5px}input[type=text],input[type=number]{width:100%;padding:8px;background:#0f1119;color:#fff;border:1px solid #393e50;border-radius:6px}input[type=color]{width:100%;height:38px;background:none;border:0}.row{display:flex;gap:7px}.row>*{flex:1}.workspace{overflow:auto;background:#252836;position:relative}.stage{min-width:100%;min-height:100%;display:flex;align-items:center;justify-content:center;padding:80px}.canvas-wrap{position:relative;box-shadow:0 8px 35px #0008;line-height:0}canvas{background:#fff;image-rendering:pixelated;touch-action:none;cursor:crosshair}.cursor-layer{position:absolute;inset:0;pointer-events:none;overflow:visible}.remote-cursor{position:absolute;width:16px;height:22px;pointer-events:auto;z-index:5;transition:left 45ms linear,top 45ms linear}.cursor-arrow{position:absolute;inset:0;background:var(--cursor-color);clip-path:polygon(0 0,0 17px,5px 13px,9px 21px,12px 19px,8px 12px,16px 12px);filter:drop-shadow(0 1px 1px #000)}.cursor-name{position:absolute;left:13px;top:17px;line-height:1;padding:5px 7px;color:#fff;background:#10121bdc;border:1px solid var(--cursor-color);border-radius:5px;white-space:nowrap;opacity:0;transform:translateY(3px);transition:opacity .12s,transform .12s;pointer-events:none}.remote-cursor:hover .cursor-name{opacity:1;transform:translateY(0)}.snapshot{padding:9px 0;border-bottom:1px solid var(--border)}.snapshot b{display:block}.snapshot small{display:block;color:#979dad;margin:4px 0 7px}.commit-actions{display:flex;gap:6px}.commit-actions button{flex:1;padding:6px}.empty{color:#888e9e}.error{color:#ff8e9b}.zoom{min-width:64px;text-align:center}dialog{width:min(520px,calc(100vw - 32px));padding:0;color:#f4f4f7;background:#171923;border:1px solid #3a3f52;border-radius:14px;box-shadow:0 24px 90px #000b}dialog::backdrop{background:#080a10bf;backdrop-filter:blur(3px)}.dialog-head{display:flex;align-items:center;padding:16px 18px;border-bottom:1px solid var(--border)}.dialog-head h2{margin:0;font-size:19px}.dialog-head button{margin-left:auto;padding:4px 9px}.dialog-body{padding:18px}.dialog-section+ .dialog-section{margin-top:22px;padding-top:20px;border-top:1px solid var(--border)}.dialog-section h3{margin:0 0 4px}.dialog-section p{margin:0 0 10px;color:#969cad}.dialog-message{min-height:18px;margin-top:8px;color:#ff8e9b}
</style>
</head>
<body>
<header><strong><a href="/">Snapshot Canvas</a></strong><span id="title"></span><button id="forkedFrom" class="fork-badge tooltip" data-tooltip="Click to return to the original canvas this fork came from." aria-label="Return to the original canvas" hidden></button><div id="presence" class="presence"></div><span class="spacer"></span><span id="status" class="status">Starting…</span><button id="forkBtn" class="tooltip" data-tooltip="Create a new independent canvas from the current state." aria-label="Fork: create a new canvas from the current state">Fork</button><button id="snapshotBtn" class="tooltip" data-tooltip="Save the current canvas as an immutable snapshot-backed commit." aria-label="Commit: save the current canvas as an immutable commit">Commit</button></header>
<div class="app">
<aside class="panel left">
<button id="openBtn" style="width:100%">Open or create</button>
<hr style="border:0;border-top:1px solid #303445;margin:18px 0">
<label>Your name</label><input id="displayName" type="text" maxlength="32" placeholder="Assigned cloud name">
<hr style="border:0;border-top:1px solid #303445;margin:18px 0">
<label>Tool</label><div class="row"><button id="brushBtn" class="active">Brush</button><button id="eraserBtn">Eraser</button></div>
<label>Brush color</label><input id="color" type="color" value="#7c5cff">
<label>Brush size: <span id="sizeValue">8</span>px</label><input id="size" type="range" min="1" max="64" value="8" style="width:100%">
<label>Zoom</label><div class="row"><button id="zoomOut">−</button><button id="zoomReset" class="zoom">100%</button><button id="zoomIn">+</button></div>
<p class="status">Wheel to zoom. Hold Space and drag to pan.</p>
</aside>
<main id="workspace" class="workspace"><div class="stage"><div class="canvas-wrap"><canvas id="canvas" width="256" height="256"></canvas><div id="cursorLayer" class="cursor-layer"></div></div></div></main>
<aside class="panel right"><strong>Commit history</strong><div id="snapshots"><p class="empty">No commits yet.</p></div></aside>
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
let socket,currentId='',clientId='',revision=0,zoom=1,tool='brush',canvasBackground='#ffffff',drawing=false,lastPoint=null,sentPoint=null,lastSentAt=0,lastCursorAt=0,panning=false,panStart=null,nameTimer,heartbeatTimer,reconnectTimer,leaving=false;const cursorElements=new Map();
const status=(text,bad=false)=>{$('status').textContent=text;$('status').className=bad?'status error':'status'};
const api=(path,options)=>fetch('/api/canvases/'+encodeURIComponent(currentId)+path,options).then(async r=>{if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||('Request failed: '+r.status));return r});
function setZoom(next,cx,cy){const workspace=$('workspace'),old=zoom;zoom=Math.max(.25,Math.min(32,next));const rect=workspace.getBoundingClientRect();const x=cx===undefined?rect.left+rect.width/2:cx;const y=cy===undefined?rect.top+rect.height/2:cy;const imageX=(workspace.scrollLeft+x-rect.left)/old;const imageY=(workspace.scrollTop+y-rect.top)/old;canvas.style.width=(canvas.width*zoom)+'px';canvas.style.height=(canvas.height*zoom)+'px';workspace.scrollLeft=imageX*zoom-(x-rect.left);workspace.scrollTop=imageY*zoom-(y-rect.top);$('zoomReset').textContent=Math.round(zoom*100)+'%'}
function point(event){const rect=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(canvas.width-1,(event.clientX-rect.left)*canvas.width/rect.width)),y:Math.max(0,Math.min(canvas.height-1,(event.clientY-rect.top)*canvas.height/rect.height))}}
function draw(from,to,size,color){ctx.strokeStyle=color;ctx.lineWidth=size;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();ctx.moveTo(from.x,from.y);ctx.lineTo(to.x,to.y);ctx.stroke()}
function activeColor(selectedTool=tool,color=$('color').value){return selectedTool==='eraser'?canvasBackground:color}
function sendStroke(from,to){if(!socket||socket.readyState!==1)return;socket.send(JSON.stringify({type:'stroke',strokeId:crypto.randomUUID(),tool,from,to,size:Number($('size').value),color:$('color').value}))}
function sendCursor(position,visible=true){if(!socket||socket.readyState!==1)return;socket.send(JSON.stringify(visible?{type:'cursor',x:position.x,y:position.y,visible:true}:{type:'cursor',visible:false}))}
function loadImage(url){return new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0);resolve()};image.onerror=reject;image.src=url+'&t='+Date.now()})}
const validCanvasId=id=>/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id);
async function loadCurrentCanvas(){status('Opening…');try{const response=await fetch('/api/canvases/'+encodeURIComponent(currentId));if(response.status===404){$('canvasDialog').showModal();throw new Error('Canvas does not exist. Create it or open another canvas.')}const meta=await response.json();if(!response.ok)throw new Error(meta.error||'Could not open canvas.');canvas.width=meta.width;canvas.height=meta.height;canvasBackground=meta.background;revision=meta.revision;$('title').textContent='— '+meta.name;const forkBadge=$('forkedFrom');if(meta.forkedFrom){forkBadge.hidden=false;forkBadge.textContent='forked from '+meta.forkedFrom.canvasId+' @ '+meta.forkedFrom.message;forkBadge.onclick=()=>{if(confirm('Open the original canvas? Its current working state may have changed since this commit.'))location.href='/canvas/'+encodeURIComponent(meta.forkedFrom.canvasId)}}else forkBadge.hidden=true;setZoom(zoom);await loadImage('/api/canvases/'+encodeURIComponent(currentId)+'/image?v='+revision);connect();await listSnapshots();status('Connected')}catch(error){status(error.message,true)}}
async function createCanvas(){const id=$('createCanvasId').value.trim(),message=$('createCanvasMessage');if(!validCanvasId(id)){message.textContent='Use letters, numbers, underscores, or hyphens.';return}const button=$('createCanvasBtn');button.disabled=true;message.textContent='';try{const response=await fetch('/api/canvases/'+encodeURIComponent(id),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:id,width:Number($('createWidth').value),height:Number($('createHeight').value),background:$('createBackground').value})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not create canvas.');if(response.status===200)throw new Error('That canvas ID already exists. Open it below.');location.href='/canvas/'+encodeURIComponent(id)}catch(error){message.textContent=error.message}finally{button.disabled=false}}
async function openExistingCanvas(){const id=$('existingCanvasId').value.trim(),message=$('openCanvasMessage');if(!validCanvasId(id)){message.textContent='Enter a valid canvas ID.';return}const button=$('openExistingBtn');button.disabled=true;message.textContent='';try{const response=await fetch('/api/canvases/'+encodeURIComponent(id));if(response.status===404)throw new Error('That canvas does not exist.');if(!response.ok){const data=await response.json();throw new Error(data.error||'Could not open canvas.')}location.href='/canvas/'+encodeURIComponent(id)}catch(error){message.textContent=error.message}finally{button.disabled=false}}
function connect(){if(socket)socket.close();clearTimeout(reconnectTimer);const protocol=location.protocol==='https:'?'wss:':'ws:',name=$('displayName').value.trim(),connection=new WebSocket(protocol+'//'+location.host+'/api/canvases/'+encodeURIComponent(currentId)+'/connect?name='+encodeURIComponent(name));socket=connection;connection.onopen=()=>{status('Connected');clearInterval(heartbeatTimer);heartbeatTimer=setInterval(()=>{if(connection.readyState===1)connection.send(JSON.stringify({type:'heartbeat'}))},20000)};connection.onclose=()=>{if(socket!==connection)return;clearInterval(heartbeatTimer);status('Disconnected',true);if(!leaving)reconnectTimer=setTimeout(()=>{if(currentId)connect()},1500)};connection.onmessage=async event=>{const message=JSON.parse(event.data);if(message.type==='welcome'){clientId=message.clientId;if(!$('displayName').value.trim())$('displayName').value=message.name;revision=message.revision;canvas.width=message.width;canvas.height=message.height;canvasBackground=message.background;setZoom(zoom);await loadImage(message.imageUrl)}else if(message.type==='stroke'){revision=message.revision;draw(message.from,message.to,message.size,activeColor(message.tool,message.color));status('Uncommitted changes')}else if(message.type==='reset'){revision=message.revision;await loadImage(message.imageUrl);status('Commit checked out')}else if(message.type==='reset-started')status('Checking out commit…');else if(message.type==='commit-created'){listSnapshots();status('Committed')}else if(message.type==='stroke-rejected'){status('Stroke rejected; reloading',true);await loadImage('/api/canvases/'+encodeURIComponent(currentId)+'/image?v='+revision)}else if(message.type==='server-error')status('Canvas persistence is retrying…',true);else if(message.type==='presence')renderPresence(message.users);else if(message.type==='cursor')renderCursor(message)}}
function cursorColor(id){let hash=0;for(let i=0;i<id.length;i++)hash=(hash*31+id.charCodeAt(i))|0;return 'hsl('+Math.abs(hash%360)+' 85% 65%)'}
function renderCursor(cursor){if(cursor.clientId===clientId)return;let element=cursorElements.get(cursor.clientId);if(cursor.visible===false){if(element)element.remove();cursorElements.delete(cursor.clientId);return}if(!element){element=document.createElement('div');element.className='remote-cursor';element.style.setProperty('--cursor-color',cursorColor(cursor.clientId));const arrow=document.createElement('span');arrow.className='cursor-arrow';const name=document.createElement('span');name.className='cursor-name';element.append(arrow,name);$('cursorLayer').append(element);cursorElements.set(cursor.clientId,element)}element.querySelector('.cursor-name').textContent=cursor.name;element.style.left=(cursor.x/canvas.width*100)+'%';element.style.top=(cursor.y/canvas.height*100)+'%'}
function renderPresence(users){const root=$('presence');root.replaceChildren();const active=new Set(users.map(user=>user.clientId));for(const [id,element] of cursorElements){if(!active.has(id)){element.remove();cursorElements.delete(id)}}const label=document.createElement('span');label.className='presence-label';label.textContent='Viewing:';root.append(label);for(const user of users){const person=document.createElement('span');person.className='person'+(user.clientId===clientId?' me':'');person.textContent=user.name;person.title=user.name+(user.clientId===clientId?' (you)':'');root.append(person);const cursor=cursorElements.get(user.clientId);if(cursor)cursor.querySelector('.cursor-name').textContent=user.name}}
canvas.addEventListener('pointerdown',event=>{if(event.button!==0||panning)return;drawing=true;lastPoint=point(event);sentPoint=lastPoint;lastSentAt=performance.now();canvas.setPointerCapture(event.pointerId);draw(lastPoint,lastPoint,Number($('size').value),activeColor());sendStroke(lastPoint,lastPoint)});
canvas.addEventListener('pointermove',event=>{const next=point(event),now=performance.now();if(now-lastCursorAt>=32){sendCursor(next);lastCursorAt=now}if(!drawing||!lastPoint||!sentPoint)return;draw(lastPoint,next,Number($('size').value),activeColor());lastPoint=next;if(now-lastSentAt>=32){sendStroke(sentPoint,next);sentPoint=next;lastSentAt=now}});
canvas.addEventListener('pointerleave',()=>sendCursor({x:0,y:0},false));
canvas.addEventListener('pointerup',()=>{if(lastPoint&&sentPoint&&(lastPoint.x!==sentPoint.x||lastPoint.y!==sentPoint.y))sendStroke(sentPoint,lastPoint);drawing=false;lastPoint=null;sentPoint=null});canvas.addEventListener('pointercancel',()=>{drawing=false;lastPoint=null;sentPoint=null});
$('workspace').addEventListener('wheel',event=>{event.preventDefault();setZoom(zoom*(event.deltaY<0?1.15:1/1.15),event.clientX,event.clientY)},{passive:false});
window.addEventListener('keydown',event=>{if(event.code==='Space'&&!event.repeat){panning=true;$('workspace').style.cursor='grab';event.preventDefault()}});window.addEventListener('keyup',event=>{if(event.code==='Space'){panning=false;panStart=null;$('workspace').style.cursor=''}});
$('workspace').addEventListener('pointerdown',event=>{if(!panning)return;panStart={x:event.clientX,y:event.clientY,left:$('workspace').scrollLeft,top:$('workspace').scrollTop};$('workspace').setPointerCapture(event.pointerId)});$('workspace').addEventListener('pointermove',event=>{if(!panStart)return;$('workspace').scrollLeft=panStart.left-(event.clientX-panStart.x);$('workspace').scrollTop=panStart.top-(event.clientY-panStart.y)});$('workspace').addEventListener('pointerup',()=>panStart=null);
async function listSnapshots(){try{const data=await (await api('/commits')).json();const root=$('snapshots'),commits=data.commits||[];root.innerHTML='';if(!commits.length){root.innerHTML='<p class="empty">No commits yet.</p>';return}for(const commit of commits){const item=document.createElement('div');item.className='snapshot';const title=document.createElement('b');title.textContent=commit.name;const info=document.createElement('small');info.textContent=commit.author+' · revision '+commit.canvasRevision+' · '+new Date(commit.createdAt).toLocaleString();const actions=document.createElement('div');actions.className='commit-actions';const preview=document.createElement('button');preview.textContent='👁';preview.title='Preview this commit in a new read-only page';preview.onclick=()=>location.href='/canvas/'+encodeURIComponent(currentId)+'/commits/'+encodeURIComponent(commit.id);const fork=document.createElement('button');fork.textContent='⑂';fork.title='Fork a new canvas from this commit';fork.onclick=()=>forkCommit(commit.id);const reset=document.createElement('button');reset.textContent='↶';reset.title='Reset this canvas to this commit';reset.onclick=()=>restore(commit.id,commit.name);actions.append(preview,fork,reset);item.append(title,info,actions);root.append(item)}}catch(error){status(error.message,true)}}
async function saveSnapshot(){const message=prompt('Commit message');if(!message)return;$('snapshotBtn').disabled=true;status('Committing…');try{await api('/commits',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message,author:$('displayName').value.trim()})});await listSnapshots();status('Committed')}catch(error){status(error.message,true)}finally{$('snapshotBtn').disabled=false}}
async function forkCommit(commitId){const id=prompt('New canvas ID',currentId+'-fork');if(!id)return;if(!validCanvasId(id)){status('Invalid fork canvas ID',true);return}const name=prompt('New canvas name',id);if(name===null)return;status('Forking commit…');try{const data=await (await api('/commits/'+encodeURIComponent(commitId)+'/fork',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name:name||id})})).json();location.href=data.url}catch(error){status(error.message,true)}}
async function forkCanvas(){const suggested=currentId+'-fork',id=prompt('New canvas ID',suggested);if(!id)return;if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)){status('Invalid fork canvas ID',true);return}const name=prompt('New canvas name',id);if(name===null)return;$('forkBtn').disabled=true;status('Forking canvas…');try{const data=await (await api('/fork',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,name:name||id,author:$('displayName').value.trim()})})).json();location.href=data.url}catch(error){status(error.message,true);$('forkBtn').disabled=false}}
async function restore(id,name){if(!confirm('Reset to commit “'+name+'”? Current uncommitted changes will be lost.'))return;try{await api('/commits/'+encodeURIComponent(id)+'/reset',{method:'POST'});await listSnapshots()}catch(error){status(error.message,true)}}
function selectTool(next){tool=next;$('brushBtn').classList.toggle('active',tool==='brush');$('eraserBtn').classList.toggle('active',tool==='eraser');canvas.style.cursor=tool==='eraser'?'cell':'crosshair'}
function updateName(){const name=$('displayName').value.trim();localStorage.setItem('snapshot-canvas-name',name);if(socket&&socket.readyState===1)socket.send(JSON.stringify({type:'set-name',name}))}
$('displayName').value=localStorage.getItem('snapshot-canvas-name')||'';$('displayName').addEventListener('input',()=>{clearTimeout(nameTimer);nameTimer=setTimeout(updateName,250)});$('displayName').addEventListener('keydown',event=>{if(event.key==='Enter'){clearTimeout(nameTimer);updateName();event.target.blur()}});
$('openBtn').onclick=()=>$('canvasDialog').showModal();$('closeDialog').onclick=()=>$('canvasDialog').close();$('createCanvasBtn').onclick=createCanvas;$('openExistingBtn').onclick=openExistingCanvas;$('existingCanvasId').addEventListener('keydown',event=>{if(event.key==='Enter')openExistingCanvas()});$('snapshotBtn').onclick=saveSnapshot;$('forkBtn').onclick=forkCanvas;$('brushBtn').onclick=()=>selectTool('brush');$('eraserBtn').onclick=()=>selectTool('eraser');$('size').oninput=()=>$('sizeValue').textContent=$('size').value;$('zoomIn').onclick=()=>setZoom(zoom*1.25);$('zoomOut').onclick=()=>setZoom(zoom/1.25);$('zoomReset').onclick=()=>setZoom(1);
window.addEventListener('pagehide',()=>{leaving=true;clearInterval(heartbeatTimer);clearTimeout(reconnectTimer);if(socket&&socket.readyState<2)socket.close(1000,'page closed')});
currentId=decodeURIComponent(location.pathname.split('/')[2]||'');loadCurrentCanvas();
</script>
</body></html>`;
