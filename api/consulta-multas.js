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

    // Las 5 multas más recientes, con detalle y marca de "prevenible por SUPERCOR"
    const muestra = [...convertidas]
      .sort((a, b) => parseFechaMs(b.fecha) - parseFechaMs(a.fecha))
      .slice(0, 5)
      .map(m => ({
        fecha: m.fecha,
        motivo: (m.enunciado || '').trim(),
        clp: Math.round(m.clp),
        cantidad: m.cantidad,
        tipo: m.tipo,
        prevenible: esPrevenible(m.enunciado)
      }));

    return res.status(200).json({
      rut: rutDT,
      totalMultas: total,
      multasMuestra: rows.length,
      parcial: total > rows.length,
      totalClp,
      porAnio,
      avgAnual,
      muestra,
      utm,
      _clicks: data._clicks,
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

function parseFechaMs(fecha) {
  const m = (fecha || '').match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : 0;
}

// Palabras clave de infracciones que corresponden a lo que SUPERCOR controla en terreno
// (asistencia, documentación, EPP, reglamento, jornada, etc.) → marca "prevenible"
const CONTROLES_SUPERCOR = ['asistencia', 'registro', 'jornada', 'hora', 'contrato', 'document',
  'exhib', 'reglamento', 'proteccion', 'epp', 'elemento', 'seguridad', 'higiene', 'condicion',
  'feriado', 'descanso', 'libro', 'remunera', 'cotiza', 'previsional', 'prevencion', 'accidente',
  'capacita', 'informa', 'obligacion', 'implemento', 'sanitari'];

function esPrevenible(enunciado) {
  const n = (enunciado || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return CONTROLES_SUPERCOR.some(k => n.includes(k));
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

async function scrapeDT(rutDT, apiKey) {
  // Definimos las funciones de raspado UNA sola vez en la página (window.__scStep
  // y window.__scFin). Luego cada página solo invoca window.__scStep() — texto
  // mínimo, para no exceder el límite de largo de la URL de ScrapingBee (8 KB).
  // String.raw preserva las barras invertidas de las expresiones regulares.
  const setupScript = String.raw`(function(){
    window.__scAll={};window.__scOrder=[];window.__scTotal=0;window.__scLastSig='';window.__scClicks=0;
    window.__scStep=function(){
      try{
        var trs=document.querySelectorAll('tr');
        var firstKey='';
        for(var i=0;i<trs.length;i++){
          var tds=trs[i].querySelectorAll('td');
          if(tds.length<6)continue;
          var c=[];for(var k=0;k<tds.length;k++)c.push((tds[k].innerText||'').trim());
          var tipo=c[5];
          if(tipo!=='UTM'&&tipo!=='IMM')continue;
          var key=c[1]||(c[3]+'|'+c[4]+'|'+c[0]);
          if(!firstKey)firstKey=key;
          if(window.__scAll[key])continue;
          window.__scAll[key]={procedencia:c[0]||'',multa:c[1]||'',estado:c[2]||'',fecha:c[3]||'',cantidad:parseFloat((c[4]||'0').replace(/\./g,'').replace(',','.'))||0,tipo:tipo,enunciado:(c[6]||'').replace(/[<>]/g,' ').slice(0,110)};
          window.__scOrder.push(key);
        }
        var bt=document.body.innerText||'';
        var mt=bt.match(/items?\s+\d+\s+hasta\s+\d+\s+de\s+(\d+)/i);
        if(mt){var z=parseInt(mt[1],10);if(z>window.__scTotal)window.__scTotal=z;}
        // Avanzar por CONTENIDO: solo si la primera multa visible cambió (la página realmente avanzó)
        // y existe botón siguiente y aún faltan filas por juntar → evita re-clic en transición y bucles
        var faltan=(window.__scTotal===0)||(window.__scOrder.length<window.__scTotal);
        var nx=document.querySelector('a[title="página siguiente"]');
        if(nx&&firstKey&&firstKey!==window.__scLastSig&&faltan){
          window.__scLastSig=firstKey;
          window.__scClicks++;
          // Disparo confiable del postback RadAjax: llamar AjaxNS.AR directo (con respaldo a click)
          var href=nx.getAttribute('href')||'';
          var am=href.match(/AjaxNS\.AR\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'/);
          if(am&&window.AjaxNS&&typeof window.AjaxNS.AR==='function'){
            try{window.AjaxNS.AR(am[1],am[2],am[3],window.event||{});}catch(e){try{nx.click();}catch(e2){}}
          }else{try{nx.click();}catch(e){}}
        }
      }catch(e){}
    };
    window.__scFin=function(){
      var order=window.__scOrder||[],all=window.__scAll||{},rows=[];
      for(var i=0;i<order.length;i++)rows.push(all[order[i]]);
      var total=window.__scTotal||rows.length;
      var bt=document.body.innerText||'';
      var sin=rows.length===0&&/no\s+(existen|hay|se\s+encontraron|se\s+registran)/i.test(bt);
      var out=JSON.stringify({rows:rows,totalRegistros:total,tieneResultados:rows.length>0&&!sin,_clicks:window.__scClicks});
      var el=document.getElementById('__sc_dt')||document.createElement('div');
      el.id='__sc_dt';el.style.display='none';el.textContent=out;
      if(!el.parentNode)document.body.appendChild(el);
      return out;
    };
    window.__scStep();
  })()`;

  // Escenario: llenar RUT → consultar → recorrer páginas (con reintentos ante cargas lentas) → finalizar
  const NUM_STEPS = 10; // pasos de raspado: cubre ~6 páginas reales + amplio margen para cargas lentas
  const instr = [
    { wait_for: '#tbxRut' },
    { fill: ['#tbxRut', rutDT] },
    { click: '#btnConsulta' },
    { wait: 5000 }
  ];
  instr.push({ evaluate: setupScript }); // define funciones + raspa página 1
  for (let p = 1; p < NUM_STEPS; p++) {
    instr.push({ wait: 2600 });
    instr.push({ evaluate: 'window.__scStep&&window.__scStep()' });
  }
  instr.push({ evaluate: 'window.__scFin&&window.__scFin()' });
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
    signal: AbortSignal.timeout(52000)
  });

  if (!resp.ok) {
    const msg = await resp.text().catch(() => '');
    throw new Error(`ScrapingBee ${resp.status}: ${msg.slice(0, 200)}`);
  }

  const text = await resp.text();

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
