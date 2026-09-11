# Durable Object-managed Containers demo

A minimal Worker whose Durable Objects start namespace-backed containers on demand.

## Prerequisites

- Node.js, pnpm, and Docker
- A Cloudflare account with Workers, Containers, and the new runtime enabled.

## Deploy

Install dependencies:

```bash
pnpm install
```

Use Wrangler's latest `main` preview build.

Authenticate, then deploy with the main preview build:

```bash
npx --yes https://pkg.pr.new/wrangler@main whoami
npx --yes https://pkg.pr.new/wrangler@main deploy
```

Wrangler builds and pushes the image, prepares it to run on Cloudflare, uploads the Worker, and creates the namespace-backed application.

## Try it

Set the Worker URL printed by Wrangler, including the `https://` scheme:

```bash
export BASE="https://your-worker.your-subdomain.workers.dev"
```

Then call the Worker:

```bash
curl "$BASE/?instance=first"
curl "$BASE/_status?instance=first"
curl "$BASE/_destroy?instance=first"
```

Each `instance` value selects a different Durable Object and container.

Append one or more HTML lines to `/index.html` (the file is created on the first write):

```bash
curl -X POST "$BASE/append?instance=first" \
  --data-binary $'<h1>Hello</h1>\n<p>From the container</p>'
```

View the document in a browser:

```bash
open "$BASE/index.html?instance=first"
```

Remove a line by its one-based line number:

```bash
curl -X DELETE "$BASE/remove?instance=first&line=2"
```

Removing a line returns `404` when `index.html` or the requested line does not exist.

For a Worker protected by Cloudflare Access, use `cloudflared access curl` and put the URL
before all curl arguments:

```bash
cloudflared access curl "$BASE/append?instance=first" \
  -X POST \
  --data-binary $'<h1>Hello</h1>\n<p>From the container</p>'
```

A regular `workers.dev` URL that is not protected by Access only needs plain `curl`.

## Snapshots

Create a named snapshot of the running container. The response includes the immutable snapshot ID,
size, and elapsed snapshot time:

```bash
curl -X POST "$BASE/_snapshot?instance=first&name=S1"
```

Modify `index.html` and create additional generations:

```bash
curl -X POST "$BASE/append?instance=first" --data-binary $'<p>Generation 2</p>'
curl -X POST "$BASE/_snapshot?instance=first&name=S2"

curl -X POST "$BASE/append?instance=first" --data-binary $'<p>Generation 3</p>'
curl -X POST "$BASE/_snapshot?instance=first&name=S3"
```

List the snapshots stored for this instance:

```bash
curl "$BASE/_snapshots?instance=first"
```

Restore any generation independently. Restoring destroys the currently running container first;
the response includes the elapsed restore time:

```bash
curl -X POST "$BASE/_restore?instance=first&name=S1"
open "$BASE/index.html?instance=first"

curl -X POST "$BASE/_restore?instance=first&name=S3"
open "$BASE/index.html?instance=first"
```

A missing snapshot returns `404`. Snapshot handles are stored in the Durable Object, snapshots are
immutable, and `image` is not passed when restoring because `image` and `containerSnapshot` are
mutually exclusive. Snapshots currently have an implicit 30-day retention period refreshed by each
restore.

## What changed

- The top-level `containers[]` entry attaches a Durable Object-managed application to the `Sandbox` namespace.
- `scheduling_policy: "durable_object"` makes each Durable Object own its container lifecycle.
- The named `images.app` configuration tells Wrangler to build, push, and prepare the image.
- The Worker prefers `ctx.container.images.app` and falls back to Wrangler's temporary `env.EXPERIMENTAL_CLOUDFLARE_CONTAINER_IMAGES.Sandbox.app` binding while native image metadata rolls out. If neither supplies an image, it reports a configuration error before starting the container.
