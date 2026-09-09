# Deploying cEDH Lab (all free)

Two services: the **game server** on Render, the **web table** on Vercel.
Both deploy straight from this GitHub repo. The server runs on its
in-memory store, so no database is needed.

## 1. Game server → Render (free)

1. Go to [render.com](https://render.com) and sign up (GitHub login is easiest).
2. Dashboard → **New +** → **Blueprint** → select the `cedh-lab` repo.
   Render picks up `render.yaml` automatically (free web service, Node 22).
3. Click **Apply**. Wait for the build (~2 min).
4. Copy your service URL, e.g. `https://cedh-lab-server.onrender.com`.

Notes:
- Free tier sleeps after 15 minutes idle; the first request wakes it (~30 s).
- Auth is dev-only (`POST /api/auth/dev-login` mints tokens with no password).
  Fine for a demo with friends — do not use for anything sensitive.
- Optional: after the web app is live, set the `WEB_ORIGIN` env var on the
  Render service to your Vercel URL to lock down CORS, then redeploy.

## 2. Web table → Vercel (free)

1. Go to [vercel.com](https://vercel.com) and sign up (GitHub login).
2. **Add New… → Project** → import the `cedh-lab` repo.
3. Set **Root Directory** to `apps/web` (Edit is next to the repo name).
   Framework Preset should auto-detect **Next.js** — leave the rest default.
4. Under **Environment Variables**, add:
   - `NEXT_PUBLIC_SERVER_URL` = `https://<your-render-service>.onrender.com`
   - `NEXT_PUBLIC_WS_URL` = `wss://<your-render-service>.onrender.com`
5. **Deploy**. Your table is live at `https://<project>.vercel.app`.

## 3. Play

Open the Vercel URL → enter a name → create a pod → add AI seats or share
the link with friends. The server is authoritative; every client only ever
sees its own hidden information.

## Local dev (unchanged)

```bash
npm install
npm test                                    # 87/87
npm run dev --workspace @cedh-lab/server    # :3001
npm run dev --workspace @cedh-lab/web        # :3000
```
