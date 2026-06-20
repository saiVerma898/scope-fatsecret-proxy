# Scope · FatSecret food proxy (Railway)

A tiny server that lets the Scope iOS app use the **FatSecret Platform API** for
food/barcode data. FatSecret allowlists server IPs and requires OAuth tokens to be
requested "through a proxy server," so the app can't call FatSecret directly — it calls
this proxy, which holds the client secret and runs behind one **static outbound IP**.

```
iOS app ──GET /api/food?barcode=XXXX──▶ Railway proxy ──OAuth2 + REST──▶ FatSecret
        ◀──── normalized food JSON ─────
```

## Returns
`GET /api/food?barcode=<UPC/EAN>` →
```json
{ "found": true, "name": "...", "brand": "...", "category": "...", "imageUrl": "...",
  "nutrition": { "serving": "1 bottle", "calories": 0, "sugar_g": 0, "sat_fat_g": 0,
                 "sodium_mg": 0, "protein_g": 0, "fiber_g": 0, "carbs_g": 0 } }
```
or `{ "found": false }`. The app applies Scope's nutrition + additive score.
Health check: `GET /health` → `{ "ok": true }`. The server binds Railway's `$PORT` automatically.

## Deploy (Railway)
```bash
npm i -g @railway/cli
railway login

cd fatsecret-proxy
railway init                 # create a new project
railway up                   # deploys this folder using the Dockerfile

# Secrets — YOU enter these; they never touch the repo or chat:
railway variables set FATSECRET_CLIENT_ID=xxxxxxxx
railway variables set FATSECRET_CLIENT_SECRET=xxxxxxxx
railway variables set PROXY_SHARED_KEY=$(openssl rand -hex 16)   # note the value

railway domain               # generates a public URL: https://<app>.up.railway.app
```

### Static outbound IP (the IP to whitelist)
In the Railway dashboard → your service → **Settings → Networking → Static Outbound IPs → Enable**.
Railway assigns a dedicated egress IPv4 (shown there; available on paid plans). Copy it into
FatSecret → **Whitelisted IP Addresses** (can take up to 24h to take effect).

### Test & wire up
```bash
curl "https://<app>.up.railway.app/api/food?barcode=5449000000996" -H "x-proxy-key: <key>"
```
Then in `Oasis/Secrets.plist`:
- `FOODDATA_PROXY_URL` = `https://<app>.up.railway.app/api/food`
- `FOODDATA_PROXY_KEY` = the `PROXY_SHARED_KEY` you set (if any)

Run `xcodegen generate` and rebuild.

## Security
- The FatSecret secret lives **only** as a Railway variable — never in the repo or the app.
- `PROXY_SHARED_KEY` stops randoms from spending your FatSecret quota through the public URL.
- The secret was pasted into a chat once → **Reset Client Secret** in FatSecret after this works,
  then `railway variables set FATSECRET_CLIENT_SECRET=<new>`.

The Dockerfile is portable, so any static-IP host works (Fly.io, a small VM, Cloud Run + NAT).
