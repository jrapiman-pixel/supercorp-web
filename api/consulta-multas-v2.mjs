// Endpoint v2: consulta multas reales DT con Chrome headless propio (Vercel),
// SIN proveedor externo de pago (reemplaza a ScrapingBee). Solo datos de la
// Dirección del Trabajo — no incluye OS-10, Ley 21.659, ni mandantes.
//
// Motor: puppeteer-core + @sparticuz/chromium corriendo dentro de la función
// serverless. La DT rechaza el fetch directo sin cabecera de navegador y
// requiere ejecutar el JavaScript de la grilla (Telerik RadAjax), por eso se
// usa un navegador real. La IP de Vercel NO está bloqueada por la DT (verificado).

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

export const config = { maxDuration: 60 };

const DT_URL = 'https://ventanilla.dirtrab.cl/registroempleador/consultamultas.aspx';
const NAV_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Desactiva WebGL/gráficos: ahorra memoria en el entorno serverless
chromium.setGraphicsMode = false;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Solo cuando se pide explícitamente (?debug=1): incluye el detalle del error
  // en la respuesta para diagnosticar en preview. Nunca expone datos de multas.
  const debug = req.query && (req.query.debug === '1' || req.query.debug === 'true');

  try {
    const { rut } = req.body || {};
    if (!rut) return res.status(400).json({ error: 'RUT requerido.' });

    const rutLimpio = String(rut).replace(/\./g, '').trim().toUpperCase();
    if (!validarRut(rutLimpio)) {
      return res.status(400).json({ error: 'RUT inválido. Verifique el dígito verificador.' });
    }

    const rutDT = asegurarGuion(rutLimpio);

    const [data, utm] = await Promise.all([scrapeDT(rutDT, debug), getUTM()]);

    if (!data) {
      return res.status(502).json({ error: 'No se pudo conectar con la Dirección del Trabajo. Intente en unos minutos.' });
    }

    const { rows, totalRegistros, tieneResultados, razonSocial } = data;

    if (!tieneResultados || rows.length === 0) {
      if (!debug) await notificarConsulta({ rut: rutDT, razonSocial, totalMultas: 0, totalClp: 0 });
      return res.status(200).json({ sinMultas: true, rut: rutDT, razonSocial: razonSocial || '', totalMultas: 0, totalClp: 0, porAnio: [], avgAnual: 0, utm, ...(debug ? { _diag: data._diag } : {}) });
    }

    // Ingreso Mínimo Mensual "para fines no remuneracionales" — es el que se usa para
    // calcular multas. Vigente desde 01-05-2026 (Ley N°21.830): $356.815. Cambia ~1 vez
    // al año por ley; se puede actualizar sin tocar código con IMM_NO_REMUNERACIONAL.
    const IMM = Number(process.env.IMM_NO_REMUNERACIONAL) || 356815;

    const convertidas = rows.map(r => ({
      ...r,
      clp: r.cantidad * (r.tipo === 'UTM' ? utm : IMM),
      anio: extraerAnio(r.fecha)
    }));

    const totalClp = convertidas.reduce((s, m) => s + m.clp, 0);

    const mapAnio = {};
    convertidas.forEach(m => {
      if (m.anio !== 'N/D') {
        if (!mapAnio[m.anio]) mapAnio[m.anio] = 0;
        mapAnio[m.anio] += m.clp;
      }
    });

    const porAnio = Object.entries(mapAnio)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([year, clp]) => ({ year, clp }));

    const aniosSet = new Set(convertidas.map(m => m.anio).filter(y => y !== 'N/D'));
    const avgAnual = aniosSet.size > 0 ? totalClp / aniosSet.size : totalClp;
    const total = totalRegistros || rows.length;

    // Todas las multas capturadas, de la más reciente a la más antigua
    const multas = [...convertidas]
      .sort((a, b) => parseFechaMs(b.fecha) - parseFechaMs(a.fecha))
      .map(m => ({
        fecha: m.fecha,
        motivo: (m.enunciado || '').trim(),
        clp: Math.round(m.clp),
        cantidad: m.cantidad,
        tipo: m.tipo
      }));

    if (!debug) await notificarConsulta({ rut: rutDT, razonSocial, totalMultas: total, totalClp });

    return res.status(200).json({
      rut: rutDT,
      razonSocial: razonSocial || '',
      totalMultas: total,
      multasMuestra: rows.length,
      parcial: total > rows.length,
      totalClp,
      porAnio,
      avgAnual,
      multas,
      utm,
      consultadoEl: new Date().toISOString(),
      ...(debug ? { _diag: data._diag } : {})
    });

  } catch (err) {
    console.error('[consulta-multas-v2]', err?.stack || err?.message || err);
    const payload = { error: 'Error inesperado. Intente nuevamente.' };
    if (debug) payload.debugError = String(err?.stack || err?.message || err).slice(0, 1500);
    return res.status(500).json(payload);
  }
}

// ─── RUT ─────────────────────────────────────────────────────────────────────

