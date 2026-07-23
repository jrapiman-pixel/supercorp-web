// Endpoint: consulta multas reales DT via ScrapingBee
// Solo datos de la Dirección del Trabajo — no incluye OS-10, Ley 21.659, ni mandantes

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { rut } = req.body || {};
    if (!rut) return res.status(400).json({ error: 'RUT requerido.' });

    const rutLimpio = String(rut).replace(/\./g, '').trim().toUpperCase();
    if (!validarRut(rutLimpio)) {
      return res.status(400).json({ error: 'RUT inválido. Verifique el dígito verificador.' });
    }

    const rutDT = asegurarGuion(rutLimpio);

    const apiKey = process.env.SCRAPER_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Servicio no configurado.' });

    // Modo diagnóstico temporal: devuelve HTML crudo para inspeccionar el paginador
    if ((req.body || {}).debug === 'dt-inspect-2026') {
      const raw = await scrapeDT(rutDT, apiKey, { raw: true });
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(String(raw).slice(0, 200000));
    }

    const [data, utm] = await Promise.all([
      scrapeDT(rutDT, apiKey),
      getUTM()
    ]);

    if (!data) {
      return res.status(502).json({ error: 'No se pudo conectar con la Dirección del Trabajo. Intente en unos minutos.' });
    }

    const { rows, totalRegistros, tieneResultados } = data;

    if (!tieneResultados || rows.length === 0) {
      return res.status(200).json({ sinMultas: true, rut: rutDT, totalMultas: 0, totalClp: 0, porAnio: [], avgAnual: 0, utm });
    }

    const IMM = 510114; // Ingreso Mínimo Mensual Chile 2024 — actualizar cada año por ley

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

    return res.status(200).json({
      rut: rutDT,
      totalMultas: total,
      multasMuestra: rows.length,
      parcial: total > rows.length,
      totalClp,
      porAnio,
      avgAnual,
      utm,
      consultadoEl: new Date().toISOString()
    });

  } catch (err) {
    console.error('[consulta-multas]', err?.message || err);
    return res.status(500).json({ error: 'Error inesperado. Intente nuevamente.' });
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
  // Formato DT: dd-mm-yyyy → el año es el tercer grupo
  const m = fecha.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (m) return m[3];
  const y = fecha.match(/(19\d{2}|20\d{2})/);
  return y ? y[1] : 'N/D';
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

// ─── ScrapingBee → Dirección del Trabajo ─────────────────────────────────────

async function scrapeDT(rutDT, apiKey, opts = {}) {
  // Paso de raspado: acumula filas de la página actual (dedupe por N° resolución)
  // y avanza a la siguiente página. Se repite una vez por página del RadGrid.
  // String.raw preserva las barras invertidas de las expresiones regulares.
  const stepScript = String.raw`(function(){
    try{
      if(!window.__scAll){window.__scAll={};window.__scOrder=[];window.__scTotal=0;}
      var trs=document.querySelectorAll('tr');
      for(var i=0;i<trs.length;i++){
        var tds=trs[i].querySelectorAll('td');
        if(tds.length<6)continue;
        var c=[];
        for(var k=0;k<tds.length;k++)c.push((tds[k].innerText||'').trim());
        var tipo=c[5];
        if(tipo!=='UTM'&&tipo!=='IMM')continue;
        var key=c[1]||(c[3]+'|'+c[4]+'|'+c[0]);
        if(window.__scAll[key])continue;
        window.__scAll[key]={
          procedencia:c[0]||'',multa:c[1]||'',estado:c[2]||'',fecha:c[3]||'',
          cantidad:parseFloat((c[4]||'0').replace(/\./g,'').replace(',','.'))||0,tipo:tipo
        };
        window.__scOrder.push(key);
      }
      var bt=document.body.innerText||'';
      var mt=bt.match(/items?\s+\d+\s+hasta\s+\d+\s+de\s+(\d+)/i);
      if(mt){var z=parseInt(mt[1],10);if(z>window.__scTotal)window.__scTotal=z;}
      var nx=document.querySelector('a[title="página siguiente"]');
      if(nx)nx.click();
      return 'ok:'+window.__scOrder.length+'/'+window.__scTotal;
    }catch(e){return 'err:'+e.message;}
  })()`;

  const finalizeScript = String.raw`(function(){
    try{
      var all=window.__scAll||{};var order=window.__scOrder||[];
      var rows=[];for(var i=0;i<order.length;i++)rows.push(all[order[i]]);
      var total=window.__scTotal||rows.length;
      var bt=document.body.innerText||'';
      var sin=rows.length===0&&/no\s+(existen|hay|se\s+encontraron|se\s+registran)/i.test(bt);
      var out=JSON.stringify({rows:rows,totalRegistros:total,tieneResultados:rows.length>0&&!sin});
      var el=document.getElementById('__sc_dt')||document.createElement('div');
      el.id='__sc_dt';el.style.display='none';el.textContent=out;
      if(!el.parentNode)document.body.appendChild(el);
      return out;
    }catch(e){return JSON.stringify({rows:[],totalRegistros:0,tieneResultados:false,err:e.message});}
  })()`;

  // Escenario: llenar RUT → consultar → recorrer hasta MAX_PAGES páginas → finalizar
  const MAX_PAGES = 6; // hasta ~60 multas; suficiente para casi todas las empresas
  const instr = [
    { wait_for: '#tbxRut' },
    { fill: ['#tbxRut', rutDT] },
    { click: '#btnConsulta' },
    { wait: 4500 }
  ];
  if (opts.raw) {
    // Modo diagnóstico: solo la primera página, sin recorrer
  } else {
    for (let p = 0; p < MAX_PAGES; p++) {
      instr.push({ evaluate: stepScript });
      if (p < MAX_PAGES - 1) instr.push({ wait: 2200 });
    }
    instr.push({ evaluate: finalizeScript });
  }
  const scenario = { instructions: instr };

  const params = new URLSearchParams({
    api_key: apiKey,
    url: 'https://ventanilla.dirtrab.cl/registroempleador/consultamultas.aspx',
    render_js: 'true',
    js_scenario: JSON.stringify(scenario),
    block_ads: 'true',
    block_resources: 'false'
  });

  const resp = await fetch(`https://app.scrapingbee.com/api/v1/?${params}`, {
    signal: AbortSignal.timeout(48000)
  });

  if (!resp.ok) {
    const msg = await resp.text().catch(() => '');
    throw new Error(`ScrapingBee ${resp.status}: ${msg.slice(0, 200)}`);
  }

  const text = await resp.text();

  if (opts.raw) return text;

  // ScrapingBee puede devolver: (a) el resultado del evaluate como texto, o (b) el HTML completo
  try {
    const parsed = JSON.parse(text);
    // Si parseó bien y tiene "rows", es el resultado directo del evaluate
    if (parsed && typeof parsed.tieneResultados !== 'undefined') return parsed;
  } catch { /* no era JSON directo */ }

  // Buscar el div __sc_dt en el HTML devuelto
  const divMatch = text.match(/id="__sc_dt"[^>]*>([^<]+)<\/div>/);
  if (divMatch) {
    try { return JSON.parse(decodeHTMLEntities(divMatch[1])); } catch { /* continuar */ }
  }

  // Último intento: buscar el JSON inline en el texto
  const jsonMatch = text.match(/(\{"rows":\[.*?\],"totalRegistros":\d+)/s);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1] + '}'); } catch { /* continuar */ }
  }

  return null;
}

function decodeHTMLEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
