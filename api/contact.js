const ALLOWED_ORIGINS = new Set([
  "https://www.supercor.cl",
  "https://supercor.cl",
]);
const ALLOWED_TYPES = new Set([
  "Lead Calculadora ROI",
  "Solicitud de Demo",
  "Lead Multas DT",
  "Consulta de Contacto",
]);
const ALLOWED_FIELDS = new Set([
  "_subject",
  "tipo",
  "nombre",
  "empresa",
  "email",
  "telefono",
  "perfiles",
  "plan",
  "trabajadores",
  "gasto_mensual",
  "perdida_anual",
  "recuperable",
  "rut",
  "razon_social",
  "total_multas",
  "total_clp",
  "utm",
  "mensaje",
]);
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 6;
const rateLimitEntries = new Map();

function getAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.has(origin)) return origin;

  const isLocalDevelopment = process.env.VERCEL_ENV !== "production";
  const isLocalOrigin = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");
  const isProjectPreview = /^https:\/\/supercorp-web-[a-z0-9-]+\.vercel\.app$/.test(origin || "");
  if (isLocalDevelopment && (isLocalOrigin || isProjectPreview)) {
    return origin;
  }

  return null;
}

function getClientKey(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const ip = Array.isArray(forwardedFor) ? forwardedFor[0] : String(forwardedFor || "").split(",")[0].trim();
  return ip || "unknown";
}

function consumeRateLimit(key) {
  const now = Date.now();
  const entry = rateLimitEntries.get(key);
  if (!entry || now - entry.startedAt >= RATE_LIMIT_WINDOW_MS) {
    rateLimitEntries.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) return false;
  entry.count += 1;
  return true;
}

function cleanText(value, maxLength = 500) {
  if (typeof value === "string") return value.trim().slice(0, maxLength);
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, maxLength);
  return "";
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function buildFormspreePayload(body) {
  const tipo = cleanText(body?.tipo, 80);
  const email = cleanText(body?.email, 254);
  if (!ALLOWED_TYPES.has(tipo) || !isValidEmail(email)) return null;

  const payload = {};
  for (const field of ALLOWED_FIELDS) {
    if (field === "tipo") {
      payload[field] = tipo;
      continue;
    }
    const maxLength = field === "mensaje" ? 2000 : field === "_subject" ? 160 : 500;
    const value = cleanText(body?.[field], maxLength);
    if (value) payload[field] = value;
  }
  payload.email = email;
  return payload;
}

export default async function handler(req, res) {
  const origin = getAllowedOrigin(req);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return origin ? res.status(204).end() : res.status(403).end();
  if (req.method !== "POST") return res.status(405).end();
  if (!origin) return res.status(403).json({ error: "Origen no autorizado." });
  if (!consumeRateLimit(getClientKey(req))) {
    return res.status(429).json({ error: "Has realizado varios envíos. Espera unos minutos antes de intentarlo nuevamente." });
  }
  if (cleanText(req.body?._website, 80)) return res.status(400).json({ error: "No se pudo procesar el envío." });

  const payload = buildFormspreePayload(req.body);
  if (!payload) {
    return res.status(400).json({ error: "Revisa los datos obligatorios e inténtalo nuevamente." });
  }

  try {
    const response = await fetch("https://formspree.io/f/mjgjjodn", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error("[contact] Formspree respondió", response.status);
      return res.status(502).json({ error: "No pudimos enviar tu solicitud. Inténtalo nuevamente o contáctanos por WhatsApp." });
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[contact] Error al enviar a Formspree:", error instanceof Error ? error.message : error);
    return res.status(502).json({ error: "No pudimos enviar tu solicitud. Inténtalo nuevamente o contáctanos por WhatsApp." });
  }
}
