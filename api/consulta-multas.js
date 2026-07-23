// Endpoint: consulta multas reales DT via ScrapingBee
// Solo datos de la Dirección del Trabajo — no incluye OS-10, Ley 21.659, ni mandantes

export const config = { maxDuration: 30 };

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
  const m = fecha.match(/(\d{4})/);
  return m ? m[1] : 'N/D';
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
  // Script que corre en el browser de ScrapingBee para extraer las filas
  const extractScript = `(function(){
    try{
      var rows=[];
      var allTrs=document.querySelectorAll('tr');
      for(var i=0;i<allTrs.length;i++){
        var tds=allTrs[i].querySelectorAll('td');
        if(tds.length<6)continue;
        var cells=Array.prototype.map.call(tds,function(td){return td.innerText.trim();});
        var tipo=cells[5];
        if(tipo==='UTM'||tipo==='IMM'){
          rows.push({
            procedencia:cells[0]||'',
            multa:cells[1]||'',
            estado:cells[2]||'',
            fecha:cells[3]||'',
            cantidad:parseFloat((cells[4]||'0').replace(',','.'))||0,
            tipo:tipo,
            enunciado:cells[6]||''
          });
        }
      }
      var totalReg=0;
      var allEls=document.querySelectorAll('span,td,div');
      for(var j=0;j<allEls.length;j++){
        var txt=(allEls[j].innerText||'').trim();
        var m=txt.match(/Página\s*(\d+)\s*de\s*(\d+)/i)||txt.match(/(\d+)\s*de\s*(\d+)\s*páginas/i);
        if(m){totalReg=parseInt(m[2])*10;break;}
        var m2=txt.match(/(\d+)\s*(?:registros|multas|resultados)/i);
        if(m2&&parseInt(m2[1])>totalReg)totalReg=parseInt(m2[1]);
      }
      var bodyTxt=document.body.innerText||'';
      var sinRes=bodyTxt.toLowerCase().indexOf('no existen multas')>=0||
                 bodyTxt.toLowerCase().indexOf('no se encontraron')>=0||
                 bodyTxt.toLowerCase().indexOf('sin multas')>=0||
                 bodyTxt.toLowerCase().indexOf('no hay registros')>=0;
      var result=JSON.stringify({
        rows:rows,
        totalRegistros:totalReg||rows.length,
        tieneResultados:rows.length>0&&!sinRes,
        paginaActual:1
      });
      var el=document.getElementById('__sc_dt')||document.createElement('div');
      el.id='__sc_dt';el.style.display='none';el.textContent=result;
      if(!el.parentNode)document.body.appendChild(el);
      return result;
    }catch(e){
      return JSON.stringify({rows:[],totalRegistros:0,tieneResultados:false,err:e.message});
    }
  })()`;

  const scenario = {
    instructions: [
      { wait_for: '#tbxRut' },
      { fill: { selector: '#tbxRut', value: rutDT } },
      { click: '#btnConsulta' },
      { wait: 5000 },
      { evaluate: extractScript }
    ]
  };

  const params = new URLSearchParams({
    api_key: apiKey,
    url: 'https://ventanilla.dirtrab.cl/registroempleador/consultamultas.aspx',
    render_js: 'true',
    js_scenario: JSON.stringify(scenario),
    block_ads: 'true',
    block_resources: 'false'
  });

  const resp = await fetch(`https://app.scrapingbee.com/api/v1/?${params}`, {
    signal: AbortSignal.timeout(25000)
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
