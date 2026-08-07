// Endpoint de diagnóstico TEMPORAL: solo revisa si Vercel puede conectarse a la
// Dirección del Trabajo sin bloqueo, antes de invertir tiempo en el scraper propio.
// No consulta ningún RUT, no expone datos sensibles. Borrar una vez respondida la duda.

export const config = { maxDuration: 30 };

const DT_URL = 'https://ventanilla.dirtrab.cl/registroempleador/consultamultas.aspx';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const intento = async (label, headers) => {
    const inicio = Date.now();
    try {
      const r = await fetch(DT_URL, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      const texto = await r.text();
      return {
        label,
        ok: r.ok,
        status: r.status,
        ms: Date.now() - inicio,
        largoRespuesta: texto.length,
        contieneFormulario: texto.includes('tbxRut'),
        adelanto: texto.slice(0, 200),
      };
    } catch (err) {
      return {
        label,
        ok: false,
        error: err?.message || String(err),
        ms: Date.now() - inicio,
      };
    }
  };

  const resultados = await Promise.all([
    intento('sin_headers', {}),
    intento('con_user_agent_navegador', {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'es-CL,es;q=0.9',
    }),
  ]);

  return res.status(200).json({
    mensaje:
      'Si "contieneFormulario" es true en algún intento, Vercel SÍ puede llegar a la DT sin bloqueo. Si todos fallan o vienen vacíos, la IP de Vercel también está bloqueada.',
    resultados,
    consultadoEl: new Date().toISOString(),
  });
}
