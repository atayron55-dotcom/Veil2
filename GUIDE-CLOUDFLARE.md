# Host the rendezvous service on Cloudflare (free, no domain name)

Do this **once**. The people you talk to never have to configure anything.

## 1. Prepare

1. Create a free account at https://dash.cloudflare.com/sign-up
2. Install Node.js (LTS) from https://nodejs.org

## 2. Deploy the Worker

In a terminal (PowerShell on Windows), from the project folder:

```text
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

`wrangler login` opens a browser to authorize access. At the end of `deploy`, an address is printed:

```text
https://veil-signal.<your-subdomain>.workers.dev
```

Open it in a browser: you should read "Veil rendezvous is running. Links are permanent."

## 3. Put the address into the app

Open `desktop/default-config.json` and replace the address with yours, **using wss:// and ending with /signal**:

```json
{ "signalUrl": "wss://veil-signal.<your-subdomain>.workers.dev/signal" }
```

## 4. Build the applications

Push the project to GitHub and run the "Build Veil desktop apps" action (see README), or build locally with `npm install` then `npm run dist:win` / `dist:mac` / `dist:linux`.

The apps built this way already contain the address: just create a link and share the code.

## Cost and limits

- Cloudflare's free plan easily covers private use (the Worker only exchanges a few KB per connection).
- Your laptop does not need to stay on.
- On very restrictive networks (corporate 4G, etc.), a TURN relay may be required (see README).

## Updating the Worker (version 3.0, permanent links)

If the Worker was already deployed with an older version:

1. Cloudflare → Workers & Pages → `veil-signal` → **Edit code** (or "Quick edit").
2. Replace the whole content with `worker/src/index.js`, then **Deploy**.
   (Or, from a terminal: `cd worker` then `npx wrangler deploy`.)

Version 3.0 removes the inactivity purge: links are permanent. The stored HMAC fingerprint is never deleted because of age. Both computers should use the version 3.0 application.
