import { DurableObject } from "cloudflare:workers";
import pRetry from "p-retry";

const CONTAINER_PORT = 8080;
const STARTUP_RETRIES = 5;
const STARTUP_RETRY_DELAY_MS = 500;
const INACTIVITY_TIMEOUT_MS = 60_000;
const DOCUMENT_PATH = "/index.html";
const SNAPSHOT_STORAGE_PREFIX = "snapshot:";

type StoredSnapshot = {
  snapshot: ContainerSnapshot;
  createdAt: string;
  snapshotElapsedMs: number;
};

export class Sandbox extends DurableObject<Env> {
  private get container(): Container {
    if (this.ctx.container === undefined) {
      throw new Error("Sandbox was started without a Container attachment.");
    }
    return this.ctx.container;
  }

  async startContainer() {
    const container = this.container;

    if (container.running) {
      return;
    }

    // Prefer native metadata, with a fallback while the runtime rolls out.
    const image =
      container.images?.app ?? this.env.EXPERIMENTAL_CLOUDFLARE_CONTAINER_IMAGES?.Sandbox?.app;
    if (!image) {
      throw new Error(
        "No image is available for Sandbox.app. Deploy this Worker with its Container image configuration.",
      );
    }

    const options: ContainerStartupOptions = {
      image,
      instance: "lite",
      entrypoint: ["/server", "8080"],
      enableInternet: false,
      labels: { "bug-bash": "inspect" },
      env: {
        NAME: "container-instance-demo",
        MESSAGE: "hello from a bottom-up Container Instance",
        DURABLE_OBJECT_ID: this.ctx.id.toString(),
      },
    };
    container.start(options);
  }

  async saveContainer(name: string) {
    await this.startContainer();

    const startedAt = performance.now();
    const snapshot = await this.container.snapshotContainer({ name });
    const snapshotElapsedMs = performance.now() - startedAt;
    const storedSnapshot: StoredSnapshot = {
      snapshot,
      createdAt: new Date().toISOString(),
      snapshotElapsedMs,
    };

    await this.ctx.storage.put(this.snapshotKey(name), storedSnapshot);
    return this.snapshotDetails(name, storedSnapshot);
  }

  async restoreContainer(name: string) {
    const storedSnapshot = await this.ctx.storage.get<StoredSnapshot>(this.snapshotKey(name));
    if (!storedSnapshot) {
      return null;
    }

    const container = this.container;
    if (container.running) {
      await container.destroy();
    }

    const startedAt = performance.now();
    container.start({
      containerSnapshot: storedSnapshot.snapshot,
      enableInternet: false,
    });

    // Waiting for a process to exit confirms that the restored container is ready for exec().
    const process = await container.exec(["true"]);
    const exitCode = await process.exitCode;
    if (exitCode !== 0) {
      throw new Error(`Restored container readiness check exited with code ${exitCode}.`);
    }

    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    return {
      ...this.snapshotDetails(name, storedSnapshot),
      restoreElapsedMs: performance.now() - startedAt,
    };
  }

  async listSnapshots() {
    const snapshots = await this.ctx.storage.list<StoredSnapshot>({
      prefix: SNAPSHOT_STORAGE_PREFIX,
    });

    return Array.from(snapshots.entries(), ([key, storedSnapshot]) =>
      this.snapshotDetails(key.slice(SNAPSHOT_STORAGE_PREFIX.length), storedSnapshot),
    );
  }

  private snapshotKey(name: string) {
    return `${SNAPSHOT_STORAGE_PREFIX}${name}`;
  }

  private snapshotDetails(name: string, storedSnapshot: StoredSnapshot) {
    return {
      name,
      id: storedSnapshot.snapshot.id,
      size: storedSnapshot.snapshot.size,
      createdAt: storedSnapshot.createdAt,
      snapshotElapsedMs: storedSnapshot.snapshotElapsedMs,
    };
  }

  async appendToDocument(lines: string) {
    if (!lines) {
      throw new Error("At least one line is required.");
    }

    await this.startContainer();

    const contents = lines.endsWith("\n") ? lines : `${lines}\n`;
    const process = await this.container.exec(["tee", "-a", DOCUMENT_PATH], {
      stdin: new Blob([contents]).stream(),
      stdout: "ignore",
    });
    const output = await process.output();

    if (output.exitCode !== 0) {
      throw new Error(`Could not append to ${DOCUMENT_PATH}: ${this.decode(output.stderr).trim()}`);
    }

    return contents.split("\n").length - 1;
  }

