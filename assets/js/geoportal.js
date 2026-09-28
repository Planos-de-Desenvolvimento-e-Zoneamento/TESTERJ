/* =====================================================================
   Geoportal do Porto do Rio de Janeiro — aplicação
   Leaflet 1.9 + proj4js. Os GeoJSON de origem estão em CRS84, EPSG:3857
   ou EPSG:31983 e são reprojetados para WGS 84 ao serem carregados.
   ===================================================================== */
(function () {
  'use strict';

  const CFG = window.GEOPORTAL_CONFIG;

  /* ------------------------------------------------------------------
     Utilidades
     ------------------------------------------------------------------ */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const NF = (min, max) => new Intl.NumberFormat('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: max });
  const NF0 = NF(0, 0), NF1 = NF(0, 1), NF2 = NF(0, 2), NF5 = NF(5, 5), NF6 = NF(6, 6);

  const chave = (s) => String(s).normalize('NFC').trim();
  const semAcento = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icone = (id, cls = 'i') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

  const armazenamento = {
    ler(k, padrao) {
      try { const v = localStorage.getItem('geoportal-rj:' + k); return v === null ? padrao : JSON.parse(v); }
      catch (e) { return padrao; }
    },
    gravar(k, v) {
      try { localStorage.setItem('geoportal-rj:' + k, JSON.stringify(v)); } catch (e) { /* armazenamento indisponível */ }
    }
  };

  proj4.defs('EPSG:31983', '+proj=utm +zone=23 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');
  proj4.defs('EPSG:31984', '+proj=utm +zone=24 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs');
  proj4.defs('EPSG:4674', '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs +type=crs');
  const paraUTM = proj4('EPSG:4326', 'EPSG:31983');

  const PALETA = ['#2563eb', '#d97706', '#7c3aed', '#059669', '#db2777', '#0891b2', '#65a30d', '#dc2626', '#4f46e5', '#ca8a04', '#0d9488', '#9333ea'];

  const PANES = {
    'pn-limites': 405,
    'pn-ambiental': 415,
    'pn-aquaviario': 420,
    'pn-zoneamento': 430,
    'pn-instalacoes': 440,
    'pn-acessos': 450,
    'pn-poligonal': 455,
    'pn-destaque': 470,
    'pn-medicao': 480
  };

  const CAMPOS_ROTULO = ['Nome', 'NM_MUN', 'NM_UF', 'Arrendatário', 'Identificação', 'Trecho', 'Tipo da Instalação',
    'Identificador do Berço', 'Número de Identificação', 'Legenda', 'Linha', 'Tipo de Área', 'Id', 'id'];

  /* ------------------------------------------------------------------
     Estado
     ------------------------------------------------------------------ */
  const estado = {
    horizonte: armazenamento.ler('horizonte', CFG.horizontes[0].id),
    base: armazenamento.ler('base', CFG.baseInicial || CFG.basemaps[0].id),
    brutos: new Map(),
    preparados: new Map(),
    camadas: [],
    porId: new Map(),
    gruposFechados: new Set(),
    expandidas: new Set(),
    medicao: null,
    tabela: null,
    destaque: null,
    resultadosInfo: [],
    extensaoInicial: null,
    iniciado: false,
    // Filtros do painel estatístico (aplicados ao mapa, tabelas e gráficos)
    filtros: { perfil: new Set(), tipo: new Set() },
    ligadasPeloFiltro: new Set(), // camadas ligadas automaticamente ao aplicar um filtro
    estAberto: false
  };
  const EST = CFG.estatisticas || {};
  if (!CFG.horizontes.some((h) => h.id === estado.horizonte)) estado.horizonte = CFG.horizontes[0].id;
  if (!CFG.basemaps.some((b) => b.id === estado.base)) estado.base = CFG.basemaps[0].id;
  const horizonteAtual = () => CFG.horizontes.find((h) => h.id === estado.horizonte);

  let uid = 0;
  const textoBusca = new WeakMap();

  /* ------------------------------------------------------------------
     Preparação dos dados (reprojeção, limpeza de atributos, bbox)
     ------------------------------------------------------------------ */
  function primeiraCoordenada(gj) {
    const f = (gj.features || []).find((x) => x && x.geometry && x.geometry.coordinates);
    if (!f) return null;
    let c = f.geometry.coordinates;
    while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
    return Array.isArray(c) && typeof c[0] === 'number' ? c : null;
  }

  function detectarCRS(gj) {
    const nome = String((gj.crs && gj.crs.properties && gj.crs.properties.name) || '').toUpperCase();
    const amostra = primeiraCoordenada(gj);
    if (!amostra) return null;
    if (Math.abs(amostra[0]) <= 180 && Math.abs(amostra[1]) <= 90) return null; // já geográfico
    const m = nome.match(/EPSG:{1,2}(\d+)/);
    if (m && proj4.defs('EPSG:' + m[1])) return 'EPSG:' + m[1];
    return amostra[1] > 1e6 ? 'EPSG:31983' : 'EPSG:3857';
  }

  function bboxDe(coords) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    (function vis(c) {
      if (typeof c[0] === 'number') {
        if (c[0] < b[0]) b[0] = c[0];
        if (c[1] < b[1]) b[1] = c[1];
        if (c[0] > b[2]) b[2] = c[0];
        if (c[1] > b[3]) b[3] = c[1];
      } else c.forEach(vis);
    })(coords);
    return b;
  }

  function preparar(gj) {
    const crs = detectarCRS(gj);
    const conv = crs ? proj4(crs, 'EPSG:4326') : null;
    const r = (v) => Math.round(v * 1e8) / 1e8;
    const tc = conv ? (c) => { const p = conv.forward([c[0], c[1]]); return [r(p[0]), r(p[1])]; } : (c) => [c[0], c[1]];
    const percorrer = (c) => (typeof c[0] === 'number' ? tc(c) : c.map(percorrer));
    const features = [];
    (gj.features || []).forEach((f) => {
      if (!f || !f.geometry || !f.geometry.coordinates || !f.geometry.coordinates.length) return;
      const props = {};
      Object.keys(f.properties || {}).forEach((k) => { props[k.trim()] = f.properties[k]; });
      const geometry = { type: f.geometry.type, coordinates: percorrer(f.geometry.coordinates) };
      const feat = { type: 'Feature', properties: props, geometry };
      Object.defineProperty(feat, '_bbox', { value: bboxDe(geometry.coordinates) });
      Object.defineProperty(feat, '_uid', { value: ++uid });
      features.push(feat);
    });
    return { type: 'FeatureCollection', features, crsOrigem: crs || 'EPSG:4326 (CRS84)' };
  }

  function registrarBruto(nome, gj) {
    if (!gj || typeof gj !== 'object') return;
    const k = chave(nome);
    estado.brutos.set(k, gj);
    estado.preparados.delete(k);
  }

  function arquivoDe(rt, hId) {
    if (!rt.cfg.horizonte) return rt.cfg.arquivo;
    const h = CFG.horizontes.find((x) => x.id === (hId || estado.horizonte));
    return `${rt.cfg.arquivo} - ${h.sufixo}`;
  }

  function dadosDe(rt, hId) {
    const k = chave(arquivoDe(rt, hId));
    if (estado.preparados.has(k)) return estado.preparados.get(k);
    const bruto = estado.brutos.get(k);
    if (!bruto) return null;
    let p = null;
    try { p = preparar(bruto); } catch (e) { console.error('Falha ao preparar a camada', k, e); }
    estado.preparados.set(k, p);
    estado.brutos.delete(k);
    return p;
  }

  /* ------------------------------------------------------------------
     Carregamento dos dados
     ------------------------------------------------------------------ */
  function arquivosEsperados() {
    const nomes = new Set();
    CFG.camadas.forEach((c) => {
      if (c.horizonte) CFG.horizontes.forEach((h) => nomes.add(`${c.arquivo} - ${h.sufixo}`));
      else nomes.add(c.arquivo);
    });
    return [...nomes];
  }

  function progresso(feito, total, txt) {
    $('#progressoBarra').style.width = `${Math.round((feito / Math.max(total, 1)) * 100)}%`;
    $('#progressoTxt').textContent = txt || `Carregando camadas (${feito} de ${total})…`;
  }

  async function carregarDados() {
    const pacote = window.GEOPORTAL_DADOS;
    if (pacote && Object.keys(pacote).length) {
      Object.keys(pacote).forEach((k) => registrarBruto(k, pacote[k]));
      progresso(1, 1, `${Object.keys(pacote).length} arquivos carregados`);
      return true;
    }
    if (/^https?:$/.test(location.protocol)) {
      const nomes = arquivosEsperados();
      let feitos = 0, ok = 0;
      await Promise.all(nomes.map(async (n) => {
        try {
          const resp = await fetch(encodeURIComponent(n) + '.geojson');
          if (resp.ok) { registrarBruto(n, await resp.json()); ok++; }
        } catch (e) { /* arquivo ausente */ }
        progresso(++feitos, nomes.length);
      }));
      return ok > 0;
    }
    return false;
  }

  async function carregarDeArquivos(lista) {
    const arquivos = [...lista].filter((f) => /\.(geo)?json$/i.test(f.name));
    if (!arquivos.length) { aviso('Nenhum arquivo .geojson encontrado na seleção.'); return; }
    $('#semDados').hidden = true;
    $('#progressoBox').hidden = false;
    let feitos = 0;
    for (const f of arquivos) {
      try { registrarBruto(f.name.replace(/\.(geo)?json$/i, ''), JSON.parse(await f.text())); }
      catch (e) { console.warn('Arquivo inválido:', f.name, e); }
      progresso(++feitos, arquivos.length);
    }
    iniciarAplicacao();
  }

  /* ------------------------------------------------------------------
     Mapa
     ------------------------------------------------------------------ */
  const map = L.map('mapa', {
    zoomControl: false,
    minZoom: 4,
    maxZoom: 20,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 100,
    worldCopyJump: true,
    fadeAnimation: false // evita blocos semitransparentes (véu branco) ao imprimir
  }).setView([-22.885, -43.2], 13);

  map.attributionControl.setPrefix('<a href="https://leafletjs.com" title="Biblioteca Leaflet">Leaflet</a>');
  L.control.scale({ position: 'bottomright', imperial: false, maxWidth: 140 }).addTo(map);
  Object.entries(PANES).forEach(([nome, z]) => { map.createPane(nome).style.zIndex = z; });
  map.getPane('pn-destaque').style.pointerEvents = 'none';

  const camadaDestaque = L.featureGroup().addTo(map);
  const camadaMedicoes = L.featureGroup().addTo(map);
  let camadaLocal = null;

  /* ------------------------------------------------------------------
     Mapas de fundo
     ------------------------------------------------------------------ */
  const basesLeaflet = {};
  CFG.basemaps.forEach((b) => {
    const opc = { maxZoom: 20, maxNativeZoom: b.maxNativo || 19, attribution: b.atribuicao };
    if (b.subdominios) opc.subdomains = b.subdominios;
    const camadas = [L.tileLayer(b.url, opc)];
    if (b.rotulos) camadas.push(L.tileLayer(b.rotulos, { maxZoom: 20, maxNativeZoom: b.maxNativo || 19, opacity: 0.9 }));
    basesLeaflet[b.id] = L.layerGroup(camadas);
  });

  function trocarBase(id) {
    Object.values(basesLeaflet).forEach((l) => map.removeLayer(l));
    basesLeaflet[id].addTo(map);
    estado.base = id;
    armazenamento.gravar('base', id);
    const b = CFG.basemaps.find((x) => x.id === id);
    $('#baseAtualImg').src = b.miniatura;
    $('#baseAtualNome').textContent = b.nome;
    $$('.base-card').forEach((el) => el.setAttribute('aria-checked', String(el.dataset.base === id)));
    document.body.dataset.base = id;
  }

  function montarSeletorBase() {
    $('#baseOpcoes').innerHTML = CFG.basemaps.map((b) => `
      <button type="button" class="base-card" role="radio" aria-checked="false" data-base="${b.id}" title="${esc(b.nome)}">
        <span class="thumb"><img src="${b.miniatura}" alt="" loading="lazy"></span>
        <span class="nome">${esc(b.nome)}</span>
      </button>`).join('');
    const seletor = $('#seletorBase');
    const alternar = (abrir) => {
      seletor.classList.toggle('aberto', abrir);
      $('#btnBase').setAttribute('aria-expanded', String(abrir));
    };
    $('#btnBase').addEventListener('click', () => alternar(!seletor.classList.contains('aberto')));
    $('#baseOpcoes').addEventListener('click', (e) => {
      const card = e.target.closest('.base-card');
      if (!card) return;
      trocarBase(card.dataset.base);
      alternar(false);
      aviso(`Mapa de fundo: ${CFG.basemaps.find((b) => b.id === card.dataset.base).nome}`);
    });
    document.addEventListener('click', (e) => { if (!seletor.contains(e.target)) alternar(false); });
    L.DomEvent.disableClickPropagation(seletor);
    L.DomEvent.disableScrollPropagation(seletor);
  }

  /* ------------------------------------------------------------------
     Estilos e símbolos
     ------------------------------------------------------------------ */
  function escurecer(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - f)));
    return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  const valorCategoria = (f, campo) => {
    const v = f.properties[campo];
    if (campo === EST.campoPerfil) return normPerfil(v); // unifica grafias do perfil de carga
    return v === null || v === undefined || String(v).trim() === '' ? 'Não informado' : String(v).trim();
  };

  // Polígonos com preenchimento: linha da mesma cor do preenchimento, mais espessa e menos transparente
  const ESPESSURA_MIN_POLIGONO = 2.5;
  const OPACIDADE_PREENCHIMENTO = 0.45; // preenchimento sólido padrão dos polígonos
  const OPACIDADE_HACHURA = 0.75;       // preenchimento hachurado (as linhas da hachura são finas)
  const poligonoPreenchido = (rt) => rt.cfg.tipo !== 'linha' && !rt.cfg.estilo.semPreenchimento &&
    (rt.cfg.estilo.padrao || rt.cfg.estilo.opacidadePreenchimento !== 0);

  function calcularCategorias(rt) {
    const cat = rt.cfg.categorias;
    if (!cat) return;
    const valores = new Set();
    const hs = rt.cfg.horizonte ? CFG.horizontes.map((h) => h.id) : [estado.horizonte];
    hs.forEach((h) => { const d = dadosDe(rt, h); if (d) d.features.forEach((f) => valores.add(valorCategoria(f, cat.campo))); });
    const definidos = Object.keys(cat.cores || {});
    const restantes = [...valores].filter((v) => !definidos.includes(v)).sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const mapa = new Map();
    definidos.filter((v) => valores.has(v)).forEach((v) => mapa.set(v, cat.cores[v]));
    const usadas = new Set(mapa.values());
    const livres = PALETA.filter((c) => !usadas.has(c));
    restantes.forEach((v, i) => mapa.set(v, livres[i % livres.length] || PALETA[i % PALETA.length]));
    rt.cats = mapa;
  }

  function coresFeicao(rt, f) {
    const e = rt.cfg.estilo;
    if (rt.cats) {
      const c = rt.cats.get(valorCategoria(f, rt.cfg.categorias.campo)) || '#94a3b8';
      return { traco: c, preench: c };
    }
    const preench = e.preenchimento || e.cor;
    if (poligonoPreenchido(rt)) return { traco: e.padrao ? e.padrao.cor : preench, preench };
    return { traco: e.cor, preench };
  }

  function estiloFeicao(rt, f, realce) {
    const e = rt.cfg.estilo;
    const op = rt.opacidade;
    const { traco, preench } = coresFeicao(rt, f);
    const extra = realce ? 1.5 : 0;
    if (rt.cfg.tipo === 'linha') {
      return {
        color: traco, weight: (e.espessura || 2) + extra, opacity: op,
        dashArray: e.tracejado || null, lineCap: e.lineCap || 'round', lineJoin: 'round'
      };
    }
    const semPreench = !!e.semPreenchimento;
    const preenchido = poligonoPreenchido(rt);
    const fo = e.padrao ? OPACIDADE_HACHURA : (preenchido ? OPACIDADE_PREENCHIMENTO : (e.opacidadePreenchimento ?? 0));
    const esp = preenchido ? Math.max(e.espessura ?? 1.5, ESPESSURA_MIN_POLIGONO) : (e.espessura ?? 1.5);
    return {
      // Em polígonos o controle de opacidade atua só no preenchimento: o contorno fica sempre opaco
      color: traco, weight: esp + extra, opacity: 1,
      dashArray: e.tracejado || null, lineJoin: 'round',
      fill: !semPreench,
      fillColor: e.padrao ? `url(#pad-${rt.cfg.id})` : preench,
      fillOpacity: Math.min(1, fo + (realce && !e.padrao && preenchido ? 0.15 : 0)) * op
    };
  }

  function estiloContorno(rt) {
    const c = rt.cfg.estilo.contorno;
    const opacidade = rt.cfg.tipo === 'linha' ? rt.opacidade * 0.95 : 0.95;
    return { color: c.cor, weight: c.espessura, opacity: opacidade, fill: false, lineCap: 'round', lineJoin: 'round' };
  }

  function criarPadroes() {
    const defs = $('#gp-defs defs');
    estado.camadas.forEach((rt) => {
      const p = rt.cfg.estilo.padrao;
      if (!p || document.getElementById(`pad-${rt.cfg.id}`)) return;
      const s = p.espaco || 8;
      defs.insertAdjacentHTML('beforeend',
        `<pattern id="pad-${rt.cfg.id}" patternUnits="userSpaceOnUse" width="${s}" height="${s}" patternTransform="rotate(${p.angulo ?? 45})">` +
        `<rect width="${s}" height="${s}" fill="${p.fundo || '#ffffff'}" fill-opacity="${p.opacidadeFundo ?? 0}"/>` +
        `<line x1="0" y1="0" x2="0" y2="${s}" stroke="${p.cor}" stroke-width="${p.espessura || 1.5}"/></pattern>`);
    });
  }

  function simbolo(rt, cat) {
    const e = rt.cfg.estilo;
    if (rt.cfg.tipo === 'linha') {
      const larg = Math.min(e.espessura || 2, 4.5);
      const cont = e.contorno ? `<path d="M3 11h22" stroke="${e.contorno.cor}" stroke-width="${Math.min(e.contorno.espessura, 7.5)}" stroke-linecap="round" fill="none"/>` : '';
      const dash = e.tracejado ? `stroke-dasharray="${e.tracejado.split(/\s+/).map((v) => Math.max(1, v * 0.6)).join(' ')}"` : '';
      return `<svg class="simb" viewBox="0 0 28 22" aria-hidden="true">${cont}<path d="M3 11h22" stroke="${e.cor}" stroke-width="${larg}" ${dash} stroke-linecap="${e.lineCap || 'round'}" fill="none"/></svg>`;
    }
    let preench = e.preenchimento || e.cor;
    let traco = poligonoPreenchido(rt) ? (e.padrao ? e.padrao.cor : preench) : e.cor;
    if (cat) { preench = cat; traco = cat; }
    else if (rt.cats && rt.cats.size) {
      const cores = [...rt.cats.values()].slice(0, 4);
      const w = 22 / cores.length;
      const faixas = cores.map((c, i) => `<rect x="${3 + i * w}" y="4" width="${w + 0.2}" height="14" fill="${c}" fill-opacity=".8"/>`).join('');
      return `<svg class="simb" viewBox="0 0 28 22" aria-hidden="true"><clipPath id="cp-${rt.cfg.id}-${++uid}"><rect x="3" y="4" width="22" height="14" rx="3"/></clipPath><g clip-path="url(#cp-${rt.cfg.id}-${uid})">${faixas}</g><rect x="3" y="4" width="22" height="14" rx="3" fill="none" stroke="${e.cor}" stroke-width="1"/></svg>`;
    }
    const fill = e.semPreenchimento ? 'none' : (e.padrao ? `url(#pad-${rt.cfg.id})` : preench);
    const fo = e.padrao ? 1 : (poligonoPreenchido(rt) ? OPACIDADE_PREENCHIMENTO : 0);
    const halo = e.contorno && !cat
      ? `<rect x="3" y="4" width="22" height="14" rx="3" fill="none" stroke="#9aa5b1" stroke-width="${Math.min(e.contorno.espessura, 5.5)}" stroke-opacity=".35"/>`
      : '';
    return `<svg class="simb" viewBox="0 0 28 22" aria-hidden="true">${halo}<rect x="3" y="4" width="22" height="14" rx="3" fill="${fill}" fill-opacity="${fo}" stroke="${traco}" stroke-width="${Math.min(e.espessura ?? 1.5, 2.6)}"/></svg>`;
  }

  /* ------------------------------------------------------------------
     Camadas (runtime)
     ------------------------------------------------------------------ */
  function rotuloDe(rt, f) {
    const campos = (rt.cfg.rotulo || []).concat(CAMPOS_ROTULO);
    for (const c of campos) {
      const v = f.properties[c];
      if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
    }
    return rt.cfg.nome;
  }

  function criarCamadas() {
    CFG.camadas.forEach((cfg, ordem) => {
      const rt = {
        cfg, ordem,
        visivel: !!cfg.visivel,
        opacidade: 1,
        grupo: L.featureGroup(),
        geo: null,
        features: [],
        cats: null,
        chaveConstruida: null
      };
      estado.camadas.push(rt);
      estado.porId.set(cfg.id, rt);
    });
    estado.camadas.forEach(calcularCategorias);
  }

  /* ------------------------------------------------------------------
     Filtros por perfil de carga / tipo de instalação
     ------------------------------------------------------------------ */
  function normPerfil(v) {
    if (v === null || v === undefined || String(v).trim() === '') return 'Não informado';
    const s = String(v).trim();
    return (EST.sinonimos && EST.sinonimos[s]) || s;
  }
  const normTipo = (v) => (v === null || v === undefined || String(v).trim() === '' ? 'Não informado' : String(v).trim());
  const temFiltro = () => estado.filtros.perfil.size > 0 || estado.filtros.tipo.size > 0;

  function temCampoPerfil(rt) {
    if (rt.temPerfil !== undefined) return rt.temPerfil;
    const hs = rt.cfg.horizonte ? CFG.horizontes.map((h) => h.id) : [estado.horizonte];
    rt.temPerfil = hs.some((h) => { const d = dadosDe(rt, h); return d && d.features.some((f) => EST.campoPerfil in f.properties); });
    return rt.temPerfil;
  }

  function passaFiltro(rt, f, ignorar) {
    const fl = estado.filtros;
    if (ignorar !== 'perfil' && fl.perfil.size && temCampoPerfil(rt) && !fl.perfil.has(normPerfil(f.properties[EST.campoPerfil]))) return false;
    if (ignorar !== 'tipo' && fl.tipo.size && rt.cfg.id === EST.camadaAreas && !fl.tipo.has(normTipo(f.properties[EST.campoTipo]))) return false;
    return true;
  }

  function assinaturaFiltro(rt) {
    const fl = estado.filtros;
    const p = fl.perfil.size && temCampoPerfil(rt) ? [...fl.perfil].sort().join(',') : '';
    const t = fl.tipo.size && rt.cfg.id === EST.camadaAreas ? [...fl.tipo].sort().join(',') : '';
    return p + '|' + t;
  }

  const feicoesFiltradas = (rt, hId) => {
    const d = dadosDe(rt, hId);
    return d ? d.features.filter((f) => passaFiltro(rt, f)) : [];
  };

  function construir(rt) {
    rt.grupo.clearLayers();
    rt.geo = null;
    const d = dadosDe(rt);
    rt.features = d ? d.features.filter((f) => passaFiltro(rt, f)) : [];
    rt.chaveConstruida = chave(arquivoDe(rt)) + '#' + assinaturaFiltro(rt);
    if (!rt.features.length) return;
    const colecao = { type: 'FeatureCollection', features: rt.features };
    const pane = rt.cfg.painel || 'pn-zoneamento';
    if (rt.cfg.estilo.contorno) {
      L.geoJSON(colecao, { pane, interactive: false, style: () => estiloContorno(rt) }).addTo(rt.grupo);
    }
    rt.geo = L.geoJSON(colecao, {
      pane,
      style: (f) => estiloFeicao(rt, f),
      onEachFeature: (f, lyr) => {
        if (!rt.cfg.semTooltip) {
          lyr.bindTooltip(() => `<span class="tt-camada">${esc(rt.cfg.nome)}</span>${esc(rotuloDe(rt, f))}`,
            { sticky: true, direction: 'top', offset: [0, -12], className: 'gp-tooltip', opacity: 1 });
        }
        lyr.on('mouseover', () => { if (!estado.medicao) lyr.setStyle(estiloFeicao(rt, f, true)); });
        lyr.on('mouseout', () => lyr.setStyle(estiloFeicao(rt, f)));
      }
    }).addTo(rt.grupo);
  }

  function atualizarCamada(rt) {
    const disponivel = !!dadosDe(rt);
    if (rt.visivel && disponivel) {
      if (rt.chaveConstruida !== chave(arquivoDe(rt)) + '#' + assinaturaFiltro(rt)) construir(rt);
      if (!map.hasLayer(rt.grupo)) rt.grupo.addTo(map);
    } else {
      if (map.hasLayer(rt.grupo)) map.removeLayer(rt.grupo);
      if (!disponivel) rt.features = [];
    }
  }

  function aplicarOpacidade(rt) {
    rt.grupo.eachLayer((l) => {
      if (l === rt.geo) l.setStyle((f) => estiloFeicao(rt, f));
      else l.setStyle(() => estiloContorno(rt));
    });
  }

  function definirVisibilidade(rt, v, automatico) {
    rt.visivel = v;
    // Uma escolha manual do usuário prevalece sobre a ativação automática do filtro
    if (!automatico) estado.ligadasPeloFiltro.delete(rt.cfg.id);
    atualizarCamada(rt);
    if (!v) removerDaIdentificacao(rt);
  }

  // Ao desligar uma camada, retira do painel de identificação (e do destaque) as feições dela
  function removerDaIdentificacao(rt) {
    const destacadoAqui = estado.resultadosInfo.some((r) => r.rt === rt && r.f === estado.destaque);
    const restantes = estado.resultadosInfo.filter((r) => r.rt !== rt);
    if (restantes.length === estado.resultadosInfo.length) return;
    if (destacadoAqui || !restantes.length) { fecharInfo(); return; }
    // Mantém o destaque atual e apenas retira os cartões da camada desligada
    const destaque = estado.destaque;
    mostrarInfo(restantes);
    destacar(destaque);
    $$('#infoCorpo .card').forEach((c) => c.classList.toggle('aberto', restantes[Number(c.dataset.i)].f === destaque));
  }

  function extensaoDe(features) {
    if (!features || !features.length) return null;
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    features.forEach((f) => {
      b[0] = Math.min(b[0], f._bbox[0]); b[1] = Math.min(b[1], f._bbox[1]);
      b[2] = Math.max(b[2], f._bbox[2]); b[3] = Math.max(b[3], f._bbox[3]);
    });
    return L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
  }

  function margensMapa() {
    const direita = document.body.classList.contains('info-aberta') ? 400 : 70;
    const baixo = $('#tabela').hidden ? 40 : Math.min($('#tabela').offsetHeight + 30, map.getSize().y * 0.6);
    return { paddingTopLeft: [40, 40], paddingBottomRight: [direita, baixo] };
  }

  function aproximarDe(bounds, maxZoom = 18) {
    if (!bounds || !bounds.isValid()) return;
    map.flyToBounds(bounds, Object.assign({ maxZoom, duration: 0.6 }, margensMapa()));
  }

  /* ------------------------------------------------------------------
     Árvore de camadas
     ------------------------------------------------------------------ */
  function itemCamada(rt) {
    const d = dadosDe(rt);
    const n = d ? d.features.length : 0;
    const expandida = estado.expandidas.has(rt.cfg.id);
    const nf = d && assinaturaFiltro(rt) !== '|' ? feicoesFiltradas(rt).length : null;
    const meta = d
      ? (nf !== null
        ? `${NF0.format(nf)} de ${NF0.format(n)} feições <span class="tag-h tag-f" title="Filtrada pelo painel estatístico">filtro</span>`
        : `${NF0.format(n)} ${n === 1 ? 'feição' : 'feições'}`)
      : (rt.cfg.horizonte ? 'Sem dados neste horizonte' : 'Arquivo não encontrado');
    const tag = rt.cfg.horizonte ? ` · <span class="tag-h" title="Varia conforme o horizonte selecionado">${esc(horizonteAtual().curto)}</span>` : '';
    const op = Math.round(rt.opacidade * 100);
    const rotuloOpacidade = poligonoPreenchido(rt) ? 'Preenchimento' : 'Opacidade';
    return `
      <div class="camada ${rt.visivel ? 'ligada' : ''} ${d ? '' : 'indisponivel'} ${expandida ? 'expandida' : ''}" data-id="${rt.cfg.id}">
        <div class="camada-linha">
          <label class="chk" title="Ligar/desligar camada">
            <input type="checkbox" data-acao="camada-chk" ${rt.visivel ? 'checked' : ''} ${d ? '' : 'disabled'} aria-label="${esc(rt.cfg.nome)}">
            <span></span>
          </label>
          ${simbolo(rt)}
          <div class="camada-txt" data-acao="camada-alternar" title="${esc(arquivoDe(rt))}">
            <span class="camada-nome">${esc(rt.cfg.nome)}</span>
            <span class="camada-meta">${meta}${tag}</span>
          </div>
          <button type="button" class="btn-mini" data-acao="camada-mais" title="Opções da camada" aria-expanded="${expandida}">${icone('more')}</button>
        </div>
        ${rt.visivel && d ? legendaInline(rt) : ''}
        <div class="camada-opcoes">
          <div class="opacidade">
            <span>${rotuloOpacidade}</span>
            <input type="range" min="0" max="100" step="5" value="${op}" data-acao="opacidade" aria-label="${rotuloOpacidade} de ${esc(rt.cfg.nome)}">
            <output>${op}%</output>
          </div>
          <div class="camada-botoes">
            <button type="button" data-acao="camada-zoom" ${d ? '' : 'disabled'}>${icone('focus')}Aproximar</button>
            <button type="button" data-acao="camada-tabela" ${d ? '' : 'disabled'}>${icone('table')}Tabela</button>
            <button type="button" data-acao="camada-baixar" ${d ? '' : 'disabled'}>${icone('download')}GeoJSON</button>
          </div>
        </div>
      </div>`;
  }

  // Legenda das categorias (ex.: perfis de carga) logo abaixo da camada ligada
  function legendaInline(rt) {
    if (!rt.cats) return '';
    const presentes = new Set(feicoesFiltradas(rt).map((f) => valorCategoria(f, rt.cfg.categorias.campo)));
    const itens = [...rt.cats.entries()].filter(([v]) => presentes.has(v));
    if (!itens.length) return '';
    const titulo = rt.cfg.categorias.campo === EST.campoPerfil ? 'Cores por perfil de carga' : `Cores por ${rt.cfg.categorias.campo.toLowerCase()}`;
    return `<div class="leg-inline" aria-label="${esc(titulo)}">
        <span class="leg-inline-tit">${esc(titulo)}</span>
        <ul>${itens.map(([v, c]) => `<li><span class="amostra" style="--c:${c}"></span>${esc(v)}</li>`).join('')}</ul>
      </div>`;
  }

  function renderArvore() {
    const filtro = semAcento($('#filtroCamadas').value.trim());
    const html = CFG.grupos.map((g) => {
      const rts = estado.camadas.filter((rt) => rt.cfg.grupo === g.id &&
        (!filtro || semAcento(rt.cfg.nome).includes(filtro) || semAcento(rt.cfg.arquivo).includes(filtro)));
      if (!rts.length) return '';
      const ativos = rts.filter((r) => r.visivel).length;
      const aberto = !!filtro || !estado.gruposFechados.has(g.id);
      return `
        <section class="grupo ${aberto ? 'aberto' : ''}" data-grupo="${g.id}">
          <header class="grupo-cab">
            <button type="button" class="grupo-toggle" data-acao="grupo-toggle" aria-expanded="${aberto}">
              ${icone('chevron', 'i chev')}
              <span class="grupo-nome">${esc(g.nome)}</span>
              <span class="grupo-cont">${ativos}/${rts.length}</span>
            </button>
            <label class="chk" title="Ligar/desligar todas do grupo">
              <input type="checkbox" data-acao="grupo-chk" data-estado="${ativos === 0 ? 'nenhum' : ativos === rts.length ? 'todos' : 'parcial'}" ${ativos === rts.length ? 'checked' : ''} aria-label="Grupo ${esc(g.nome)}">
              <span></span>
            </label>
          </header>
          <div class="grupo-corpo">${rts.map(itemCamada).join('')}</div>
        </section>`;
    }).join('');
    $('#arvore').innerHTML = html || '<p class="vazio-lista">Nenhuma camada corresponde ao filtro.</p>';
    $$('#arvore input[data-estado="parcial"]').forEach((i) => { i.indeterminate = true; });
    const n = estado.camadas.filter((r) => r.visivel).length;
    $('#contAtivas').textContent = `${n} ${n === 1 ? 'camada ativa' : 'camadas ativas'} de ${estado.camadas.length}`;
  }

  function aoInteragirArvore(e) {
    const alvo = e.target.closest('[data-acao]');
    if (!alvo) return;
    const acao = alvo.dataset.acao;
    const elCamada = alvo.closest('.camada');
    const rt = elCamada ? estado.porId.get(elCamada.dataset.id) : null;
    const elGrupo = alvo.closest('.grupo');

    if (e.type === 'input') {
      if (acao === 'opacidade' && rt) {
        rt.opacidade = Number(alvo.value) / 100;
        alvo.nextElementSibling.textContent = `${alvo.value}%`;
        aplicarOpacidade(rt);
      }
      return;
    }
    if (e.type === 'change') {
      if (acao === 'camada-chk' && rt) {
        definirVisibilidade(rt, alvo.checked);
        aposMudarVisibilidade();
      } else if (acao === 'grupo-chk' && elGrupo) {
        const ligar = alvo.dataset.estado !== 'todos';
        $$('.camada', elGrupo).forEach((el) => {
          const r = estado.porId.get(el.dataset.id);
          if (dadosDe(r)) definirVisibilidade(r, ligar);
        });
        aposMudarVisibilidade();
      }
      return;
    }
    // click
    switch (acao) {
      case 'grupo-toggle': {
        const id = elGrupo.dataset.grupo;
        if (estado.gruposFechados.has(id)) estado.gruposFechados.delete(id); else estado.gruposFechados.add(id);
        elGrupo.classList.toggle('aberto');
        alvo.setAttribute('aria-expanded', String(elGrupo.classList.contains('aberto')));
        break;
      }
      case 'camada-alternar':
        if (rt && dadosDe(rt)) { definirVisibilidade(rt, !rt.visivel); aposMudarVisibilidade(); }
        break;
      case 'camada-mais':
        if (estado.expandidas.has(rt.cfg.id)) estado.expandidas.delete(rt.cfg.id); else estado.expandidas.add(rt.cfg.id);
        elCamada.classList.toggle('expandida');
        alvo.setAttribute('aria-expanded', String(elCamada.classList.contains('expandida')));
        break;
      case 'camada-zoom': {
        const d = dadosDe(rt);
        if (!rt.visivel) { definirVisibilidade(rt, true); aposMudarVisibilidade(); }
        aproximarDe(extensaoDe(d && d.features), 17);
        break;
      }
      case 'camada-tabela':
        abrirTabela(rt);
        break;
      case 'camada-baixar':
        baixarGeoJSON(rt);
        break;
    }
  }

  function aposMudarVisibilidade() {
    renderArvore();
    renderLegenda();
  }

  /* ------------------------------------------------------------------
     Legenda
     ------------------------------------------------------------------ */
  function htmlLegenda() {
    const visiveis = estado.camadas.filter((rt) => rt.visivel && dadosDe(rt));
    if (!visiveis.length) return '<p class="vazio-lista">Nenhuma camada ativa. Ligue camadas na aba “Camadas”.</p>';
    return CFG.grupos.map((g) => {
      const rts = visiveis.filter((rt) => rt.cfg.grupo === g.id);
      if (!rts.length) return '';
      return `<div class="leg-grupo"><h3>${esc(g.nome)}</h3>${rts.map((rt) => {
        let sub = '';
        if (rt.cats) {
          const presentes = new Set(dadosDe(rt).features.map((f) => valorCategoria(f, rt.cfg.categorias.campo)));
          sub = `<div class="leg-sub">${[...rt.cats.entries()].filter(([v]) => presentes.has(v))
            .map(([v, c]) => `<div class="leg-item">${simbolo(rt, c)}<span>${esc(v)}</span></div>`).join('')}</div>`;
        }
        const h = rt.cfg.horizonte ? `<span class="leg-h">(${esc(horizonteAtual().nome)})</span>` : '';
        return `<div class="leg-item">${simbolo(rt)}<span>${esc(rt.cfg.nome)}${h}</span></div>${sub}`;
      }).join('')}</div>`;
    }).join('');
  }

  function renderLegenda() {
    $('#legenda').innerHTML = htmlLegenda();
  }

  /* ------------------------------------------------------------------
     Horizonte de planejamento
     ------------------------------------------------------------------ */
  function montarHorizontes() {
    $('#horizontes').innerHTML = CFG.horizontes.map((h) =>
      `<button type="button" role="radio" data-h="${h.id}" aria-checked="${h.id === estado.horizonte}">${esc(h.nome)}</button>`).join('');
    $('#horizontes').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-h]');
      if (b) mudarHorizonte(b.dataset.h);
    });
    $('#horizontes').addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      const i = CFG.horizontes.findIndex((h) => h.id === estado.horizonte);
      const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + CFG.horizontes.length) % CFG.horizontes.length;
      mudarHorizonte(CFG.horizontes[n].id);
      $(`#horizontes button[data-h="${CFG.horizontes[n].id}"]`).focus();
    });
  }

  function mudarHorizonte(id) {
    if (id === estado.horizonte) return;
    estado.horizonte = id;
    armazenamento.gravar('horizonte', id);
    $$('#horizontes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.h === id)));
    if (!estado.iniciado) return;
    estado.camadas.filter((rt) => rt.cfg.horizonte).forEach(atualizarCamada);
    fecharInfo();
    renderArvore();
    renderLegenda();
    if (estado.tabela && estado.tabela.rt.cfg.horizonte) renderTabela();
    if ($('#campoPesquisa').value.trim()) pesquisar();
    renderEst();
    aviso(`Horizonte de planejamento: ${horizonteAtual().nome}`);
  }

  /* ------------------------------------------------------------------
     Identificação de feições (clique no mapa)
     ------------------------------------------------------------------ */
  function pontoNoAnel(x, y, anel) {
    let dentro = false;
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const xi = anel[i][0], yi = anel[i][1], xj = anel[j][0], yj = anel[j][1];
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) dentro = !dentro;
    }
    return dentro;
  }
  const pontoNoPoligono = (aneis, x, y) => pontoNoAnel(x, y, aneis[0]) && !aneis.slice(1).some((h) => pontoNoAnel(x, y, h));

  function pertoDaLinha(coords, p, tol) {
    let a = map.latLngToContainerPoint([coords[0][1], coords[0][0]]);
    for (let i = 1; i < coords.length; i++) {
      const b = map.latLngToContainerPoint([coords[i][1], coords[i][0]]);
      if (L.LineUtil.pointToSegmentDistance(p, a, b) <= tol) return true;
      a = b;
    }
    return false;
  }

  function acerta(rt, g, ll, p, tol) {
    const x = ll.lng, y = ll.lat;
    const soBorda = !!rt.cfg.estilo.semPreenchimento;
    switch (g.type) {
      case 'Polygon':
        return (!soBorda && pontoNoPoligono(g.coordinates, x, y)) || g.coordinates.some((a) => pertoDaLinha(a, p, tol));
      case 'MultiPolygon':
        return (!soBorda && g.coordinates.some((pg) => pontoNoPoligono(pg, x, y))) ||
          g.coordinates.some((pg) => pg.some((a) => pertoDaLinha(a, p, tol)));
      case 'LineString':
        return pertoDaLinha(g.coordinates, p, tol);
      case 'MultiLineString':
        return g.coordinates.some((l) => pertoDaLinha(l, p, tol));
      case 'Point':
        return map.latLngToContainerPoint([g.coordinates[1], g.coordinates[0]]).distanceTo(p) <= tol * 1.6;
      case 'MultiPoint':
        return g.coordinates.some((c) => map.latLngToContainerPoint([c[1], c[0]]).distanceTo(p) <= tol * 1.6);
      default:
        return false;
    }
  }

  function camadasVisiveisOrdenadas() {
    return estado.camadas
      .filter((rt) => rt.visivel && rt.features.length && map.hasLayer(rt.grupo))
      .sort((a, b) => (PANES[b.cfg.painel] - PANES[a.cfg.painel]) || (b.ordem - a.ordem));
  }

  function identificar(ll) {
    const p = map.latLngToContainerPoint(ll);
    const tol = 7;
    const b = map.getBounds(), tam = map.getSize();
    const tolX = ((b.getEast() - b.getWest()) / tam.x) * tol;
    const tolY = ((b.getNorth() - b.getSouth()) / tam.y) * tol;
    const res = [];
    camadasVisiveisOrdenadas().forEach((rt) => {
      rt.features.forEach((f) => {
        const bb = f._bbox;
        if (ll.lng < bb[0] - tolX || ll.lng > bb[2] + tolX || ll.lat < bb[1] - tolY || ll.lat > bb[3] + tolY) return;
        if (acerta(rt, f.geometry, ll, p, tol)) res.push({ rt, f });
      });
    });
    return res;
  }

  /* ------------------------------------------------------------------
     Formatação de atributos
     ------------------------------------------------------------------ */
  function formatarValor(k, v) {
    if (v === null || v === undefined || String(v).trim() === '') return '<span class="vazio">—</span>';
    if (typeof v === 'number') {
      if (/^(id|id_\d+|cd_|codigo|código)/i.test(k)) return esc(String(v));
      return NF2.format(v);
    }
    const s = String(v).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return esc(s);
  }

  function tabelaAtributos(f) {
    const linhas = Object.keys(f.properties).map((k) =>
      `<tr><th scope="row">${esc(k)}</th><td>${formatarValor(k, f.properties[k])}</td></tr>`).join('');
    return `<table class="atributos"><tbody>${linhas || '<tr><td class="vazio">Sem atributos</td></tr>'}</tbody></table>`;
  }

  /* ------------------------------------------------------------------
     Painel de informações
     ------------------------------------------------------------------ */
  function abrirPainelInfo() {
    $('#info').hidden = false;
    document.body.classList.add('info-aberta');
  }

  function fecharInfo() {
    $('#info').hidden = true;
    document.body.classList.remove('info-aberta');
    estado.resultadosInfo = [];
    limparDestaque();
  }

  function mostrarInfo(res) {
    estado.resultadosInfo = res;
    if (!res.length) { fecharInfo(); return; }
    const n = res.length;
    $('#infoResumo').textContent = `${n} ${n === 1 ? 'feição encontrada' : 'feições encontradas'} · ${horizonteAtual().nome}`;
    $('#infoCorpo').innerHTML = res.map(({ rt, f }, i) => {
      const cat = rt.cats ? rt.cats.get(valorCategoria(f, rt.cfg.categorias.campo)) : null;
      return `
        <article class="card ${i === 0 ? 'aberto' : ''}" data-i="${i}">
          <button type="button" class="card-cab" data-acao="card">
            ${simbolo(rt, cat)}
            <span class="card-tit"><strong>${esc(rotuloDe(rt, f))}</strong><small>${esc(rt.cfg.nome)}</small></span>
            ${icone('chevron', 'i chev')}
          </button>
          <div class="card-corpo">
            ${tabelaAtributos(f)}
            <div class="card-acoes">
              <button type="button" class="btn-sec" data-acao="card-zoom">${icone('focus')}Aproximar</button>
              <button type="button" class="btn-sec" data-acao="card-tabela">${icone('table')}Ver na tabela</button>
            </div>
          </div>
        </article>`;
    }).join('');
    $('#infoCorpo').scrollTop = 0;
    abrirPainelInfo();
    destacar(res[0].f);
  }

  function aoInteragirInfo(e) {
    const alvo = e.target.closest('[data-acao]');
    if (!alvo) return;
    const card = alvo.closest('.card');
    const item = estado.resultadosInfo[Number(card.dataset.i)];
    if (!item) return;
    if (alvo.dataset.acao === 'card') {
      const abrir = !card.classList.contains('aberto');
      $$('#infoCorpo .card').forEach((c) => c.classList.remove('aberto'));
      if (abrir) { card.classList.add('aberto'); destacar(item.f); }
    } else if (alvo.dataset.acao === 'card-zoom') {
      destacar(item.f);
      aproximarDe(extensaoDe([item.f]));
    } else if (alvo.dataset.acao === 'card-tabela') {
      abrirTabela(item.rt, item.f._uid);
    }
  }

  /* ------------------------------------------------------------------
     Destaque de feição
     ------------------------------------------------------------------ */
  function destacar(f) {
    camadaDestaque.clearLayers();
    estado.destaque = f;
    if (!f) return;
    const base = { pane: 'pn-destaque', interactive: false };
    L.geoJSON(f, Object.assign({}, base, {
      style: { color: '#ffffff', weight: 8, opacity: 0.9, fill: false, lineJoin: 'round', lineCap: 'round' }
    })).addTo(camadaDestaque);
    L.geoJSON(f, Object.assign({}, base, {
      style: { color: '#f59e0b', weight: 3.5, opacity: 1, fillColor: '#fde68a', fillOpacity: 0.3, lineJoin: 'round', lineCap: 'round', className: 'gp-destaque' }
    })).addTo(camadaDestaque);
  }
  function limparDestaque() { camadaDestaque.clearLayers(); estado.destaque = null; }

  /* ------------------------------------------------------------------
     Tabela de atributos
     ------------------------------------------------------------------ */
  function abrirTabela(rt, uidSel) {
    const mesmo = estado.tabela && estado.tabela.rt === rt;
    estado.tabela = {
      rt,
      ordem: mesmo ? estado.tabela.ordem : null,
      dir: mesmo ? estado.tabela.dir : 1,
      sel: uidSel || null
    };
    if (!mesmo) $('#tabelaFiltro').value = '';
    $('#tabela').hidden = false;
    renderTabela();
    if (uidSel) {
      const tr = $(`#tabelaRolagem tr[data-uid="${uidSel}"]`);
      if (tr) tr.scrollIntoView({ block: 'center' });
    }
  }

  function fecharTabela() {
    $('#tabela').hidden = true;
    estado.tabela = null;
  }

  function colunasDe(features) {
    const cols = [];
    features.forEach((f) => Object.keys(f.properties).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));
    return cols;
  }

  function linhasFiltradas() {
    const t = estado.tabela;
    const d = dadosDe(t.rt);
    let feats = d ? d.features.filter((f) => passaFiltro(t.rt, f)) : [];
    const q = semAcento($('#tabelaFiltro').value.trim());
    if (q) feats = feats.filter((f) => textoDaFeicao(f).includes(q));
    if (t.ordem) {
      const k = t.ordem;
      feats.sort((a, b) => {
        const va = a.properties[k], vb = b.properties[k];
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * t.dir;
        return String(va).localeCompare(String(vb), 'pt-BR', { numeric: true }) * t.dir;
      });
    }
    return { todas: d ? d.features : [], feats };
  }

  function renderTabela() {
    const t = estado.tabela;
    if (!t) return;
    const { todas, feats } = linhasFiltradas();
    const cols = colunasDe(todas);
    const numericas = new Set(cols.filter((c) => todas.some((f) => typeof f.properties[c] === 'number')));
    $('#tabelaTitulo').textContent = t.rt.cfg.nome;
    $('#tabelaResumo').textContent =
      `${NF0.format(feats.length)} de ${NF0.format(todas.length)} registros${t.rt.cfg.horizonte ? ' · ' + horizonteAtual().nome : ''}${assinaturaFiltro(t.rt) !== '|' ? ' · filtro do painel estatístico ativo' : ''}`;
    if (!todas.length) {
      $('#tabelaRolagem').innerHTML = '<p class="vazio-lista">Esta camada não possui registros no horizonte selecionado.</p>';
      return;
    }
    const cab = cols.map((c) => {
      const ind = t.ordem === c ? (t.dir === 1 ? '▲' : '▼') : '';
      return `<th scope="col" data-col="${esc(c)}">${esc(c)}<span class="ord">${ind}</span></th>`;
    }).join('');
    const corpo = feats.map((f) => `<tr data-uid="${f._uid}" class="${t.sel === f._uid ? 'sel' : ''}">${cols.map((c) =>
      `<td class="${numericas.has(c) ? 'num' : ''}" title="${esc(f.properties[c] ?? '')}">${formatarValor(c, f.properties[c])}</td>`).join('')}</tr>`).join('');
    $('#tabelaRolagem').innerHTML = `<table><thead><tr>${cab}</tr></thead><tbody>${corpo}</tbody></table>`;
  }

  function aoInteragirTabela(e) {
    const th = e.target.closest('th[data-col]');
    if (th) {
      const t = estado.tabela;
      const c = th.dataset.col;
      if (t.ordem === c) t.dir = -t.dir; else { t.ordem = c; t.dir = 1; }
      renderTabela();
      return;
    }
    const tr = e.target.closest('tr[data-uid]');
    if (tr) {
      const t = estado.tabela;
      const uidSel = Number(tr.dataset.uid);
      const f = dadosDe(t.rt).features.find((x) => x._uid === uidSel);
      if (!f) return;
      t.sel = uidSel;
      $$('#tabelaRolagem tr.sel').forEach((x) => x.classList.remove('sel'));
      tr.classList.add('sel');
      if (!t.rt.visivel) { definirVisibilidade(t.rt, true); aposMudarVisibilidade(); }
      mostrarInfo([{ rt: t.rt, f }]);
      aproximarDe(extensaoDe([f]));
    }
  }

  /* ------------------------------------------------------------------
     Exportação
     ------------------------------------------------------------------ */
  function baixar(nome, conteudo, tipo) {
    const blob = new Blob([conteudo], { type: tipo });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nome;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function baixarGeoJSON(rt) {
    const d = dadosDe(rt);
    if (!d) return;
    const saida = {
      type: 'FeatureCollection',
      name: arquivoDe(rt),
      features: d.features.map((f) => ({ type: 'Feature', properties: f.properties, geometry: f.geometry }))
    };
    baixar(`${arquivoDe(rt)} (WGS84).geojson`, JSON.stringify(saida), 'application/geo+json');
    aviso('GeoJSON exportado em WGS 84 (EPSG:4326).');
  }

  function baixarCSV() {
    const t = estado.tabela;
    if (!t) return;
    const { todas, feats } = linhasFiltradas();
    const cols = colunasDe(todas);
    const cel = (v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
      return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const linhas = [cols.map(cel).join(';')].concat(feats.map((f) => cols.map((c) => cel(f.properties[c])).join(';')));
    baixar(`${arquivoDe(t.rt)}.csv`, '﻿' + linhas.join('\r\n'), 'text/csv;charset=utf-8');
  }

  /* ------------------------------------------------------------------
     Pesquisa
     ------------------------------------------------------------------ */
  function textoDaFeicao(f) {
    let t = textoBusca.get(f);
    if (t === undefined) {
      t = semAcento(Object.values(f.properties).filter((v) => v !== null && v !== undefined).join(' | '));
      textoBusca.set(f, t);
    }
    return t;
  }

  function marcarTrecho(texto, q) {
    const base = semAcento(texto);
    const i = base.indexOf(q);
    if (i < 0) return esc(texto);
    return esc(texto.slice(0, i)) + '<mark>' + esc(texto.slice(i, i + q.length)) + '</mark>' + esc(texto.slice(i + q.length));
  }

  let resultadosPesquisa = [];
  function pesquisar() {
    const bruto = $('#campoPesquisa').value.trim();
    const q = semAcento(bruto);
    const alvo = $('#resultadosPesquisa');
    resultadosPesquisa = [];
    if (q.length < 2) {
      alvo.innerHTML = '';
      $('#dicaPesquisa').textContent = 'Pesquisa em todos os atributos das camadas do horizonte selecionado.';
      return;
    }
    let total = 0;
    const html = CFG.grupos.map((g) => estado.camadas.filter((rt) => rt.cfg.grupo === g.id).map((rt) => {
      const d = dadosDe(rt);
      if (!d) return '';
      const hits = d.features.filter((f) => textoDaFeicao(f).includes(q));
      if (!hits.length) return '';
      total += hits.length;
      const itens = hits.slice(0, 40).map((f) => {
        const idx = resultadosPesquisa.push({ rt, f }) - 1;
        const campo = Object.entries(f.properties).find(([, v]) => v !== null && v !== undefined && semAcento(v).includes(q));
        const trecho = campo ? `${esc(campo[0])}: ${marcarTrecho(String(campo[1]), q)}` : '';
        return `<button type="button" class="res-item" data-r="${idx}"><strong>${marcarTrecho(rotuloDe(rt, f), q)}</strong><span>${trecho}</span></button>`;
      }).join('');
      return `<div class="res-grupo"><h3>${simbolo(rt)}${esc(rt.cfg.nome)}<small>${hits.length}</small></h3>${itens}</div>`;
    }).join('')).join('');
    $('#dicaPesquisa').textContent = total
      ? `${NF0.format(total)} ${total === 1 ? 'resultado' : 'resultados'} para “${bruto}” · ${horizonteAtual().nome}`
      : `Nenhum resultado para “${bruto}” no horizonte ${horizonteAtual().nome}.`;
    alvo.innerHTML = html;
  }

  function aoClicarResultado(e) {
    const b = e.target.closest('.res-item');
    if (!b) return;
    const item = resultadosPesquisa[Number(b.dataset.r)];
    if (!item) return;
    if (!item.rt.visivel) { definirVisibilidade(item.rt, true); aposMudarVisibilidade(); }
    mostrarInfo([item]);
    aproximarDe(extensaoDe([item.f]));
    if (window.matchMedia('(max-width: 900px)').matches) document.body.classList.add('painel-oculto');
  }

  /* ------------------------------------------------------------------
     Medição
     ------------------------------------------------------------------ */
  function formatarDistancia(m) {
    return m < 1000 ? `${NF1.format(m)} m` : `${NF2.format(m / 1000)} km`;
  }
  function formatarArea(m2) {
    if (m2 < 10000) return `${NF0.format(m2)} m²`;
    if (m2 < 1e6) return `${NF2.format(m2 / 10000)} ha`;
    return `${NF2.format(m2 / 1e6)} km²`;
  }
  function areaGeodesica(lls) {
    const R = 6378137, d2r = Math.PI / 180;
    let a = 0;
    for (let i = 0; i < lls.length; i++) {
      const p1 = lls[i], p2 = lls[(i + 1) % lls.length];
      a += (p2.lng - p1.lng) * d2r * (2 + Math.sin(p1.lat * d2r) + Math.sin(p2.lat * d2r));
    }
    return Math.abs((a * R * R) / 2);
  }
  function comprimento(lls, fechar) {
    let d = 0;
    for (let i = 1; i < lls.length; i++) d += map.distance(lls[i - 1], lls[i]);
    if (fechar && lls.length > 2) d += map.distance(lls[lls.length - 1], lls[0]);
    return d;
  }
  function textoMedida(tipo, lls) {
    if (tipo === 'distancia') return formatarDistancia(comprimento(lls));
    if (lls.length < 3) return 'Adicione ao menos 3 vértices';
    return `${formatarArea(areaGeodesica(lls))}<small>Perímetro: ${formatarDistancia(comprimento(lls, true))}</small>`;
  }

  const estiloMedicao = { pane: 'pn-medicao', color: '#1d4ed8', weight: 2.5, dashArray: '6 5', fillColor: '#3b82f6', fillOpacity: 0.12, interactive: false };

  function iniciarMedicao(tipo) {
    const mesmo = estado.medicao && estado.medicao.tipo === tipo;
    cancelarMedicao();
    if (mesmo) return;
    estado.medicao = { tipo, pts: [], forma: null, vertices: L.layerGroup().addTo(camadaMedicoes), rotulo: null };
    map.getContainer().classList.add('medindo');
    map.doubleClickZoom.disable();
    $$(`.grupo-ferr button[data-ferr="${tipo}"]`).forEach((b) => b.classList.add('ativo'));
    aviso(tipo === 'distancia'
      ? 'Clique no mapa para medir a distância. Duplo clique finaliza; Esc cancela.'
      : 'Clique no mapa para desenhar a área. Duplo clique finaliza; Esc cancela.', 4200);
  }

  function desenharMedicao(cursor) {
    const m = estado.medicao;
    const pts = cursor ? m.pts.concat([cursor]) : m.pts.slice();
    if (!pts.length) return;
    if (!m.forma) {
      m.forma = (m.tipo === 'area' ? L.polygon(pts, estiloMedicao) : L.polyline(pts, estiloMedicao)).addTo(camadaMedicoes);
    } else m.forma.setLatLngs(pts);
    if (pts.length > 1) {
      if (!m.rotulo) {
        m.rotulo = L.tooltip({ permanent: true, direction: 'right', offset: [12, 0], className: 'gp-medida' });
        m.rotulo.setLatLng(pts[pts.length - 1]).setContent(textoMedida(m.tipo, pts)).addTo(map);
      } else m.rotulo.setLatLng(pts[pts.length - 1]).setContent(textoMedida(m.tipo, pts));
    }
  }

  function adicionarVertice(ll) {
    const m = estado.medicao;
    const ult = m.pts[m.pts.length - 1];
    if (ult && map.latLngToContainerPoint(ult).distanceTo(map.latLngToContainerPoint(ll)) < 4) return;
    m.pts.push(ll);
    L.circleMarker(ll, { pane: 'pn-medicao', radius: 4, color: '#1d4ed8', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(m.vertices);
    desenharMedicao();
  }

  function finalizarMedicao() {
    const m = estado.medicao;
    if (!m) return;
    const minimo = m.tipo === 'area' ? 3 : 2;
    if (m.pts.length < minimo) { cancelarMedicao(); return; }
    m.forma.setLatLngs(m.pts);
    if (m.tipo === 'area') { m.rotulo.options.direction = 'center'; m.rotulo.options.offset = [0, 0]; }
    m.rotulo.setLatLng(m.tipo === 'area' ? m.forma.getBounds().getCenter() : m.pts[m.pts.length - 1])
      .setContent(textoMedida(m.tipo, m.pts));
    camadaMedicoes.addLayer(m.rotulo);
    encerrarModoMedicao();
  }

  function cancelarMedicao() {
    const m = estado.medicao;
    if (!m) return;
    if (m.forma) camadaMedicoes.removeLayer(m.forma);
    if (m.rotulo) map.removeLayer(m.rotulo);
    camadaMedicoes.removeLayer(m.vertices);
    encerrarModoMedicao();
  }

  function encerrarModoMedicao() {
    estado.medicao = null;
    map.getContainer().classList.remove('medindo');
    setTimeout(() => map.doubleClickZoom.enable(), 300);
    $$('.grupo-ferr button.ativo').forEach((b) => b.classList.remove('ativo'));
  }

  function limparTudo() {
    cancelarMedicao();
    camadaMedicoes.eachLayer((l) => map.removeLayer(l));
    camadaMedicoes.clearLayers();
    if (camadaLocal) { map.removeLayer(camadaLocal); camadaLocal = null; }
    fecharInfo();
    map.closePopup();
    aviso('Medições e destaques removidos.');
  }

  /* ------------------------------------------------------------------
     Eventos do mapa
     ------------------------------------------------------------------ */
  function atualizarStatus(ll) {
    if (ll) {
      $('#stLat').textContent = `${NF5.format(ll.lat)}°`;
      $('#stLon').textContent = `${NF5.format(ll.lng)}°`;
      const u = paraUTM.forward([ll.lng, ll.lat]);
      $('#stUtm').textContent = `E ${NF1.format(u[0])} · N ${NF1.format(u[1])}`;
    }
    const z = map.getZoom();
    const lat = map.getCenter().lat;
    const res = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, z);
    const escala = res * (96 / 0.0254);
    const passo = Math.pow(10, Math.floor(Math.log10(escala)) - 1);
    $('#stEscala').textContent = `1:${NF0.format(Math.round(escala / passo) * passo)}`;
    $('#stZoom').textContent = NF2.format(z);
  }

  function menuCoordenadas(e) {
    const ll = e.latlng;
    const u = paraUTM.forward([ll.lng, ll.lat]);
    const txt = `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`;
    const html = `
      <div class="pop-coord">
        <h4>Coordenadas do ponto</h4>
        <table>
          <tr><td>Latitude</td><td>${NF6.format(ll.lat)}°</td></tr>
          <tr><td>Longitude</td><td>${NF6.format(ll.lng)}°</td></tr>
          <tr><td>UTM 23S E</td><td>${NF2.format(u[0])} m</td></tr>
          <tr><td>UTM 23S N</td><td>${NF2.format(u[1])} m</td></tr>
        </table>
        <button type="button" class="btn-sec" id="btnCopiarCoord">${icone('copy')}Copiar lat, lon</button>
      </div>`;
    L.popup({ maxWidth: 280 }).setLatLng(ll).setContent(html).openOn(map);
    const btn = document.getElementById('btnCopiarCoord');
    if (btn) btn.addEventListener('click', () => copiar(txt));
  }

  async function copiar(txt) {
    try { await navigator.clipboard.writeText(txt); aviso('Coordenadas copiadas.'); }
    catch (e) {
      const t = document.createElement('textarea');
      t.value = txt; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); aviso('Coordenadas copiadas.'); } catch (e2) { aviso(txt); }
      t.remove();
    }
  }

  function ligarEventosMapa() {
    map.on('click', (e) => {
      if (estado.medicao) { adicionarVertice(e.latlng); return; }
      mostrarInfo(identificar(e.latlng));
    });
    map.on('dblclick', () => { if (estado.medicao) finalizarMedicao(); });
    map.on('mousemove', (e) => {
      atualizarStatus(e.latlng);
      if (estado.medicao && estado.medicao.pts.length) desenharMedicao(e.latlng);
    });
    map.on('zoomend moveend', () => atualizarStatus());
    map.on('contextmenu', menuCoordenadas);
    map.on('locationfound', (e) => {
      if (camadaLocal) map.removeLayer(camadaLocal);
      camadaLocal = L.layerGroup([
        L.circle(e.latlng, { radius: e.accuracy, color: '#2563eb', weight: 1, fillOpacity: 0.08, interactive: false }),
        L.circleMarker(e.latlng, { radius: 7, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1, interactive: false })
      ]).addTo(map);
      aviso(`Localização encontrada (precisão de ${formatarDistancia(e.accuracy)}).`);
    });
    map.on('locationerror', () => aviso('Não foi possível obter sua localização.'));
  }

  /* ------------------------------------------------------------------
     Ferramentas
     ------------------------------------------------------------------ */
  function irParaInicio() {
    if (estado.extensaoInicial) map.flyToBounds(estado.extensaoInicial, Object.assign({ duration: 0.6 }, margensMapa()));
    else map.flyTo([-22.885, -43.2], 13);
  }

  /* Impressão: o mapa é redimensionado para o quadro fixo da folha A4 e
     reenquadrado na mesma área vista na tela, antes de abrir o diálogo. */
  let vistaAntesImpressao = null;

  function prepararImpressao() {
    if (vistaAntesImpressao) return;
    fecharInfo();
    $('#impTitulo').textContent = CFG.titulo;
    $('#impHorizonte').textContent = horizonteAtual().nome;
    const partes = [...estado.filtros.perfil].concat([...estado.filtros.tipo]);
    $('#impFiltro').textContent = partes.length ? ` · Filtro: ${partes.join(', ')}` : '';
    $('#impData').textContent = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    $('#impLegenda').innerHTML = htmlLegenda();
    vistaAntesImpressao = { centro: map.getCenter(), zoom: map.getZoom(), limites: map.getBounds() };
    document.body.classList.add('preparando-impressao');
    map.invalidateSize({ pan: false });
    // Zoom inteiro na impressão: blocos do mapa de fundo sem escala fracionária (sem emendas)
    map.options.zoomSnap = 1;
    map.fitBounds(vistaAntesImpressao.limites, { animate: false });
    map.options.zoomSnap = 0.25;
  }

  function restaurarAposImpressao() {
    if (!vistaAntesImpressao) return;
    const v = vistaAntesImpressao;
    vistaAntesImpressao = null;
    document.body.classList.remove('preparando-impressao');
    map.invalidateSize({ pan: false });
    map.setView(v.centro, v.zoom, { animate: false });
  }

  function aguardarMapaBase(limiteMs) {
    const camadas = [];
    Object.values(basesLeaflet).forEach((g) => { if (map.hasLayer(g)) g.eachLayer((l) => camadas.push(l)); });
    const inicio = Date.now();
    return new Promise((ok) => {
      (function verificar() {
        const carregando = camadas.some((l) => l.isLoading && l.isLoading());
        if (!carregando || Date.now() - inicio > limiteMs) ok(); else setTimeout(verificar, 120);
      })();
    });
  }

  async function imprimir() {
    prepararImpressao();
    aviso('Preparando a impressão…', 1800);
    await new Promise((r) => setTimeout(r, 150));
    await aguardarMapaBase(4000);
    window.print();
  }

  // Também cobre Ctrl+P (sem passar pelo botão)
  window.addEventListener('beforeprint', prepararImpressao);
  window.addEventListener('afterprint', () => setTimeout(restaurarAposImpressao, 50));

  function aoUsarFerramenta(e) {
    const b = e.target.closest('button[data-ferr]');
    if (!b) return;
    switch (b.dataset.ferr) {
      case 'zoom-mais': map.zoomIn(); break;
      case 'zoom-menos': map.zoomOut(); break;
      case 'inicio': irParaInicio(); break;
      case 'localizar': map.locate({ setView: true, maxZoom: 16 }); break;
      case 'distancia': iniciarMedicao('distancia'); break;
      case 'area': iniciarMedicao('area'); break;
      case 'limpar': limparTudo(); break;
      case 'imprimir': imprimir(); break;
    }
  }

  /* ------------------------------------------------------------------
     Painel estatístico — perfis de carga (filtro cruzado)
     ------------------------------------------------------------------ */
  function numero(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined) return 0;
    const s = String(v).trim();
    if (!s) return 0;
    const n = parseFloat(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s);
    return Number.isFinite(n) ? n : 0;
  }

  function agrupar(features, chaveFn, valorFn) {
    const m = new Map();
    features.forEach((f) => {
      const k = chaveFn(f);
      const g = m.get(k) || { valor: 0, n: 0, max: 0 };
      const v = valorFn(f);
      g.valor += v; g.n += 1; g.max = Math.max(g.max, v);
      m.set(k, g);
    });
    return [...m.entries()].map(([k, g]) => Object.assign({ chave: k }, g)).sort((a, b) => b.valor - a.valor);
  }

  const camadaEst = (id) => estado.porId.get(id);
  const campoArea = (f) => numero(f.properties['Área (m²)']) / 10000; // hectares
  const perfilDe = (f) => normPerfil(f.properties[EST.campoPerfil]);
  const tipoDe = (f) => normTipo(f.properties[EST.campoTipo]);

  function feicoesEst(id, hId, ignorar) {
    const rt = camadaEst(id);
    if (!rt) return [];
    const d = dadosDe(rt, hId);
    return d ? d.features.filter((f) => passaFiltro(rt, f, ignorar)) : [];
  }

  function htmlBarras(dim, itens, fmt, unidade, detalhe) {
    if (!itens.length) return '<p class="est-vazio">Sem registros para o filtro e horizonte selecionados.</p>';
    const sel = estado.filtros[dim];
    const max = Math.max(...itens.map((i) => i.valor), 0) || 1;
    const total = itens.reduce((s, i) => s + i.valor, 0) || 1;
    return `<div class="barras ${sel.size ? 'com-selecao' : ''}" role="group">${itens.map((i) => {
      const ativo = sel.has(i.chave);
      const tt = [i.chave, `${fmt(i.valor)} ${unidade} · ${NF1.format((i.valor / total) * 100)}% do total`, detalhe ? detalhe(i) : '']
        .filter(Boolean).join('|');
      return `<button type="button" class="barra" data-dim="${dim}" data-val="${esc(i.chave)}" aria-pressed="${sel.size ? ativo : false}"
          data-tt="${esc(tt)}" aria-label="${esc(i.chave)}: ${esc(fmt(i.valor))} ${unidade}. ${ativo ? 'Selecionado; clique para remover do filtro' : 'Clique para filtrar'}">
          <span class="rot">${esc(i.chave)}</span>
          <span class="trilho"><span class="val-barra" style="width:${Math.max(0.6, (i.valor / max) * 100)}%"></span></span>
          <span class="num">${fmt(i.valor)}</span>
        </button>`;
    }).join('')}</div>`;
  }

  function renderEst() {
    if (!estado.estAberto || !estado.iniciado) return;
    const h = horizonteAtual();
    $('#estSubtitulo').textContent = `Perfis de carga · ${h.nome}`;

    // Filtros ativos
    const fl = estado.filtros;
    const chips = [...fl.perfil].map((v) => ({ dim: 'perfil', v, r: 'Perfil' }))
      .concat([...fl.tipo].map((v) => ({ dim: 'tipo', v, r: 'Instalação' })));
    $('#estFiltros').innerHTML = chips.length
      ? chips.map((c) => `<span class="chip"><small>${c.r}:</small>${esc(c.v)}<button type="button" data-remover="${c.dim}" data-val="${esc(c.v)}" aria-label="Remover filtro ${esc(c.v)}">${icone('x')}</button></span>`).join('') +
        `<span class="acoes-filtro"><button type="button" class="btn-sec" data-est="zoom">${icone('focus')}Aproximar</button><button type="button" class="btn-sec" data-est="limpar">Limpar</button></span>`
      : `${icone('filter')}<span>Nenhum filtro ativo. Clique nas barras para filtrar o mapa, as tabelas e os demais gráficos.</span>`;

    // Conjuntos
    const areas = feicoesEst(EST.camadaAreas);
    const cais = feicoesEst(EST.camadaCais);
    const arr = feicoesEst(EST.camadaArrendadas);
    const disp = feicoesEst(EST.camadaDisponiveis);
    const soma = (fs, fn) => fs.reduce((s, f) => s + fn(f), 0);
    const comp = (f) => numero(f.properties['Comprimento (m)']);

    const kpis = [
      { r: 'Área afeta às operações', v: NF1.format(soma(areas, campoArea)), u: 'ha', e: `${areas.length} áreas` },
      { r: 'Extensão de cais', v: NF0.format(soma(cais, comp)), u: 'm', e: `${cais.length} berços` },
      { r: 'Área arrendada', v: NF1.format(soma(arr, campoArea)), u: 'ha', e: `${arr.length} arrendamentos` },
      { r: 'Disponível p/ arrendamento', v: NF1.format(soma(disp, campoArea)), u: 'ha', e: `${disp.length} áreas` }
    ];

    // Gráficos: cada um ignora a própria dimensão (filtro cruzado)
    const areasPorPerfil = agrupar(feicoesEst(EST.camadaAreas, null, 'perfil'), perfilDe, campoArea);
    const areasPorTipo = agrupar(feicoesEst(EST.camadaAreas, null, 'tipo'), tipoDe, campoArea);
    const calado = (i) => `${i.n} ${i.n === 1 ? 'feição' : 'feições'}`;

    // Evolução entre horizontes
    const evol = CFG.horizontes.map((hz) => ({ hz, valor: soma(feicoesEst(EST.camadaAreas, hz.id), campoArea) }));
    const maxEvol = Math.max(...evol.map((e) => e.valor), 0) || 1;

    const linhasArr = arr.slice().sort((a, b) => campoArea(b) - campoArea(a));

    $('#estCorpo').innerHTML = `
      <div class="kpis">${kpis.map((k) => `<div class="kpi"><span>${k.r}</span><b>${k.v}<small>${k.u}</small></b><em>${k.e}</em></div>`).join('')}</div>

      <section class="grafico" aria-labelledby="g1">
        <h3 id="g1">Área afeta por perfil de carga</h3>
        <p class="sub">Hectares · clique para filtrar por perfil</p>
        ${htmlBarras('perfil', areasPorPerfil, (v) => NF1.format(v), 'ha', calado)}
      </section>

      <section class="grafico" aria-labelledby="g3">
        <h3 id="g3">Área afeta por tipo de instalação</h3>
        <p class="sub">Hectares · clique para filtrar por tipo</p>
        ${htmlBarras('tipo', areasPorTipo, (v) => NF1.format(v), 'ha', calado)}
      </section>

      <section class="grafico" aria-labelledby="g4">
        <h3 id="g4">Área afeta por horizonte de planejamento</h3>
        <p class="sub">Hectares, com os filtros ativos · clique para trocar o horizonte</p>
        <div class="colunas">${evol.map((e) => `
          <button type="button" class="coluna" data-h="${e.hz.id}" aria-current="${e.hz.id === h.id}"
            data-tt="${esc(`${e.hz.nome}|${NF1.format(e.valor)} ha de área afeta`)}" aria-label="${esc(e.hz.nome)}: ${NF1.format(e.valor)} hectares">
            <span class="num">${NF1.format(e.valor)}</span>
            <span class="val-col" style="height:${Math.max(2, (e.valor / maxEvol) * 100)}px"></span>
            <span class="rot">${esc(e.hz.curto)}</span>
          </button>`).join('')}
        </div>
      </section>

      <section class="grafico" aria-labelledby="g5">
        <h3 id="g5">Arrendamentos</h3>
        <p class="sub">${linhasArr.length} ${linhasArr.length === 1 ? 'contrato' : 'contratos'} · clique na linha para localizar no mapa</p>
        ${linhasArr.length ? `<div class="est-tabela"><table>
          <thead><tr><th scope="col">Arrendatário</th><th scope="col">Perfil</th><th scope="col" class="num">Área (ha)</th><th scope="col">Término</th></tr></thead>
          <tbody>${linhasArr.map((f) => `<tr data-uid="${f._uid}" tabindex="0">
            <td title="${esc(f.properties['Arrendatário'] ?? '')}">${formatarValor('Arrendatário', f.properties['Arrendatário'])}</td>
            <td>${esc(perfilDe(f))}</td>
            <td class="num">${NF2.format(campoArea(f))}</td>
            <td>${formatarValor('Término', f.properties['Data do Término do Contrato'])}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="est-vazio">Nenhum arrendamento para o filtro e horizonte selecionados.</p>'}
      </section>`;
  }

  function aplicarFiltros(msg) {
    if (temFiltro()) {
      const ids = [EST.camadaAreas, EST.camadaCais, EST.camadaArrendadas, EST.camadaDisponiveis];
      const algumaVisivel = ids.some((id) => camadaEst(id) && camadaEst(id).visivel);
      const areas = camadaEst(EST.camadaAreas);
      // O filtro por tipo de instalação só existe na camada de áreas afetas: ela precisa estar ligada
      if (estado.filtros.tipo.size && areas && !areas.visivel) {
        areas.visivel = true;
        estado.ligadasPeloFiltro.add(EST.camadaAreas);
        msg = 'Camada de áreas afetas ligada para exibir o filtro por tipo de instalação.';
      }
      if (!algumaVisivel && !estado.filtros.tipo.size) {
        [EST.camadaAreas, EST.camadaCais].forEach((id) => {
          const rt = camadaEst(id);
          if (rt) { rt.visivel = true; estado.ligadasPeloFiltro.add(id); }
        });
        msg = 'Camadas de áreas afetas e acostagem ligadas para exibir o filtro no mapa.';
      }
    } else if (estado.ligadasPeloFiltro.size) {
      // Sem filtro: desliga o que o próprio filtro havia ligado
      estado.ligadasPeloFiltro.forEach((id) => { const rt = camadaEst(id); if (rt) rt.visivel = false; });
      estado.ligadasPeloFiltro.clear();
    }
    estado.camadas.forEach(atualizarCamada);
    fecharInfo();
    renderArvore();
    renderLegenda();
    renderEst();
    if (estado.tabela) renderTabela();
    const fl = estado.filtros;
    const partes = [...fl.perfil].concat([...fl.tipo]);
    $('#filtroMapa').hidden = !partes.length;
    $('#filtroMapaTxt').textContent = partes.length ? `Filtro: ${partes.join(', ')}` : '';
    if (msg) aviso(msg, 3600);
  }

  function alternarFiltro(dim, valor) {
    const s = estado.filtros[dim];
    const adicionou = !s.has(valor);
    if (adicionou) s.add(valor); else s.delete(valor);
    aplicarFiltros();
    // Aproxima o mapa das feições filtradas para localizá-las rapidamente
    if (temFiltro()) aproximarFiltro(dim);
  }

  function limparFiltros() {
    estado.filtros.perfil.clear();
    estado.filtros.tipo.clear();
    aplicarFiltros('Filtros removidos.');
  }

  function aproximarFiltro() {
    // Com filtro por tipo, só a camada de áreas afetas é filtrada: enquadra apenas ela
    const ids = estado.filtros.tipo.size
      ? [EST.camadaAreas]
      : [EST.camadaAreas, EST.camadaCais, EST.camadaArrendadas, EST.camadaDisponiveis];
    const feats = ids.map(camadaEst).filter((rt) => rt && rt.visivel).flatMap((rt) => rt.features);
    const ext = extensaoDe(feats);
    if (ext) aproximarDe(ext, 17); else aviso('Nenhuma feição visível para o filtro atual.');
  }

  function abrirEst() {
    estado.estAberto = true;
    $('#painelEst').hidden = false;
    $('#btnPainelEst').setAttribute('aria-expanded', 'true');
    renderEst();
    setTimeout(() => map.invalidateSize(), 60);
  }
  function fecharEst() {
    estado.estAberto = false;
    $('#painelEst').hidden = true;
    $('#estTooltip').hidden = true;
    $('#btnPainelEst').setAttribute('aria-expanded', 'false');
    setTimeout(() => map.invalidateSize(), 60);
  }

  function ligarEst() {
    const painel = $('#painelEst');
    const tip = $('#estTooltip');
    $('#btnPainelEst').addEventListener('click', () => (estado.estAberto ? fecharEst() : abrirEst()));
    $('#btnLimparFiltroMapa').addEventListener('click', limparFiltros);
    painel.addEventListener('click', (e) => {
      const barra = e.target.closest('.barra');
      if (barra) { alternarFiltro(barra.dataset.dim, barra.dataset.val); return; }
      const col = e.target.closest('.coluna');
      if (col) { mudarHorizonte(col.dataset.h); return; }
      const rem = e.target.closest('[data-remover]');
      if (rem) { alternarFiltro(rem.dataset.remover, rem.dataset.val); return; }
      const acao = e.target.closest('[data-est]');
      if (acao) { if (acao.dataset.est === 'limpar') limparFiltros(); else aproximarFiltro(); return; }
      const tr = e.target.closest('tr[data-uid]');
      if (tr) localizarArrendamento(Number(tr.dataset.uid));
    });
    painel.addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr[data-uid]');
      if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); localizarArrendamento(Number(tr.dataset.uid)); }
    });
    painel.addEventListener('mousemove', (e) => {
      const alvo = e.target.closest('[data-tt]');
      if (!alvo) { tip.hidden = true; return; }
      const [t, ...resto] = alvo.dataset.tt.split('|');
      tip.innerHTML = `<b>${esc(t)}</b>${resto.map((r) => `<span>${esc(r)}</span>`).join('<br>')}`;
      tip.hidden = false;
      const w = tip.offsetWidth, hgt = tip.offsetHeight;
      let x = e.clientX - w - 14, y = e.clientY + 14;
      if (x < 8) x = e.clientX + 14;
      if (y + hgt > window.innerHeight - 8) y = e.clientY - hgt - 10;
      tip.style.left = `${x}px`; tip.style.top = `${y}px`;
    });
    painel.addEventListener('mouseleave', () => { tip.hidden = true; });
  }

  function localizarArrendamento(uidSel) {
    const rt = camadaEst(EST.camadaArrendadas);
    const f = (dadosDe(rt) || { features: [] }).features.find((x) => x._uid === uidSel);
    if (!f) return;
    if (!rt.visivel) { definirVisibilidade(rt, true); aposMudarVisibilidade(); }
    mostrarInfo([{ rt, f }]);
    aproximarDe(extensaoDe([f]));
  }

  /* ------------------------------------------------------------------
     Aviso (toast)
     ------------------------------------------------------------------ */
  let temporizadorAviso = null;
  function aviso(txt, ms = 2600) {
    const el = $('#aviso');
    el.textContent = txt;
    el.classList.add('visivel');
    clearTimeout(temporizadorAviso);
    temporizadorAviso = setTimeout(() => el.classList.remove('visivel'), ms);
  }

  /* ------------------------------------------------------------------
     Sobre
     ------------------------------------------------------------------ */
  function renderSobre() {
    const arquivos = new Set();
    let feicoes = 0;
    estado.camadas.forEach((rt) => {
      const hs = rt.cfg.horizonte ? CFG.horizontes.map((h) => h.id) : [estado.horizonte];
      hs.forEach((h) => {
        const d = dadosDe(rt, h);
        if (d) { arquivos.add(arquivoDe(rt, h)); feicoes += d.features.length; }
      });
    });
    const crs = new Set([...estado.preparados.values()].filter(Boolean).map((d) => d.crsOrigem));
    $('#sobreCorpo').innerHTML = `
      <div class="stats">
        <div class="stat"><b>${estado.camadas.length}</b><span>camadas temáticas</span></div>
        <div class="stat"><b>${arquivos.size}</b><span>arquivos GeoJSON</span></div>
        <div class="stat"><b>${NF0.format(feicoes)}</b><span>feições</span></div>
      </div>
      <h3>Horizontes de planejamento</h3>
      <p>As camadas marcadas com a etiqueta de horizonte mudam conforme a seleção no topo da página:
        ${CFG.horizontes.map((h) => `<b>${esc(h.nome)}</b>`).join(', ')}. As demais camadas são comuns a todos os horizontes.</p>
      <h3>Como usar</h3>
      <ul>
        <li>Clique em uma feição para ver seus atributos; o painel lista todas as camadas sob o ponto clicado.</li>
        <li>Clique com o botão direito no mapa para obter as coordenadas geográficas e UTM do ponto.</li>
        <li>No menu <b>⋯</b> de cada camada: opacidade, aproximar, tabela de atributos e exportação em GeoJSON.</li>
        <li>Use a aba <b>Pesquisar</b> para localizar arrendatários, berços, trechos, armazéns e outros elementos.</li>
        <li>O <b>Painel estatístico</b> resume os perfis de carga. Clique nas barras para filtrar o mapa, as tabelas e os demais gráficos; clique de novo para remover o filtro.</li>
        <li>Atalhos: <kbd>Esc</kbd> fecha painéis e cancela medições; <kbd>←</kbd> <kbd>→</kbd> alternam o horizonte quando o seletor está em foco.</li>
      </ul>
      <h3>Sistemas de referência</h3>
      <p>Sistemas de origem dos arquivos: ${[...crs].map(esc).join(', ') || '—'}. Todos os dados são reprojetados para WGS 84 na exibição;
        a barra inferior mostra também as coordenadas em SIRGAS 2000 / UTM zona 23S (EPSG:31983).</p>
      <h3>Mapas de fundo</h3>
      <ul>${CFG.basemaps.map((b) => `<li><b>${esc(b.nome)}</b> — ${b.atribuicao}</li>`).join('')}</ul>
      <div class="creditos">
        <h3>Créditos</h3>
        <p>Geoportal desenvolvido por Maria Eduarda Almeida de Sousa.</p>
      </div>`;
  }

  function aplicarTema(tema, silencioso) {
    const escuro = tema === 'escuro';
    if (escuro) document.documentElement.dataset.tema = 'escuro';
    else delete document.documentElement.dataset.tema;
    armazenamento.gravar('tema', escuro ? 'escuro' : 'claro');
    const b = $('#btnTema');
    b.setAttribute('aria-pressed', String(escuro));
    b.setAttribute('aria-label', escuro ? 'Usar tema claro' : 'Usar tema escuro');
    b.title = escuro ? 'Usar tema claro' : 'Usar tema escuro';
    if (!silencioso) aviso(escuro ? 'Tema escuro ativado.' : 'Tema claro ativado.');
  }

  function abrirSobre() { renderSobre(); $('#modalSobre').hidden = false; $('#modalSobre .btn-fechar').focus(); }
  function fecharSobre() { $('#modalSobre').hidden = true; }

  /* ------------------------------------------------------------------
     Interface geral
     ------------------------------------------------------------------ */
  function ligarInterface() {
    // Abas
    $$('.aba-btn').forEach((b) => b.addEventListener('click', () => {
      $$('.aba-btn').forEach((x) => { x.classList.toggle('ativa', x === b); x.setAttribute('aria-selected', String(x === b)); });
      $$('.aba').forEach((s) => s.classList.toggle('ativa', s.id === `aba-${b.dataset.aba}`));
      if (b.dataset.aba === 'pesquisa') setTimeout(() => $('#campoPesquisa').focus(), 30);
    }));

    // Árvore
    const arvore = $('#arvore');
    ['click', 'change', 'input'].forEach((t) => arvore.addEventListener(t, aoInteragirArvore));
    $('#filtroCamadas').addEventListener('input', renderArvore);
    $('#btnDesligarTodas').addEventListener('click', () => {
      estado.camadas.forEach((rt) => definirVisibilidade(rt, false));
      aposMudarVisibilidade();
      fecharInfo();
    });

    // Pesquisa
    let t = null;
    $('#campoPesquisa').addEventListener('input', () => { clearTimeout(t); t = setTimeout(pesquisar, 180); });
    $('#resultadosPesquisa').addEventListener('click', aoClicarResultado);

    // Info e tabela
    $('#infoCorpo').addEventListener('click', aoInteragirInfo);
    $('#tabelaRolagem').addEventListener('click', aoInteragirTabela);
    let tf = null;
    $('#tabelaFiltro').addEventListener('input', () => { clearTimeout(tf); tf = setTimeout(renderTabela, 150); });
    $('#btnCsv').addEventListener('click', baixarCSV);
    document.addEventListener('click', (e) => {
      const f = e.target.closest('[data-fechar]');
      if (!f) return;
      if (f.dataset.fechar === 'info') fecharInfo();
      if (f.dataset.fechar === 'tabela') fecharTabela();
      if (f.dataset.fechar === 'sobre') fecharSobre();
      if (f.dataset.fechar === 'est') fecharEst();
    });
    [$('#info'), $('#tabela'), $('#ferramentas')].forEach((el) => {
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
    });

    // Ferramentas
    $('#ferramentas').addEventListener('click', aoUsarFerramenta);

    // Topo
    $('#btnSobre').addEventListener('click', abrirSobre);
    $('#btnTema').addEventListener('click', () => {
      aplicarTema(document.documentElement.dataset.tema === 'escuro' ? 'claro' : 'escuro');
    });
    $('#btnTelaCheia').addEventListener('click', () => {
      if (!document.fullscreenElement) { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); }
      else if (document.exitFullscreen) document.exitFullscreen();
    });
    $('#btnMenu').addEventListener('click', () => {
      const oculto = document.body.classList.toggle('painel-oculto');
      $('#btnMenu').setAttribute('aria-expanded', String(!oculto));
      if (!oculto) $('.aba-btn[data-aba="camadas"]').click();
    });
    $('.painel').addEventListener('transitionend', (e) => { if (e.target === $('.painel')) map.invalidateSize(); });

    // Teclado
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#modalSobre').hidden) { fecharSobre(); return; }
      if (estado.medicao) { cancelarMedicao(); return; }
      if (!$('#info').hidden) { fecharInfo(); return; }
      if (!$('#tabela').hidden) { fecharTabela(); return; }
      if (estado.estAberto) { fecharEst(); return; }
      map.closePopup();
    });

    window.addEventListener('resize', () => map.invalidateSize());
  }

  /* ------------------------------------------------------------------
     Inicialização
     ------------------------------------------------------------------ */
  function iniciarAplicacao() {
    if (estado.iniciado) return;
    estado.iniciado = true;
    criarCamadas();
    criarPadroes();
    estado.camadas.forEach(atualizarCamada);

    const poligonal = estado.porId.get('poligonal');
    let ext = poligonal ? extensaoDe((dadosDe(poligonal) || {}).features) : null;
    if (!ext) ext = extensaoDe(estado.camadas.filter((rt) => rt.visivel).flatMap((rt) => rt.features));
    estado.extensaoInicial = ext;
    if (ext) map.fitBounds(ext, { paddingTopLeft: [30, 30], paddingBottomRight: [70, 40] });

    renderArvore();
    renderLegenda();
    ligarEventosMapa();
    atualizarStatus(map.getCenter());

    const n = estado.camadas.filter((rt) => dadosDe(rt)).length;
    $('#rodapeContagem').textContent = `${n} de ${estado.camadas.length} camadas com dados`;

    const tela = $('#carregando');
    tela.classList.add('sumindo');
    setTimeout(() => { tela.hidden = true; }, 400);
  }

  async function iniciar() {
    $('#tituloApp').textContent = CFG.titulo;
    $('#subtituloApp').textContent = CFG.subtitulo;
    if (CFG.orgao) { $('#orgao1').textContent = CFG.orgao.linha1; $('#orgao2').textContent = CFG.orgao.linha2; }
    // O painel de camadas sempre inicia aberto, para o público saber onde ligar as camadas
    document.body.classList.remove('painel-oculto');

    montarHorizontes();
    montarSeletorBase();
    trocarBase(estado.base);
    ligarInterface();
    ligarEst();
    aplicarTema(armazenamento.ler('tema', 'claro'), true);

    $('#btnPasta').addEventListener('click', () => $('#entradaPasta').click());
    $('#btnArquivos').addEventListener('click', () => $('#entradaArquivos').click());
    $('#entradaPasta').addEventListener('change', (e) => carregarDeArquivos(e.target.files));
    $('#entradaArquivos').addEventListener('change', (e) => carregarDeArquivos(e.target.files));

    const ok = await carregarDados();
    if (ok) iniciarAplicacao();
    else {
      $('#progressoBox').hidden = true;
      $('#semDados').hidden = false;
    }
  }

  iniciar();
})();
