// Scope · FatSecret food proxy — standalone server (Fly.io / any static-IP host).
//
// WHY: FatSecret allowlists server IPs and requires OAuth tokens to be requested
// "through a proxy server," so the iOS app can't call FatSecret directly. This server
// holds the client secret + the whitelisted IP. The app calls GET /api/food?barcode=…
//
// Env vars (set on the host, NEVER committed):
//   FATSECRET_CLIENT_ID       — your FatSecret OAuth2 Client ID
//   FATSECRET_CLIENT_SECRET   — your FatSecret OAuth2 Client Secret
//   PROXY_SHARED_KEY          — (optional) shared key the app must send as x-proxy-key
//   PORT                      — defaults to 8080

import express from "express";

const TOKEN_URL = "https://oauth.fatsecret.com/connect/token";
const REST_URL = "https://platform.fatsecret.com/rest/server.api";

const app = express();
let cachedToken = null; // { value, expiresAt }

async function getToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const id = process.env.FATSECRET_CLIENT_ID;
  const secret = process.env.FATSECRET_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Missing FATSECRET_CLIENT_ID / FATSECRET_CLIENT_SECRET");
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials&scope=basic barcode",
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  const json = await res.json();
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in || 86400) * 1000 };
  return cachedToken.value;
}

async function rest(token, params) {
  const body = new URLSearchParams({ ...params, format: "json" }).toString();
  const res = await fetch(REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`rest ${res.status}: ${await res.text()}`);
  return res.json();
}

const n = (v) => (v == null ? undefined : Number(v));

app.get("/health", (_req, res) => res.json({ ok: true }));

// Reports this server's public outbound IP — the address to whitelist in FatSecret.
app.get("/ip", async (_req, res) => {
  try {
    const r = await fetch("https://api.ipify.org?format=json");
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get("/api/food", async (req, res) => {
  // Optional shared-key gate so a public URL can't burn your FatSecret quota.
  if (process.env.PROXY_SHARED_KEY && req.get("x-proxy-key") !== process.env.PROXY_SHARED_KEY) {
    return res.status(401).json({ found: false, error: "unauthorized" });
  }
  const barcode = String(req.query.barcode || "").replace(/\D/g, "");
  if (!barcode) return res.status(400).json({ found: false, error: "barcode required" });
  const gtin13 = barcode.padStart(13, "0"); // FatSecret expects GTIN-13

  try {
    const token = await getToken();

    const idResp = await rest(token, { method: "food.find_id_for_barcode", barcode: gtin13 });
    const foodId = idResp?.food_id?.value;
    if (!foodId || foodId === "0") return res.json({ found: false });

    const foodResp = await rest(token, { method: "food.get.v4", food_id: foodId });
    const food = foodResp?.food;
    if (!food) return res.json({ found: false });

    let serving = food?.servings?.serving;
    if (Array.isArray(serving)) serving = serving[0];
    serving = serving || {};

    return res.json({
      found: true,
      name: food.food_name || "",
      brand: food.brand_name || "",
      category: food.food_type || "Food & Drink",
      imageUrl: food.food_images?.food_image?.[0]?.image_url,
      nutrition: {
        serving: serving.serving_description,
        calories: n(serving.calories),
        sugar_g: n(serving.sugar),
        sat_fat_g: n(serving.saturated_fat),
        sodium_mg: n(serving.sodium),
        protein_g: n(serving.protein),
        fiber_g: n(serving.fiber),
        carbs_g: n(serving.carbohydrate),
      },
    });
  } catch (err) {
    return res.status(502).json({ found: false, error: String(err.message || err) });
  }
});

// Name search → FatSecret foods.search, enriched with per-food nutrition (food.get.v4).
app.get("/api/search", async (req, res) => {
  if (process.env.PROXY_SHARED_KEY && req.get("x-proxy-key") !== process.env.PROXY_SHARED_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "q required" });

  try {
    const token = await getToken();
    const searchResp = await rest(token, { method: "foods.search", search_expression: q, max_results: 10 });
    let foods = searchResp?.foods?.food;
    if (!foods) return res.json({ results: [] });
    if (!Array.isArray(foods)) foods = [foods];

    const results = await Promise.all(foods.slice(0, 8).map(async (f) => {
      try {
        const detail = await rest(token, { method: "food.get.v4", food_id: f.food_id });
        const food = detail?.food;
        let serving = food?.servings?.serving;
        if (Array.isArray(serving)) serving = serving[0];
        serving = serving || {};
        return {
          name: food?.food_name || f.food_name || "",
          brand: food?.brand_name || f.brand_name || "",
          category: food?.food_type || "Food & Drink",
          imageUrl: food?.food_images?.food_image?.[0]?.image_url,
          food_id: f.food_id,
          nutrition: {
            serving: serving.serving_description,
            calories: n(serving.calories),
            sugar_g: n(serving.sugar),
            sat_fat_g: n(serving.saturated_fat),
            sodium_mg: n(serving.sodium),
            protein_g: n(serving.protein),
            fiber_g: n(serving.fiber),
            carbs_g: n(serving.carbohydrate),
          },
        };
      } catch {
        return null;
      }
    }));
    res.json({ results: results.filter(Boolean) });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, "0.0.0.0", () => console.log(`Scope FatSecret proxy on :${port}`));