function validarRut(rut) {
  const m = /^(\d{7,8})-([0-9K])$/.exec(rut);
  if (!m) return false;
  const cuerpo = m[1];
  const dvIngresado = m[2];
  let suma = 0, mult = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += parseInt(cuerpo[i]) * mult;
    mult = mult === 7 ? 2 : mult + 1;
  }
  const resto = suma % 11;
  const dvEsperado = resto === 0 ? '0' : resto === 1 ? 'K' : String(11 - resto);
  return dvEsperado === dvIngresado;
}

function asegurarGuion(rut) {
  if (rut.includes('-')) return rut;
  return rut.slice(0, -1) + '-' + rut.slice(-1);
}

function extraerAnio(fecha) {
  if (!fecha) return 'N/D';
  const m = fecha.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return m[3];
  const y = fecha.match(/(19\d{2}|20\d{2})/);
  return y ? y[1] : 'N/D';
}

function parseFechaMs(fecha) {
  const m = (fecha || '').match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : 0;
}

// ─── Aviso interno (nunca lanza) ─────────────────────────────────────────────

async function notificarConsulta({ rut, razonSocial, totalMultas, totalClp }) {
  try {
    await fetch('https://formspree.io/f/mjgjjodn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        _subject: `🔎 Consulta DT — ${razonSocial || rut}`,
        tipo: 'Consulta de multas DT (aún sin contacto)',
        rut,
        razon_social: razonSocial || 'No informada',
        total_multas: totalMultas || 0,
        total_en_multas: '$' + Math.round(totalClp || 0).toLocaleString('es-CL'),
        fecha: new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })
      }),
      signal: AbortSignal.timeout(4000)
    });
  } catch (err) {
    console.error('[consulta-multas-v2] aviso no enviado:', err?.message || err);
  }
}

// ─── UTM vigente ──────────────────────────────────────────────────────────────