  async removeDocumentLine(lineNumber: number) {
    await this.startContainer();

    const process = await this.container.exec([
      "sh",
      "-c",
      'test -f "$1" || exit 44; line_count=$(wc -l < "$1"); [ "$2" -le "$line_count" ] || exit 45; sed -i "${2}d" "$1"',
      "remove-document-line",
      DOCUMENT_PATH,
      String(lineNumber),
    ]);
    const output = await process.output();

    if (output.exitCode === 44) {
      return { removed: false, reason: "document_not_found" as const };
    }
    if (output.exitCode === 45) {
      return { removed: false, reason: "line_not_found" as const };
    }
    if (output.exitCode !== 0) {
      throw new Error(
        `Could not remove a line from ${DOCUMENT_PATH}: ${this.decode(output.stderr).trim()}`,
      );
    }

    return { removed: true };
  }

  async readDocument() {
    await this.startContainer();

    const process = await this.container.exec(["cat", DOCUMENT_PATH]);
    const output = await process.output();

    if (output.exitCode !== 0) {
      return null;
    }

    return this.decode(output.stdout);
  }

  private decode(value: ArrayBuffer) {
    return new TextDecoder().decode(value);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const container = this.container;

    if (url.pathname === "/index.html" && request.method === "GET") {
      const document = await this.readDocument();
      if (document === null) {
        return new Response("index.html does not exist", { status: 404 });
      }
      return new Response(document, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/append" && request.method === "POST") {
      const lines = await request.text();
      if (!lines) {
        return Response.json({ error: "Request body must contain at least one line." }, { status: 400 });
      }

      const addedLines = await this.appendToDocument(lines);
      return Response.json({ addedLines, path: DOCUMENT_PATH }, { status: 201 });
    }

    if (url.pathname === "/remove" && request.method === "DELETE") {
      const lineNumber = Number(url.searchParams.get("line"));
      if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
        return Response.json(
          { error: "The line query parameter must be a positive integer." },
          { status: 400 },
        );
      }

      const result = await this.removeDocumentLine(lineNumber);
      if (!result.removed) {
        const error =
          result.reason === "document_not_found"
            ? "index.html does not exist; there is nothing to remove."
            : `Line ${lineNumber} does not exist.`;
        return Response.json({ error }, { status: 404 });
      }

      return Response.json({ removedLine: lineNumber, path: DOCUMENT_PATH });
    }

    if (url.pathname === "/_status") {
      return Response.json({ running: container.running });
    }

    if (url.pathname === "/_destroy") {
      if (container.running) {
        await container.destroy();
      }
      return Response.json({ running: container.running });
    }

    if (url.pathname === "/_inspect") {
      return Response.json(await container.inspect());
    }

    if ((url.pathname === "/_snapshot" || url.pathname === "/_take") && request.method === "POST") {
      const name = url.searchParams.get("name")?.trim();
      if (!name) {
        return Response.json({ error: "The name query parameter is required." }, { status: 400 });
      }

      return Response.json(await this.saveContainer(name), { status: 201 });
    }

    if (url.pathname === "/_restore" && request.method === "POST") {
      const name = url.searchParams.get("name")?.trim();
      if (!name) {
        return Response.json({ error: "The name query parameter is required." }, { status: 400 });
      }

      const restored = await this.restoreContainer(name);
      if (!restored) {
        return Response.json({ error: `Snapshot ${name} does not exist.` }, { status: 404 });
      }

      return Response.json(restored);
    }

    if (url.pathname === "/_snapshots" && request.method === "GET") {
      return Response.json({ snapshots: await this.listSnapshots() });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("This demo proxies GET and HEAD requests only.", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const abortController = new AbortController();
    if (!container.running) {
      await this.startContainer();
      void container.monitor().then(
        () => {
          abortController.abort(new Error("Container exited before the server became ready."));
        },
        (error) => {
          abortController.abort(error instanceof Error ? error : new Error(String(error)));
        },
      );
    }

    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    return await this.fetchContainerWhenReady(request, container, abortController.signal);
  }

  private async fetchContainerWhenReady(
    request: Request,
    container: Container,
    signal: AbortSignal,
  ): Promise<Response> {
    try {
      return await pRetry(
        async () => {
          return await container
            .getTcpPort(CONTAINER_PORT)
            .fetch(request.url.replace("https://", "http://"), request);
        },
        {
          retries: STARTUP_RETRIES,
          minTimeout: STARTUP_RETRY_DELAY_MS,
          signal,
        },
      );
    } catch (error) {
      return Response.json(
        {
          error: "container did not become ready",
          detail: error instanceof Error ? error.message : String(error),
        },
        { status: 503 },
      );
    }
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const instanceName = url.searchParams.get("instance") ?? "default";
    url.searchParams.delete("instance");

    const id = env.SANDBOX.idFromName(instanceName);
    const stub = env.SANDBOX.get(id);
    return await stub.fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
