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

Use the Worker URL printed by Wrangler:

```bash
curl "https://<worker-url>/?instance=first"
curl "https://<worker-url>/_status?instance=first"
curl "https://<worker-url>/_destroy?instance=first"
```

Each `instance` value selects a different Durable Object and container.

## What changed

- The top-level `containers[]` entry attaches a Durable Object-managed application to the `Sandbox` namespace.
- `scheduling_policy: "durable_object"` makes each Durable Object own its container lifecycle.
- The named `images.app` configuration tells Wrangler to build, push, and prepare the image.
- The Worker prefers `ctx.container.images.app` and falls back to Wrangler's temporary `env.EXPERIMENTAL_CLOUDFLARE_CONTAINER_IMAGES.Sandbox.app` binding while native image metadata rolls out. If neither supplies an image, it reports a configuration error before starting the container.