async function getUTM() {
  try {
    const r = await fetch('https://mindicador.cl/api/utm', {
      headers: { 'User-Agent': 'SUPERCOR/1.0 supercor.cl' },
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    return d.serie?.[0]?.valor || 68500;
  } catch {
    return 68500; // valor de respaldo
  }
}

// ─── Chrome headless → Dirección del Trabajo ─────────────────────────────────

async function launchBrowser() {
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
}

// Extrae las filas visibles de la página actual (se ejecuta dentro del navegador)
function extraerPaginaEnNavegador() {
  const lm = document.getElementById('lblMensaje');
  let razonSocial = '';
  let totalOficial = 0;
  if (lm) {
    const t = (lm.innerText || '').replace(/\s+/g, ' ');
    const rm = t.match(/Raz[óo]n social:\s*(.+?)\s*(?:multas encontradas|fecha de consulta|$)/i);
    if (rm) razonSocial = rm[1].trim().slice(0, 120);
    const cm = t.match(/multas encontradas:\s*(\d+)/i);
    if (cm) totalOficial = parseInt(cm[1], 10);
  }
  const rows = [];
  let firstKey = '';
  document.querySelectorAll('tr').forEach((tr) => {
    const tds = tr.querySelectorAll('td');
    if (tds.length < 6) return;
    const c = Array.from(tds).map((td) => (td.innerText || '').trim());
    const tipo = c[5];
    if (tipo !== 'UTM' && tipo !== 'IMM') return;
    const key = c[1] || c[3] + '|' + c[4] + '|' + c[0];
    if (!firstKey) firstKey = key;
    rows.push({
      key,
      procedencia: c[0] || '',
      multa: c[1] || '',
      estado: c[2] || '',
      fecha: c[3] || '',
      cantidad: parseFloat((c[4] || '0').replace(/\./g, '').replace(',', '.')) || 0,
      tipo,
      enunciado: (c[6] || '').replace(/[<>]/g, ' ').slice(0, 110),
    });
  });
  const bt = document.body.innerText || '';
  const mt = bt.match(/items?\s+\d+\s+hasta\s+\d+\s+de\s+(\d+)/i);
  const totalFooter = mt ? parseInt(mt[1], 10) : 0;
  const sin = rows.length === 0 && /no\s+(existen|hay|se\s+encontraron|se\s+registran)/i.test(bt);
  const hasNext = !!document.querySelector('a[title="página siguiente"]');
  return { razonSocial, totalOficial, rows, firstKey, totalFooter, hasNext, sin };
}

async function scrapeDT(rutDT, debug = false) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(NAV_UA);
    await page.goto(DT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#tbxRut', { timeout: 15000 });
    await page.type('#tbxRut', rutDT, { delay: 15 });
    await page.click('#btnConsulta');

    // 1) Esperar a que el postback devuelva el mensaje de resultado (razón social + conteo)
    await page.waitForFunction(() => {
      const lm = document.getElementById('lblMensaje');
      return lm && (lm.innerText || '').trim().length > 0;
    }, { timeout: 25000 });

    // 2) Leer el conteo oficial. La grilla (Telerik RadGrid) puebla sus filas con una
    //    petición asíncrona posterior, así que si el conteo es > 0 (o desconocido)
    //    hay que ESPERAR a que aparezca la primera fila de datos antes de extraer.
    const info = await page.evaluate(() => {
      const lm = document.getElementById('lblMensaje');
      const t = lm ? (lm.innerText || '').replace(/\s+/g, ' ') : '';
      const cm = t.match(/multas encontradas:\s*(\d+)/i);
      return { count: cm ? parseInt(cm[1], 10) : null };
    });

    if (info.count === null || info.count > 0) {
      await page
        .waitForFunction(() => {
          const trs = document.querySelectorAll('tr');
          for (const tr of trs) {
            const tds = tr.querySelectorAll('td');
            if (tds.length >= 6) {
              const tipo = (tds[5].innerText || '').trim();
              if (tipo === 'UTM' || tipo === 'IMM') return true;
            }
          }
          return false;
        }, { timeout: 15000 })
        .catch(() => {}); // si no aparecen, el extractor devolverá 0 y se reporta como tal
    }

    const all = new Map();
    const order = [];
    let razonSocial = '';
    let totalOficial = 0;
    let totalFooter = 0;
    let sinMultas = false;
    let lastKey = '';
    const MAX_PAGES = 15; // ~150 multas; el corte real lo da el total de la DT
    let pageNum = 0;

    while (pageNum++ < MAX_PAGES) {
      const d = await page.evaluate(extraerPaginaEnNavegador);
      if (d.razonSocial && !razonSocial) razonSocial = d.razonSocial;
      if (d.totalOficial > totalOficial) totalOficial = d.totalOficial;
      if (d.totalFooter > totalFooter) totalFooter = d.totalFooter;
      if (d.sin) sinMultas = true;
      for (const r of d.rows) {
        if (!all.has(r.key)) {
          all.set(r.key, r);
          order.push(r.key);
        }
      }

      // Cortes: no hay botón siguiente / ya juntamos el total / no hubo avance
      if (!d.hasNext) break;
      if (totalFooter && order.length >= totalFooter) break;
      if (d.firstKey && d.firstKey === lastKey) break;
      lastKey = d.firstKey;

      // Avanzar de página (RadAjax). Reintenta si la DT ignora el clic por estar ocupada.
      let avanzo = false;
      for (let intento = 0; intento < 3 && !avanzo; intento++) {
        await page.click('a[title="página siguiente"]').catch(() => {});
        try {
          await page.waitForFunction(
            (prev) => {
              const trs = document.querySelectorAll('tr');
              for (const tr of trs) {
                const tds = tr.querySelectorAll('td');
                if (tds.length >= 6) {
                  const c = Array.from(tds).map((td) => (td.innerText || '').trim());
                  if (c[5] === 'UTM' || c[5] === 'IMM') {
                    const k = c[1] || c[3] + '|' + c[4] + '|' + c[0];
                    return k !== prev;
                  }
                }
              }
              return false;
            },
            { timeout: 6000 },
            lastKey
          );
          avanzo = true;
        } catch {
          // reintenta el clic
        }
      }
      if (!avanzo) break; // no se pudo avanzar: devolvemos lo acumulado
    }

    let _diag;
    if (debug) {
      // Foto del estado real que ve el navegador headless (solo para diagnóstico)
      _diag = await page.evaluate(() => {
        const lm = document.getElementById('lblMensaje');
        let trConSeis = 0;
        let filasDato = 0;
        let primeraFila = null;
        document.querySelectorAll('tr').forEach((tr) => {
          const tds = tr.querySelectorAll('td');
          if (tds.length >= 6) {
            trConSeis++;
            const c = Array.from(tds).map((td) => (td.innerText || '').trim());
            if (c[5] === 'UTM' || c[5] === 'IMM') {
              filasDato++;
              if (!primeraFila) primeraFila = c;
            }
          }
        });
        return {
          lblMensaje: lm ? (lm.innerText || '').replace(/\s+/g, ' ').slice(0, 200) : null,
          trConSeisCeldas: trConSeis,
          filasDatoVisibles: filasDato,
          primeraFila,
          hayPaginador: !!document.querySelector('a[title="página siguiente"]'),
          itemsTexto: (document.body.innerText.match(/items?\s+\d+\s+hasta\s+\d+\s+de\s+\d+/i) || [null])[0],
        };
      }).catch((e) => ({ diagError: String(e).slice(0, 200) }));
      _diag.paginasRecorridas = pageNum;
      _diag.acumuladas = order.length;
      _diag.totalOficial = totalOficial;
      _diag.totalFooter = totalFooter;
    }

    return {
      razonSocial,
      totalRegistros: totalOficial || order.length,
      rows: order.map((k) => all.get(k)),
      tieneResultados: order.length > 0 && !sinMultas,
      _diag,
    };
  } finally {
    if (browser) await browser.close();
  }
}
