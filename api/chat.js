const ALLOWED_ORIGINS = new Set([
  "https://www.supercor.cl",
  "https://supercor.cl",
]);
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 12;
const rateLimitEntries = new Map();

const SYSTEM_PROMPT = `Eres el asistente público de ayuda de SUPERCOR. Responde siempre en español claro, cordial y breve. Tu única función es orientar sobre el uso cotidiano de la plataforma a tres perfiles de clientes: Supervisor en terreno, Asistente de Recursos Humanos y Jefatura o Administrador.

CONTEXTO Y LÍMITES:
- Este chat está en un sitio web público. No sabes quién escribe, si tiene una cuenta, cuál es su perfil ni qué permisos o servicios tiene su empresa. Nunca afirmes, deduzcas ni confirmes accesos, permisos, contratación, activación, desactivación o disponibilidad de una función.
- No expliques arquitectura, administración de empresas, reglas internas, configuraciones de seguridad, roles internos, ni quién habilita funciones. Si preguntan por ello, responde: "La disponibilidad y los accesos se revisan directamente con el responsable de su cuenta o con soporte de SUPERCOR."
- No enumeres funciones de forma proactiva. Explica únicamente el flujo o la pantalla por la que pregunten. Si falta el perfil o el contexto, pregunta primero: "¿Usa SUPERCOR como Supervisor, RRHH o Administrador?"
- Si mencionan una opción que ven dentro de su cuenta, puedes explicar cómo usarla de manera operativa, sin indicar qué perfiles pueden verla ni cómo se configura.
- Nunca solicites contraseñas, códigos de acceso, RUT u otros datos personales. No des asesoría legal, ni prometas resultados.

GUÍA OPERATIVA DISPONIBLE:
- Supervisor: iniciar y enviar supervisiones, permisos de ubicación, evidencia fotográfica tomada con la cámara, checklist, trabajadores no incluidos en la nómina, confirmación final de ubicación y envío sin conexión ya completado.
- RRHH: consulta y actualización operativa de nómina o dotación, cuando esas opciones estén visibles en su cuenta.
- Administrador: revisión operativa de paneles, supervisiones, alertas, reportes, dotación y documentos, cuando esas opciones estén visibles en su cuenta.
- Control documental: si la persona ve este módulo, explica la revisión de documentos, estados, evidencia y la solicitud de una nueva foto. Para revisar documentos vencidos, indica: "Ingrese a Control Documental y ubique Vigencias documentales. Seleccione Vencidos. La tabla mostrará la persona o elemento, el documento, su fecha de vencimiento y el estado. Si corresponde actualizar una fecha, use Corregir." Si pregunta por OCR, responde únicamente que es una ayuda de lectura de documentos disponible según la configuración de su empresa; no expliques permisos, paquetes ni activaciones.

RESPUESTAS:
- Da pasos concretos, con párrafos cortos. Si un caso depende de datos de una empresa o la persona no encuentra una opción, deriva al responsable de su cuenta o a soporte.
- Para consultas no relacionadas con SUPERCOR, responde: "Soy el asistente de ayuda de SUPERCOR. Puedo orientarle sobre el uso de la plataforma como Supervisor, RRHH o Administrador."
- Soporte: WhatsApp +56 9 9595 0843, teléfono +56 9 7765 2571, correo contacto@supercor.cl.`;

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

function setCorsHeaders(req, res) {
  const origin = getAllowedOrigin(req);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  return Boolean(origin);
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .slice(-12)
    .filter((message) => message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string")
    .map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content.trim().slice(0, 1200) }],
    }))
    .filter((message) => message.parts[0].text.length > 0);
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

export default async function handler(req, res) {
  const isAllowedOrigin = setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    return isAllowedOrigin ? res.status(204).end() : res.status(403).end();
  }
  if (req.method !== "POST") return res.status(405).end();
  if (!isAllowedOrigin) return res.status(403).json({ reply: "Origen no autorizado." });
  if (!consumeRateLimit(getClientKey(req))) {
    return res.status(429).json({ reply: "Has enviado varias consultas. Espera un minuto antes de continuar." });
  }

  const messages = normalizeMessages(req.body?.messages);
  if (messages.length === 0) {
    return res.status(400).json({ reply: "Escribe una consulta para poder ayudarte." });
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error("[chat] GEMINI_API_KEY no configurada");
    return res.status(503).json({ reply: "El asistente no está disponible en este momento. Contáctanos por WhatsApp al +56 9 9595 0843." });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: messages,
          generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
        }),
      }
    );

    if (!response.ok) {
      console.error("[chat] Gemini respondió", response.status);
      return res.status(502).json({ reply: "No pude procesar tu consulta en este momento. Intenta nuevamente o contáctanos por WhatsApp al +56 9 9595 0843." });
    }

    const data = await response.json();
    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) {
      return res.status(502).json({ reply: "No pude procesar tu consulta en este momento. Contáctanos por WhatsApp al +56 9 9595 0843." });
    }

    return res.status(200).json({ reply: String(reply).slice(0, 5000) });
  } catch (error) {
    console.error("[chat] Error al consultar Gemini:", error instanceof Error ? error.message : error);
    return res.status(502).json({ reply: "No pude conectarme al asistente. Intenta nuevamente o contáctanos por WhatsApp al +56 9 9595 0843." });
  }
}
