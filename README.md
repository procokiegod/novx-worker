# NOVX Worker

A standalone Java 21 + Maven compilation worker for NOVX AI.

It accepts generated Minecraft plugin source files, builds them using a trusted Maven configuration, uploads the real JAR and source ZIP to Supabase Storage, and returns their storage paths.

## Why it is separate

Your Next.js app should not compile untrusted Java projects directly. This worker is deployed as a separate Docker service.

## 1. Create the Supabase bucket

In Supabase:

1. Open **Storage**.
2. Create a private bucket named `builds`.

The worker uses the Supabase service-role key to upload files. Never expose that key in browser code.

## 2. Generate a worker secret

Generate a long random value, for example with a password manager. Use at least 32 random characters.

Set the same value in:

- Railway worker: `WORKER_SECRET`
- Next.js app: `WORKER_SECRET`

## 3. Deploy to Railway

1. Create a GitHub repository named `novx-worker`.
2. Upload this project.
3. In Railway, create a project from the GitHub repository.
4. Railway will detect the `Dockerfile`.
5. Add these variables:

```env
WORKER_SECRET=YOUR_LONG_RANDOM_SECRET
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVICE_ROLE_KEY
SUPABASE_STORAGE_BUCKET=builds
MAX_CONCURRENT_BUILDS=2
BUILD_TIMEOUT_MS=120000
MAX_FILES=120
MAX_TOTAL_SOURCE_BYTES=2000000
```

6. Generate a public Railway domain.
7. Test:

```text
https://YOUR-WORKER.up.railway.app/health
```

You should see JSON with `"ok": true`.

## 4. Configure the main Next.js app

Add:

```env
WORKER_URL=https://YOUR-WORKER.up.railway.app
WORKER_SECRET=THE_SAME_SECRET
```

Then update the worker request in `app/api/compile/route.ts`:

```ts
const res = await fetch(`${workerUrl}/compile`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.WORKER_SECRET}`,
  },
  body: JSON.stringify({
    projectId,
    files: currentFiles,
    options: project.options,
    spec,
  }),
});
```

Also replace the simulated-build branch with an error:

```ts
if (!workerUrl) {
  return NextResponse.json(
    { success: false, error: 'Compilation worker is not configured.' },
    { status: 503 }
  );
}
```

Restart the Next.js app after changing `.env`.

## 5. Security notes

This worker does not trust the AI-generated `pom.xml`. It discards generated Maven wrappers and generates its own Maven configuration.

Still treat this service as sensitive:

- Keep the worker secret private.
- Keep the Supabase service-role key private.
- Use a private Storage bucket.
- Keep concurrency and timeout limits low.
- Monitor Railway usage and logs.
- Add account-level rate limits in the main app.
- Do not expose `/compile` without bearer authentication.

## Local test

Docker:

```bash
docker build -t novx-worker .
docker run --rm -p 4000:4000 --env-file .env novx-worker
```

Health check:

```text
http://localhost:4000/health
```
