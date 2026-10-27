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
  // Demais fusos UTM do Brasil (SIRGAS 2000, WGS 84 e SAD69) e Córrego Alegre, para arquivos enviados em "Minha área"
  for (let z = 17; z <= 25; z++) {
    if (!proj4.defs(`EPSG:${31960 + z}`)) proj4.defs(`EPSG:${31960 + z}`, `+proj=utm +zone=${z} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs +type=crs`);
    if (!proj4.defs(`EPSG:${32700 + z}`)) proj4.defs(`EPSG:${32700 + z}`, `+proj=utm +zone=${z} +south +datum=WGS84 +units=m +no_defs +type=crs`);
    if (!proj4.defs(`EPSG:${29170 + z}`)) proj4.defs(`EPSG:${29170 + z}`, `+proj=utm +zone=${z} +south +ellps=aust_SA +towgs84=-67.35,3.88,-38.22,0,0,0,0 +units=m +no_defs +type=crs`);
  }
  proj4.defs('EPSG:22523', '+proj=utm +zone=23 +south +ellps=intl +towgs84=-205.57,168.77,-4.12,0,0,0,0 +units=m +no_defs +type=crs');
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
    'pn-minha-area': 468,
    'pn-destaque': 470,
    'pn-medicao': 480
  };

  const CAMPOS_ROTULO = ['Nome', 'Município', 'Unidade da Federação', 'Arrendatário', 'Identificação', 'Trecho',
    'Tipo da Instalação', 'Identificador do Berço', 'Número de Identificação', 'Legenda', 'Linha', 'Tipo de Área', 'Anexo'];

  // Identificadores técnicos (Id, id, ID, FID, OBJECTID, Id_1…) ficam ocultos na interface.
  // Campos com significado, como "Identificação" ou "Identificador do Berço", não casam com este padrão.
  const CAMPO_TECNICO = /^(id|fid|objectid|gid|ogc_fid)(_\d+)?$/i;
  const camposVisiveis = (props) => Object.keys(props).filter((k) => !CAMPO_TECNICO.test(k.trim()));

  /* ------------------------------------------------------------------
     Estado na URL (hash): horizonte, camadas ligadas, mapa de fundo, vista e comparação.
     Ex.: #h=curto&c=poligonal,afetas&b=satelite&v=14.25/-22.8851/-43.2004&cmp=longo
     O localStorage guarda só preferências de exibição (tema, rótulos, legenda, estilo da poligonal).
     ------------------------------------------------------------------ */
  function lerUrl() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    const v = (p.get('v') || '').split('/').map(Number);
    return {
      h: p.get('h'),
      c: p.has('c') ? p.get('c').split(',').filter(Boolean) : null,
      b: p.get('b'),
      vista: v.length === 3 && v.every(Number.isFinite) ? { zoom: v[0], centro: [v[1], v[2]] } : null,
      cmp: p.get('cmp')
    };
  }
  const URL_INICIAL = lerUrl();
  const ADMIN = new URLSearchParams(location.search).has('admin');

  /* ------------------------------------------------------------------
     Estado
     ------------------------------------------------------------------ */
  const estado = {
    horizonte: URL_INICIAL.h || CFG.horizontes[0].id,
    // Sem link, o mapa abre no fundo padrão (satélite)
    base: URL_INICIAL.b || CFG.baseInicial || CFG.basemaps[0].id,
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
    rotulos: armazenamento.ler('rotulos', false),            // rótulos no mapa (padrão: desligados)
    rotulosCamadas: armazenamento.ler('rotulosCamadas', {}), // { idCamada: true|false } escolha por camada no menu ⋯
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

  // crsForcado: sistema informado à parte (ex.: .prj de um shapefile enviado pelo usuário)
  function preparar(gj, crsForcado) {
    // Dados do geoportal já vêm em WGS 84 (gerar_dados.py); a detecção fica para arquivos externos
    const crs = gj.wgs84 ? null : (crsForcado || detectarCRS(gj));
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
    return { type: 'FeatureCollection', features, crsOrigem: gj.crsOrigem || crs || 'EPSG:4326 (CRS84)' };
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
     gerar_dados.py grava em assets/js/dados/ um arquivo comum (camadas sem horizonte),
     um por horizonte e o indice.js (tamanhos, versões e resumo). O site abre com o comum
     e o horizonte escolhido; os demais horizontes são baixados só quando necessários.
     ------------------------------------------------------------------ */
  const PASTA_DADOS = 'assets/js/dados/';
  const INDICE = window.GEOPORTAL_INDICE || null;
  const partesProntas = new Set();
  const partesEmCurso = new Map();
  const viaRede = () => /^https?:$/.test(location.protocol) && !!window.fetch && !!window.ReadableStream;
  // Arquivos de dados existentes (nomes normalizados), para contar camadas sem preparar os dados
  const arquivosDoIndice = new Set(INDICE ? Object.keys(INDICE.arquivos).map(chave) : []);

  function registrarPacote() {
    const pacote = window.GEOPORTAL_DADOS || {};
    Object.keys(pacote).forEach((k) => { registrarBruto(k, pacote[k]); delete pacote[k]; });
  }

  function executarScript(texto) {
    const s = document.createElement('script');
    s.text = texto;
    document.head.appendChild(s);
    s.remove();
  }

  function incluirScript(url) {
    return new Promise((ok, falha) => {
      const s = document.createElement('script');
      s.src = url;
      s.onload = () => { s.remove(); ok(); };
      s.onerror = () => { s.remove(); falha(new Error(`Falha ao carregar ${url}`)); };
      document.head.appendChild(s);
    });
  }

  // Baixa lendo o fluxo aos pedaços, para mostrar o progresso real em bytes
  async function baixarComProgresso(url, aoReceber) {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status} em ${url}`);
    const leitor = resp.body.getReader();
    const pedacos = [];
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      pedacos.push(value);
      aoReceber(value.length);
    }
    return new TextDecoder('utf-8').decode(await new Blob(pedacos).arrayBuffer());
  }

  // parte: 'comum' ou o id de um horizonte ('atual', 'curto'…). Aberto direto do disco (file://), usa <script>.
  function carregarParte(parte, aoReceber = () => {}) {
    if (!INDICE || partesProntas.has(parte)) return Promise.resolve();
    if (partesEmCurso.has(parte)) return partesEmCurso.get(parte);
    const info = INDICE.partes[parte];
    if (!info) { partesProntas.add(parte); return Promise.resolve(); } // horizonte sem arquivos
    const url = `${PASTA_DADOS}${info.arquivo}?v=${info.hash}`;
    const p = (viaRede()
      ? baixarComProgresso(url, aoReceber).then(executarScript).catch(() => incluirScript(url))
      : incluirScript(url))
      .then(() => { registrarPacote(); partesProntas.add(parte); partesEmCurso.delete(parte); })
      .catch((e) => { partesEmCurso.delete(parte); throw e; });
    partesEmCurso.set(parte, p);
    return p;
  }

  const horizonteCarregado = (h) => !INDICE || partesProntas.has(h);
  const todosHorizontesCarregados = () => CFG.horizontes.every((h) => horizonteCarregado(h.id));

  // Novos dados de outro horizonte: refaz as categorias de cor e a verificação do campo de perfil
  function aposCarregarHorizonte() {
    estado.camadas.forEach((rt) => { calcularCategorias(rt); delete rt.temPerfil; });
  }

  function carregarTodosHorizontes() {
    return Promise.all(CFG.horizontes.map((h) => carregarParte(h.id))).then(aposCarregarHorizonte);
  }

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
    if (INDICE) {
      const partes = ['comum', estado.horizonte];
      const total = partes.reduce((s, p) => s + ((INDICE.partes[p] || {}).bytes || 0), 0);
      const mb = (b) => NF1.format(b / 1048576);
      let recebidos = 0, prontas = 0;
      progresso(0, 1, `Carregando dados (0 de ${mb(total)} MB)…`);
      try {
        await Promise.all(partes.map((p) => carregarParte(p, (n) => {
          recebidos = Math.min(total, recebidos + n);
          progresso(recebidos, total, `Carregando dados (${mb(recebidos)} de ${mb(total)} MB)…`);
        }).then(() => {
          prontas++;
          if (!viaRede()) progresso(prontas, partes.length, `Carregando dados (${prontas} de ${partes.length} partes)…`);
        })));
        progresso(1, 1, 'Preparando o mapa…');
        return true;
      } catch (e) {
        console.error('Falha ao carregar os dados:', e);
        return false;
      }
    }
    // Sem índice: formato antigo (um dados.js) ou .geojson soltos servidos pelo mesmo endereço
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
  map.getPane('pn-minha-area').style.pointerEvents = 'none';

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
    const b = CFG.basemaps.find((x) => x.id === id);
    $('#baseAtualImg').src = b.miniatura;
    $('#baseAtualNome').textContent = b.nome;
    $$('.base-card').forEach((el) => el.setAttribute('aria-checked', String(el.dataset.base === id)));
    document.body.dataset.base = id;
    atualizarUrl();
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
  const OPACIDADE_PREENCHIMENTO = CFG.opacidadePadrao ?? 0.45; // preenchimento sólido padrão (config.js)
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

  /* Estilo personalizado pelo usuário (camadas com "personalizavel"): cor, opacidade e largura do traço.
     O halo ("contorno") acompanha a largura escolhida, mantendo a mesma folga do padrão. */
  const CHAVE_PERS = (rt) => `estilo:${rt.cfg.id}`;
  function estiloDe(rt) {
    const e = rt.cfg.estilo;
    const p = rt.pers;
    if (!rt.cfg.personalizavel || !p) return e;
    const folga = e.contorno ? e.contorno.espessura - e.espessura : 0;
    return Object.assign({}, e, {
      cor: p.cor, espessura: p.largura, opacidadeTraco: p.opacidade,
      contorno: e.contorno ? Object.assign({}, e.contorno, { espessura: p.largura + folga }) : undefined
    });
  }
  const padraoPers = (rt) => ({ cor: rt.cfg.estilo.cor, opacidade: 1, largura: rt.cfg.estilo.espessura });

  function coresFeicao(rt, f) {
    const e = estiloDe(rt);
    if (rt.cats) {
      const c = rt.cats.get(valorCategoria(f, rt.cfg.categorias.campo)) || '#94a3b8';
      return { traco: c, preench: c };
    }
    const preench = e.preenchimento || e.cor;
    // tracoProprio: linha com cor própria (ex.: limites escuros com preenchimento claro)
    if (poligonoPreenchido(rt) && !e.tracoProprio) return { traco: e.padrao ? e.padrao.cor : preench, preench };
    return { traco: e.cor, preench };
  }

  function estiloFeicao(rt, f, realce) {
    const e = estiloDe(rt);
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
      color: traco, weight: esp + extra, opacity: e.opacidadeTraco ?? 1,
      dashArray: e.tracejado || null, lineJoin: 'round',
      fill: !semPreench,
      fillColor: e.padrao ? `url(#pad-${rt.cfg.id})` : preench,
      fillOpacity: Math.min(1, fo + (realce && !e.padrao && preenchido ? 0.15 : 0)) * op
    };
  }

  function estiloContorno(rt) {
    const e = estiloDe(rt);
    const c = e.contorno;
    const opacidade = rt.cfg.tipo === 'linha' ? rt.opacidade * 0.95 : 0.95 * (e.opacidadeTraco ?? 1);
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
    const e = estiloDe(rt);
    if (rt.cfg.tipo === 'linha') {
      const larg = Math.min(e.espessura || 2, 4.5);
      const cont = e.contorno ? `<path d="M3 11h22" stroke="${e.contorno.cor}" stroke-width="${Math.min(e.contorno.espessura, 7.5)}" stroke-linecap="round" fill="none"/>` : '';
      const dash = e.tracejado ? `stroke-dasharray="${e.tracejado.split(/\s+/).map((v) => Math.max(1, v * 0.6)).join(' ')}"` : '';
      return `<svg class="simb" viewBox="0 0 28 22" aria-hidden="true">${cont}<path d="M3 11h22" stroke="${e.cor}" stroke-width="${larg}" ${dash} stroke-linecap="${e.lineCap || 'round'}" fill="none"/></svg>`;
    }
    let preench = e.preenchimento || e.cor;
    let traco = poligonoPreenchido(rt) && !e.tracoProprio ? (e.padrao ? e.padrao.cor : preench) : e.cor;
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
        chaveConstruida: null,
        pers: null
      };
      if (cfg.personalizavel) rt.pers = armazenamento.ler(CHAVE_PERS(rt), null);
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
    const d = dadosDe(rt);
    rt.features = d ? d.features.filter((f) => passaFiltro(rt, f)) : [];
    rt.chaveConstruida = chave(arquivoDe(rt)) + '#' + assinaturaFiltro(rt);
    rt.geo = montarGrupo(rt, rt.features, paneDe(rt), rt.grupo);
  }

  // Desenha as feições no grupo (halo opcional + camada principal); devolve a camada principal
  function montarGrupo(rt, features, pane, grupo) {
    grupo.clearLayers();
    if (!features.length) return null;
    const colecao = { type: 'FeatureCollection', features };
    if (rt.cfg.estilo.contorno) {
      L.geoJSON(colecao, { pane, interactive: false, style: () => estiloContorno(rt) }).addTo(grupo);
    }
    return L.geoJSON(colecao, {
      pane,
      style: (f) => estiloFeicao(rt, f),
      onEachFeature: (f, lyr) => {
        if (!rt.cfg.semTooltip) {
          lyr.bindTooltip(() => `<span class="tt-camada">${esc(rt.cfg.nome)}</span><span class="tt-texto">${esc(rotuloDe(rt, f))}</span>`,
            { sticky: true, direction: 'top', offset: [0, -12], className: 'gp-tooltip', opacity: 1 });
        }
        lyr.on('mouseover', () => { if (!estado.medicao) lyr.setStyle(estiloFeicao(rt, f, true)); });
        lyr.on('mouseout', () => lyr.setStyle(estiloFeicao(rt, f)));
      }
    }).addTo(grupo);
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
    if (rt.grupoB) atualizarCamadaB(rt);
  }

  function aplicarOpacidade(rt) {
    [[rt.grupo, rt.geo], [rt.grupoB, rt.geoB]].forEach(([grupo, geo]) => {
      if (!grupo) return;
      grupo.eachLayer((l) => {
        if (l === geo) l.setStyle((f) => estiloFeicao(rt, f));
        else l.setStyle(() => estiloContorno(rt));
      });
    });
  }

  /* ------------------------------------------------------------------
     Ordem de desenho: cada camada tem o próprio "pane" do Leaflet.
     O z-index segue estado.ordemDesenho (de baixo para cima), que o
     usuário pode alterar com "Para frente" / "Para trás".
     ------------------------------------------------------------------ */
  const Z_BASE_CAMADAS = 401; // acima dos mapas de fundo e abaixo do destaque (470)
  const paneDe = (rt) => `pn-c-${rt.cfg.id}`;
  const paneB = (rt) => `pn-cb-${rt.cfg.id}`;

  function ordemPadrao() {
    return estado.camadas.slice()
      .sort((a, b) => ((PANES[a.cfg.painel] || 430) - (PANES[b.cfg.painel] || 430)) || (a.ordem - b.ordem))
      .map((rt) => rt.cfg.id);
  }

  function criarPanesCamadas() {
    const padrao = ordemPadrao();
    const salva = armazenamento.ler('ordemDesenho', null);
    const valida = Array.isArray(salva) && salva.length === padrao.length && padrao.every((id) => salva.includes(id));
    estado.ordemDesenho = valida ? salva : padrao;
    estado.camadas.forEach((rt) => {
      if (!map.getPane(paneDe(rt))) map.createPane(paneDe(rt));
      // Lado direito da comparação de horizontes: pane próprio, recortado separadamente
      if (rt.cfg.horizonte && !map.getPane(paneB(rt))) map.createPane(paneB(rt));
    });
    aplicarOrdemDesenho();
  }

  function aplicarOrdemDesenho() {
    estado.ordemDesenho.forEach((id, i) => {
      map.getPane(`pn-c-${id}`).style.zIndex = Z_BASE_CAMADAS + i;
      const b = map.getPane(`pn-cb-${id}`);
      if (b) b.style.zIndex = Z_BASE_CAMADAS + i;
    });
    const personalizada = estado.ordemDesenho.join() !== ordemPadrao().join();
    $('#btnOrdemPadrao').hidden = !personalizada;
  }

  function moverCamada(rt, direcao) {
    const ordem = estado.ordemDesenho;
    const i = ordem.indexOf(rt.cfg.id);
    // Próxima camada LIGADA na direção pedida (camadas desligadas não contam)
    let j = i + direcao;
    while (j >= 0 && j < ordem.length && !estado.porId.get(ordem[j]).visivel) j += direcao;
    if (j < 0 || j >= ordem.length) {
      aviso(direcao > 0 ? 'Esta camada já está na frente das camadas ligadas.' : 'Esta camada já está atrás das camadas ligadas.');
      return;
    }
    const vizinha = estado.porId.get(ordem[j]);
    ordem.splice(i, 1);
    ordem.splice(ordem.indexOf(vizinha.cfg.id) + (direcao > 0 ? 1 : 0), 0, rt.cfg.id);
    armazenamento.gravar('ordemDesenho', ordem);
    aplicarOrdemDesenho();
    aviso(`"${rt.cfg.nome}" agora aparece ${direcao > 0 ? 'acima' : 'abaixo'} de "${vizinha.cfg.nome}".`, 3200);
  }

  function restaurarOrdemDesenho() {
    estado.ordemDesenho = ordemPadrao();
    armazenamento.gravar('ordemDesenho', null);
    aplicarOrdemDesenho();
    aviso('Ordem padrão das camadas restaurada.');
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

  // Folgas para enquadrar feições sem ficarem atrás dos painéis flutuantes
  function margensMapa() {
    const corpo = document.body.classList;
    const telaLarga = map.getSize().x > 900;
    const topo = $('.topo').offsetHeight + 24;
    const esquerda = telaLarga && !corpo.contains('painel-oculto') ? $('#painel').getBoundingClientRect().right + 24 : 40;
    let direita = 70;
    if (estado.estAberto && telaLarga) direita += $('#painelEst').offsetWidth + 12;
    if (corpo.contains('info-aberta') && telaLarga) direita += 378;
    const baixo = $('#tabela').hidden ? 50 : Math.min($('#tabela').offsetHeight + 40, map.getSize().y * 0.6);
    return { paddingTopLeft: [esquerda, topo], paddingBottomRight: [direita, baixo] };
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
        <div class="camada-opcoes">
          ${rt.cfg.personalizavel ? controlesPersonalizacao(rt) : `
          <div class="opacidade">
            <span>${rotuloOpacidade}</span>
            <input type="range" min="0" max="100" step="5" value="${op}" data-acao="opacidade" aria-label="${rotuloOpacidade} de ${esc(rt.cfg.nome)}">
            <output>${op}%</output>
          </div>`}
          <label class="pers-linha rotulo-opcao">
            <input type="checkbox" data-acao="rotulo-camada" ${rotuloLigado(rt) ? 'checked' : ''}>
            <span>Mostrar rótulos desta camada <small>(com "Rótulos" ligado, a partir do zoom ${zoomRotulo(rt)})</small></span>
          </label>
          <div class="camada-botoes">
            <button type="button" data-acao="ordem-frente" title="Desenhar acima da próxima camada ligada">↑ Para frente</button>
            <button type="button" data-acao="ordem-tras" title="Desenhar abaixo da camada ligada anterior">↓ Para trás</button>
            <button type="button" data-acao="camada-zoom" ${d ? '' : 'disabled'}>${icone('focus')}Aproximar</button>
            <button type="button" data-acao="camada-tabela" ${d ? '' : 'disabled'}>${icone('table')}Tabela</button>
            <button type="button" data-acao="camada-baixar" ${d ? '' : 'disabled'}>${icone('download')}GeoJSON</button>
          </div>
        </div>
      </div>`;
  }

  // Controles de cor, opacidade e largura do traço (camadas "personalizavel", ex.: poligonal)
  function controlesPersonalizacao(rt) {
    const p = rt.pers || padraoPers(rt);
    const op = Math.round(p.opacidade * 100);
    return `
      <div class="pers">
        <label class="pers-linha"><span>Cor do traço</span>
          <input type="color" value="${esc(p.cor)}" data-acao="pers-cor" aria-label="Cor do traço de ${esc(rt.cfg.nome)}"></label>
        <label class="opacidade"><span>Opacidade</span>
          <input type="range" min="10" max="100" step="5" value="${op}" data-acao="pers-op" aria-label="Opacidade do traço de ${esc(rt.cfg.nome)}">
          <output>${op}%</output></label>
        <label class="opacidade"><span>Largura</span>
          <input type="range" min="1" max="8" step="0.5" value="${p.largura}" data-acao="pers-larg" aria-label="Largura do traço de ${esc(rt.cfg.nome)}">
          <output>${NF1.format(p.largura)} px</output></label>
        <button type="button" class="link" data-acao="pers-reset">Restaurar padrão</button>
      </div>`;
  }

  function atualizarPersonalizacao(rt, elCamada) {
    armazenamento.gravar(CHAVE_PERS(rt), rt.pers);
    aplicarOpacidade(rt); // reaplica o estilo do traço e do halo
    const s = elCamada && elCamada.querySelector('.camada-linha .simb');
    if (s) s.outerHTML = simbolo(rt);
    renderLegenda();
  }

  /* ------------------------------------------------------------------
     Legenda flutuante: cores das categorias (perfis de carga) das camadas ligadas.
     Estados: 'aberta' | 'minimizada' | 'fechada' (salvo no navegador).
     ------------------------------------------------------------------ */
  function estadoLegendaFlutuante() {
    return armazenamento.ler('legendaFlutuante', window.matchMedia('(max-width: 720px)').matches ? 'minimizada' : 'aberta');
  }

  function renderLegendaFlutuante() {
    const card = $('#legendaFlutuante'), reabrir = $('#btnReabrirLegenda');
    // Junta as categorias presentes em todas as camadas ligadas (as cores são as mesmas em todas)
    const camadas = [], cores = new Map();
    estado.camadas.forEach((rt) => {
      if (!rt.visivel || !rt.cats || !dadosDe(rt)) return;
      const presentes = new Set(feicoesFiltradas(rt).map((f) => valorCategoria(f, rt.cfg.categorias.campo)));
      const itens = [...rt.cats.entries()].filter(([v]) => presentes.has(v));
      if (!itens.length) return;
      camadas.push(rt.cfg.nome);
      itens.forEach(([v, c]) => cores.set(v, c));
    });
    if (cores.size < 2) { card.hidden = true; reabrir.hidden = true; return; } // uma só cor não precisa de legenda
    const st = estadoLegendaFlutuante();
    card.hidden = st === 'fechada';
    reabrir.hidden = st !== 'fechada';
    card.classList.toggle('minimizada', st === 'minimizada');
    $('#btnMinLegenda').setAttribute('aria-expanded', String(st !== 'minimizada'));
    $('#legFlutCorpo').innerHTML =
      `<ul>${[...cores.entries()].map(([v, c]) => `<li><span class="amostra" style="--c:${c}"></span>${esc(v)}</li>`).join('')}</ul>
       <p class="lf-camadas">${camadas.length === 1 ? 'Camada' : 'Camadas'}: ${camadas.map(esc).join(', ')}</p>`;
  }

  function mudarLegendaFlutuante(st) {
    armazenamento.gravar('legendaFlutuante', st);
    renderLegendaFlutuante();
    if (st === 'fechada') $('#btnReabrirLegenda').focus();
    if (st === 'aberta' && document.activeElement === $('#btnReabrirLegenda')) $('#btnMinLegenda').focus();
  }

  /* ------------------------------------------------------------------
     Rótulos das feições (nomes no mapa). Desligados por padrão.
     Aparecem a partir de um zoom mínimo por camada, com detecção simples de
     colisão (feições maiores têm prioridade) e sem capturar cliques.
     ------------------------------------------------------------------ */
  const ZOOM_ROTULO_GRUPO = { ref: 9, zon: 15, inst: 16, aqua: 13, terr: 13, amb: 14 };
  const MAX_ROTULOS = 160;
  const CARACTERES_POR_LINHA = 22;
  const MAX_LINHAS_ROTULO = 3;
  const ancoras = new WeakMap();

  // Quebra o nome em linhas curtas (sem cortar palavras); só abrevia se passar de MAX_LINHAS_ROTULO
  function quebrarRotulo(txt) {
    const linhas = [];
    txt.split(/\s+/).forEach((p) => {
      const ult = linhas[linhas.length - 1];
      if (ult !== undefined && (ult + ' ' + p).length <= CARACTERES_POR_LINHA) linhas[linhas.length - 1] = ult + ' ' + p;
      else linhas.push(p);
    });
    if (linhas.length > MAX_LINHAS_ROTULO) {
      linhas.length = MAX_LINHAS_ROTULO;
      linhas[MAX_LINHAS_ROTULO - 1] = linhas[MAX_LINHAS_ROTULO - 1].replace(/[\s,;:.(–-]+$/, '') + '…';
    }
    return linhas;
  }
  let elRotulos = null;

  const zoomRotulo = (rt) => rt.cfg.rotuloZoom ?? ZOOM_ROTULO_GRUPO[rt.cfg.grupo] ?? 14;
  // Escolha do usuário no menu ⋯; sem escolha, vale "rotuloPadrao" do config.js (padrão: ligado)
  const rotuloLigado = (rt) => estado.rotulosCamadas[rt.cfg.id] ?? (rt.cfg.rotuloPadrao !== false);

  function areaAnel(anel) {
    let a = 0;
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) a += (anel[j][0] + anel[i][0]) * (anel[j][1] - anel[i][1]);
    return Math.abs(a / 2);
  }

  // Ponto de ancoragem: centroide do maior polígono (ou, se cair fora, o meio da faixa interna mais larga);
  // em linhas, o ponto médio da parte mais longa
  function ancoraDe(f) {
    if (ancoras.has(f)) return ancoras.get(f);
    const g = f.geometry;
    let p = null;
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const polis = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      const maior = polis.reduce((m, pg) => (areaAnel(pg[0]) > areaAnel(m[0]) ? pg : m), polis[0]);
      const anel = maior[0];
      let cx = 0, cy = 0, a = 0;
      for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
        const k = anel[j][0] * anel[i][1] - anel[i][0] * anel[j][1];
        a += k; cx += (anel[j][0] + anel[i][0]) * k; cy += (anel[j][1] + anel[i][1]) * k;
      }
      if (a) { cx /= 3 * a; cy /= 3 * a; } else { cx = anel[0][0]; cy = anel[0][1]; }
      if (!pontoNoPoligono(maior, cx, cy)) {
        const xs = [];
        for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
          const [x1, y1] = anel[j], [x2, y2] = anel[i];
          if ((y1 > cy) !== (y2 > cy)) xs.push(x1 + ((cy - y1) * (x2 - x1)) / (y2 - y1));
        }
        xs.sort((u, v) => u - v);
        let melhor = 0;
        for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > melhor) { melhor = xs[i + 1] - xs[i]; cx = (xs[i] + xs[i + 1]) / 2; }
      }
      p = L.latLng(cy, cx);
    } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
      const linhas = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      const comp = (l) => l.reduce((s, c, i) => (i ? s + Math.hypot(c[0] - l[i - 1][0], c[1] - l[i - 1][1]) : 0), 0);
      const l = linhas.reduce((m, x) => (comp(x) > comp(m) ? x : m), linhas[0]);
      let falta = comp(l) / 2;
      for (let i = 1; i < l.length; i++) {
        const d = Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
        if (d >= falta) { const t = d ? falta / d : 0; p = L.latLng(l[i - 1][1] + t * (l[i][1] - l[i - 1][1]), l[i - 1][0] + t * (l[i][0] - l[i - 1][0])); break; }
        falta -= d;
      }
    }
    ancoras.set(f, p);
    return p;
  }

  function desenharRotulos() {
    if (!elRotulos) return;
    if (!estado.rotulos) { elRotulos.innerHTML = ''; return; }
    const z = map.getZoom();
    const lim = map.getBounds().pad(0.05);
    const candidatos = [];
    estado.camadas.forEach((rt) => {
      if (!rt.visivel || !map.hasLayer(rt.grupo) || !rotuloLigado(rt) || z < zoomRotulo(rt)) return;
      rt.features.forEach((f) => {
        const bb = f._bbox;
        if (bb[2] < lim.getWest() || bb[0] > lim.getEast() || bb[3] < lim.getSouth() || bb[1] > lim.getNorth()) return;
        const a = ancoraDe(f);
        if (!a || !lim.contains(a)) return;
        const p1 = map.latLngToLayerPoint([bb[1], bb[0]]), p2 = map.latLngToLayerPoint([bb[3], bb[2]]);
        const larg = Math.abs(p2.x - p1.x), alt = Math.abs(p2.y - p1.y);
        // Linhas: prioridade pelo comprimento; polígonos: pela área na tela (muito pequenos ficam sem rótulo)
        const prioridade = rt.cfg.tipo === 'linha' ? Math.max(larg, alt) * 40 : larg * alt;
        if (rt.cfg.tipo !== 'linha' && prioridade < 700) return;
        const linhas = quebrarRotulo(String(rotuloDe(rt, f)).trim());
        if (!linhas[0]) return;
        candidatos.push({ pt: map.latLngToLayerPoint(a), linhas, prioridade });
      });
    });
    candidatos.sort((a, b) => b.prioridade - a.prioridade);
    const ocupados = [], html = [];
    for (const c of candidatos) {
      if (html.length >= MAX_ROTULOS) break;
      const w = Math.max(...c.linhas.map((l) => l.length)) * 6.6 + 10, h = c.linhas.length * 14 + 4;
      const caixa = [c.pt.x - w / 2, c.pt.y - h / 2, c.pt.x + w / 2, c.pt.y + h / 2];
      if (ocupados.some((o) => !(caixa[2] < o[0] || caixa[0] > o[2] || caixa[3] < o[1] || caixa[1] > o[3]))) continue;
      ocupados.push(caixa);
      html.push(`<span class="gp-rotulo" style="left:${Math.round(c.pt.x)}px;top:${Math.round(c.pt.y)}px">${c.linhas.map(esc).join('<br>')}</span>`);
    }
    elRotulos.innerHTML = html.join('');
  }

  function alternarRotulos() {
    estado.rotulos = !estado.rotulos;
    armazenamento.gravar('rotulos', estado.rotulos);
    sincronizarBotaoRotulos();
    desenharRotulos();
    if (estado.rotulos) {
      const z = map.getZoom();
      const algum = estado.camadas.some((rt) => rt.visivel && rotuloLigado(rt) && z >= zoomRotulo(rt));
      aviso(algum ? 'Rótulos ligados.' : 'Rótulos ligados. Ligue uma camada e aproxime o mapa para vê-los.', 3200);
    } else aviso('Rótulos desligados.');
  }

  function sincronizarBotaoRotulos() {
    const b = $('[data-ferr="rotulos"]');
    b.setAttribute('aria-pressed', String(estado.rotulos));
    b.classList.toggle('ativo', estado.rotulos);
    b.title = estado.rotulos ? 'Ocultar rótulos' : 'Mostrar rótulos (nomes das áreas no mapa)';
  }

  function criarCamadaRotulos() {
    const pane = map.createPane('pn-rotulos');
    pane.style.zIndex = 465; // acima das camadas, abaixo do destaque
    pane.style.pointerEvents = 'none';
    elRotulos = L.DomUtil.create('div', 'gp-rotulos', pane);
    map.on('zoomstart', () => { elRotulos.style.visibility = 'hidden'; });
    map.on('zoomend', () => { elRotulos.style.visibility = ''; });
    map.on('moveend', desenharRotulos);
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
      } else if (rt && acao.startsWith('pers-')) {
        rt.pers = Object.assign(padraoPers(rt), rt.pers);
        if (acao === 'pers-cor') rt.pers.cor = alvo.value;
        if (acao === 'pers-op') { rt.pers.opacidade = Number(alvo.value) / 100; alvo.nextElementSibling.textContent = `${alvo.value}%`; }
        if (acao === 'pers-larg') { rt.pers.largura = Number(alvo.value); alvo.nextElementSibling.textContent = `${NF1.format(rt.pers.largura)} px`; }
        atualizarPersonalizacao(rt, elCamada);
      }
      return;
    }
    if (e.type === 'change') {
      if (acao === 'camada-chk' && rt) {
        definirVisibilidade(rt, alvo.checked);
        aposMudarVisibilidade();
      } else if (acao === 'rotulo-camada' && rt) {
        estado.rotulosCamadas[rt.cfg.id] = alvo.checked;
        armazenamento.gravar('rotulosCamadas', estado.rotulosCamadas);
        desenharRotulos();
        if (alvo.checked && !estado.rotulos) aviso('Ligue o botão "Rótulos" na barra de ferramentas para ver os nomes no mapa.', 3600);
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
      case 'ordem-frente':
        if (!rt.visivel) { aviso('Ligue a camada para mudar a ordem dela no mapa.'); break; }
        moverCamada(rt, +1);
        break;
      case 'ordem-tras':
        if (!rt.visivel) { aviso('Ligue a camada para mudar a ordem dela no mapa.'); break; }
        moverCamada(rt, -1);
        break;
      case 'pers-reset':
        rt.pers = null;
        armazenamento.gravar(CHAVE_PERS(rt), null);
        aplicarOpacidade(rt);
        renderArvore();
        renderLegenda();
        aviso('Estilo padrão restaurado.');
        break;
    }
  }

  function aposMudarVisibilidade() {
    renderArvore();
    renderLegenda();
    atualizarUrl();
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

  // Chamado sempre que camadas, horizonte ou filtros mudam: atualiza também a legenda flutuante e os rótulos
  function renderLegenda() {
    $('#legenda').innerHTML = htmlLegenda() + htmlLegendaMinhaArea();
    renderLegendaFlutuante();
    desenharRotulos();
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

  async function mudarHorizonte(id) {
    if (id === estado.horizonte) return;
    if (estado.iniciado && !horizonteCarregado(id)) {
      const nome = CFG.horizontes.find((h) => h.id === id).nome;
      aviso(`Carregando ${nome}…`, 15000);
      try { await carregarParte(id); aposCarregarHorizonte(); }
      catch (e) { aviso('Não foi possível carregar este horizonte. Verifique a conexão e tente de novo.', 4000); return; }
    }
    if (id === estado.horizonte) return; // outro clique chegou antes
    estado.horizonte = id;
    atualizarUrl();
    $$('#horizontes button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.h === id)));
    if (!estado.iniciado) return;
    estado.camadas.filter((rt) => rt.cfg.horizonte).forEach(atualizarCamada);
    fecharInfo();
    renderArvore();
    renderLegenda();
    if (estado.tabela && estado.tabela.rt.cfg.horizonte) renderTabela();
    if ($('#campoPesquisa').value.trim()) pesquisar();
    renderEst();
    if (comparacao.ativa) atualizarTextosComparacao();
    aviso(`Horizonte de planejamento: ${horizonteAtual().nome}`);
  }

  /* ------------------------------------------------------------------
     Comparação de horizontes (cortina)
     As camadas com horizonte são desenhadas duas vezes: o horizonte escolhido no topo
     fica à esquerda e o escolhido na barra de comparação, à direita. Cada lado tem
     o próprio pane, recortado na posição da divisória (arrastável ou pelo teclado).
     ------------------------------------------------------------------ */
  const comparacao = { ativa: false, h: null, x: 0.5 };
  const EVENTOS_CORTINA = 'move zoom zoomend resize viewreset';
  const nomeHorizonte = (id) => (CFG.horizontes.find((h) => h.id === id) || {}).nome || id;

  function atualizarCamadaB(rt) {
    if (!rt.cfg.horizonte) return;
    if (!rt.grupoB) rt.grupoB = L.featureGroup();
    const d = comparacao.ativa && rt.visivel ? dadosDe(rt, comparacao.h) : null;
    if (!d) {
      if (map.hasLayer(rt.grupoB)) map.removeLayer(rt.grupoB);
      rt.featuresB = [];
      return;
    }
    const k = comparacao.h + '#' + assinaturaFiltro(rt);
    if (rt.chaveB !== k) {
      rt.featuresB = d.features.filter((f) => passaFiltro(rt, f));
      rt.geoB = montarGrupo(rt, rt.featuresB, paneB(rt), rt.grupoB);
      rt.chaveB = k;
    }
    if (!map.hasLayer(rt.grupoB)) rt.grupoB.addTo(map);
  }

  // Recorta os panes: horizonte do topo à esquerda da divisória, horizonte comparado à direita
  function recortarComparacao() {
    const camadasH = estado.camadas.filter((rt) => rt.cfg.horizonte);
    if (!comparacao.ativa) {
      camadasH.forEach((rt) => { map.getPane(paneDe(rt)).style.clip = ''; map.getPane(paneB(rt)).style.clip = ''; });
      return;
    }
    const tam = map.getSize();
    const xTela = Math.round(tam.x * comparacao.x);
    const nw = map.containerPointToLayerPoint([0, 0]);
    const se = map.containerPointToLayerPoint(tam);
    const x = nw.x + xTela;
    const esq = `rect(${nw.y}px, ${x}px, ${se.y}px, ${nw.x}px)`;
    const dir = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${x}px)`;
    camadasH.forEach((rt) => { map.getPane(paneDe(rt)).style.clip = esq; map.getPane(paneB(rt)).style.clip = dir; });
    $('#cortina').style.left = `${xTela}px`;
    const pct = Math.round(comparacao.x * 100);
    $('#cortinaAlca').setAttribute('aria-valuenow', String(pct));
    $('#cortinaAlca').setAttribute('aria-valuetext', `${pct}% da largura para ${nomeHorizonte(estado.horizonte)}`);
  }

  // Divisória no meio da parte do mapa que não fica atrás dos painéis
  function posicaoInicialCortina() {
    const m = map.getContainer().getBoundingClientRect();
    let esq = m.left, dir = m.right;
    if (!document.body.classList.contains('painel-oculto') && window.innerWidth > 900) esq = Math.max(esq, $('#painel').getBoundingClientRect().right);
    dir = Math.min(dir, $('#ferramentas').getBoundingClientRect().left);
    return Math.min(0.9, Math.max(0.1, ((esq + dir) / 2 - m.left) / m.width));
  }

  function atualizarTextosComparacao() {
    const esq = nomeHorizonte(estado.horizonte), dir = nomeHorizonte(comparacao.h);
    $('#cmpEsquerda').textContent = esq;
    $('#cortinaRotEsq').textContent = `‹ ${esq}`;
    $('#cortinaRotDir').textContent = `${dir} ›`;
    $('#cmpDireita').innerHTML = CFG.horizontes.map((h) =>
      `<option value="${h.id}"${h.id === comparacao.h ? ' selected' : ''}>${esc(h.nome)}</option>`).join('');
  }

  async function ativarComparacao(h) {
    const outro = (CFG.horizontes.find((x) => x.id === 'longo' && x.id !== estado.horizonte) ||
      CFG.horizontes.find((x) => x.id !== estado.horizonte)).id;
    h = h || comparacao.h || outro;
    if (!horizonteCarregado(h)) {
      aviso(`Carregando ${nomeHorizonte(h)}…`, 15000);
      try { await carregarParte(h); aposCarregarHorizonte(); }
      catch (e) { aviso('Não foi possível carregar este horizonte. Verifique a conexão e tente de novo.', 4000); return; }
    }
    const primeira = !comparacao.ativa;
    comparacao.ativa = true;
    comparacao.h = h;
    if (primeira) comparacao.x = posicaoInicialCortina();
    fecharInfo();
    estado.camadas.forEach(atualizarCamadaB);
    $('#barraComparar').hidden = false;
    $('#cortina').hidden = false;
    document.body.classList.add('comparando');
    const btn = $('[data-ferr="comparar"]');
    btn.setAttribute('aria-pressed', 'true');
    btn.classList.add('ativo');
    btn.title = 'Sair da comparação de horizontes';
    atualizarTextosComparacao();
    recortarComparacao();
    if (primeira) {
      map.on(EVENTOS_CORTINA, recortarComparacao);
      const temH = estado.camadas.some((rt) => rt.cfg.horizonte && rt.visivel);
      aviso(temH
        ? 'Arraste a divisória para comparar os dois horizontes.'
        : 'Ligue uma camada com etiqueta de horizonte (ex.: Áreas afetas) para ver a diferença entre os lados.', 5000);
    }
    atualizarUrl();
  }

  function sairComparacao() {
    if (!comparacao.ativa) return;
    comparacao.ativa = false;
    map.off(EVENTOS_CORTINA, recortarComparacao);
    estado.camadas.forEach(atualizarCamadaB);
    recortarComparacao();
    $('#barraComparar').hidden = true;
    $('#cortina').hidden = true;
    document.body.classList.remove('comparando');
    const btn = $('[data-ferr="comparar"]');
    btn.setAttribute('aria-pressed', 'false');
    btn.classList.remove('ativo');
    btn.title = 'Comparar dois horizontes lado a lado';
    fecharInfo();
    atualizarUrl();
  }

  function ligarComparacao() {
    const alca = $('#cortinaAlca');
    const mover = (clientX) => {
      const r = map.getContainer().getBoundingClientRect();
      comparacao.x = Math.min(0.98, Math.max(0.02, (clientX - r.left) / r.width));
      recortarComparacao();
    };
    alca.addEventListener('pointerdown', (e) => { e.preventDefault(); alca.focus(); alca.setPointerCapture(e.pointerId); alca.classList.add('arrastando'); });
    alca.addEventListener('pointermove', (e) => { if (alca.hasPointerCapture(e.pointerId)) mover(e.clientX); });
    const soltar = (e) => { if (alca.hasPointerCapture(e.pointerId)) alca.releasePointerCapture(e.pointerId); alca.classList.remove('arrastando'); };
    alca.addEventListener('pointerup', soltar);
    alca.addEventListener('pointercancel', soltar);
    alca.addEventListener('keydown', (e) => {
      const passo = e.shiftKey ? 0.1 : 0.02;
      const novo = { ArrowLeft: comparacao.x - passo, ArrowRight: comparacao.x + passo, Home: 0.02, End: 0.98 }[e.key];
      if (novo === undefined) return;
      e.preventDefault();
      comparacao.x = Math.min(0.98, Math.max(0.02, novo));
      recortarComparacao();
    });
    $('#cmpDireita').addEventListener('change', (e) => ativarComparacao(e.target.value));
    $('#btnSairComparar').addEventListener('click', sairComparacao);
    L.DomEvent.disableClickPropagation($('#barraComparar'));
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
    // Todo polígono responde ao clique no interior, inclusive os sem preenchimento visível (ex.: poligonal)
    switch (g.type) {
      case 'Polygon':
        return pontoNoPoligono(g.coordinates, x, y) || g.coordinates.some((a) => pertoDaLinha(a, p, tol));
      case 'MultiPolygon':
        return g.coordinates.some((pg) => pontoNoPoligono(pg, x, y)) ||
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

  // Feições clicáveis da camada: à direita da cortina, as camadas com horizonte usam o horizonte comparado
  const feicoesDoLado = (rt, ladoB) => (ladoB && rt.cfg.horizonte ? rt.featuresB || [] : (map.hasLayer(rt.grupo) ? rt.features : []));

  function camadasVisiveisOrdenadas(ladoB) {
    // Da camada desenhada por cima para a de baixo (segue a ordem escolhida pelo usuário)
    return estado.camadas
      .filter((rt) => rt.visivel && feicoesDoLado(rt, ladoB).length)
      .sort((a, b) => estado.ordemDesenho.indexOf(b.cfg.id) - estado.ordemDesenho.indexOf(a.cfg.id));
  }

  function identificar(ll) {
    const p = map.latLngToContainerPoint(ll);
    const tol = 7;
    const b = map.getBounds(), tam = map.getSize();
    const tolX = ((b.getEast() - b.getWest()) / tam.x) * tol;
    const tolY = ((b.getNorth() - b.getSouth()) / tam.y) * tol;
    const res = [];
    const ladoB = comparacao.ativa && p.x > tam.x * comparacao.x;
    camadasVisiveisOrdenadas(ladoB).forEach((rt) => {
      const doB = ladoB && !!rt.cfg.horizonte;
      feicoesDoLado(rt, ladoB).forEach((f) => {
        const bb = f._bbox;
        if (ll.lng < bb[0] - tolX || ll.lng > bb[2] + tolX || ll.lat < bb[1] - tolY || ll.lat > bb[3] + tolY) return;
        if (acerta(rt, f.geometry, ll, p, tol)) res.push({ rt, f, ladoB: doB });
      });
    });
    // Camadas de referência amplas (poligonal) vão para o fim da lista
    return res.filter((r) => !r.rt.cfg.identificarPorUltimo).concat(res.filter((r) => r.rt.cfg.identificarPorUltimo));
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
    const linhas = camposVisiveis(f.properties).map((k) =>
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
    // Na comparação, um clique à direita da divisória mostra o horizonte comparado
    const nomeH = res.some((r) => r.ladoB) ? nomeHorizonte(comparacao.h) : horizonteAtual().nome;
    $('#infoResumo').textContent = `${n} ${n === 1 ? 'feição encontrada' : 'feições encontradas'} · ${nomeH}`;
    $('#infoCorpo').innerHTML = res.map(({ rt, f, ladoB }, i) => {
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
              ${ladoB ? '' : `<button type="button" class="btn-sec" data-acao="card-tabela">${icone('table')}Ver na tabela</button>`}
            </div>
          </div>
        </article>`;
    }).join('');
    $('#infoCorpo').scrollTop = 0;
    abrirPainelInfo();
    destacar(res[0].f);
    // Anúncio curto para leitores de tela (o painel inteiro não é lido)
    $('#infoAnuncio').textContent = `${n} ${n === 1 ? 'feição encontrada' : 'feições encontradas'}: ` +
      `${rotuloDe(res[0].rt, res[0].f)}, ${res[0].rt.cfg.nome}${n > 1 ? ` e mais ${n - 1}` : ''}.`;
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
    document.body.classList.add('tabela-aberta'); // a legenda flutuante se esconde para não ficar sob a tabela
    renderTabela();
    if (uidSel) {
      const tr = $(`#tabelaRolagem tr[data-uid="${uidSel}"]`);
      if (tr) tr.scrollIntoView({ block: 'center' });
    }
  }

  function fecharTabela() {
    $('#tabela').hidden = true;
    document.body.classList.remove('tabela-aberta');
    estado.tabela = null;
  }

  function colunasDe(features) {
    const cols = [];
    features.forEach((f) => camposVisiveis(f.properties).forEach((k) => { if (!cols.includes(k)) cols.push(k); }));
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

  // Célula de CSV no padrão do Excel em português (ponto e vírgula, vírgula decimal)
  function celulaCsv(v) {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function baixarCSV() {
    const t = estado.tabela;
    if (!t) return;
    const { todas, feats } = linhasFiltradas();
    const cols = colunasDe(todas);
    const cel = celulaCsv;
    const linhas = [cols.map(cel).join(';')].concat(feats.map((f) => cols.map((c) => cel(f.properties[c])).join(';')));
    baixar(`${arquivoDe(t.rt)}.csv`, '﻿' + linhas.join('\r\n'), 'text/csv;charset=utf-8');
  }

  /* ------------------------------------------------------------------
     Pesquisa
     ------------------------------------------------------------------ */
  function textoDaFeicao(f) {
    let t = textoBusca.get(f);
    if (t === undefined) {
      t = semAcento(camposVisiveis(f.properties).map((k) => f.properties[k]).filter((v) => v !== null && v !== undefined).join(' | '));
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
        const campo = camposVisiveis(f.properties).map((k) => [k, f.properties[k]])
          .find(([, v]) => v !== null && v !== undefined && semAcento(v).includes(q));
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
    $$('.grupo-ferr button.ativo[data-ferr="distancia"], .grupo-ferr button.ativo[data-ferr="area"]').forEach((b) => b.classList.remove('ativo'));
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
     Minha área de interesse
     O usuário envia um arquivo (lido só no navegador, por leitor-geo.js) e o
     geoportal informa se a área fica dentro da poligonal do Porto Organizado
     ou a que distância está dela. Cálculos em SIRGAS 2000 / UTM 23S (metros),
     de segmento a segmento, entre as bordas mais próximas.
     ------------------------------------------------------------------ */
  // brutos: conjuntos lidos do arquivo (coordenadas de origem)
  const minhaArea = { arquivo: '', brutos: [], sistemas: [], avisos: [], resultados: [], sel: null };
  const camadaMinhaArea = L.featureGroup();
  const camadaLigacao = L.featureGroup();
  const PANE_AREA = 'pn-minha-area';
  const TAM_BLOCO = 16;           // segmentos por bloco no índice espacial simples
  const TOLERANCIA_LIMITE = 1;    // metros: pontos mais perto que isso do limite não decidem se está dentro ou fora
  const MAX_LINHAS_TABELA_AREA = 300;
  const LIMITE_MB_AREA = 50;
  let indicePoligonal = null;

  const SITUACAO = {
    dentro: { curto: 'Dentro', longo: 'Dentro da poligonal' },
    parcial: { curto: 'Parte dentro', longo: 'Parte dentro, parte fora da poligonal' },
    fora: { curto: 'Fora', longo: 'Fora da poligonal' }
  };
  const NOMES_CRS = {
    'EPSG:31983': 'SIRGAS 2000 / UTM 23S', 'EPSG:31984': 'SIRGAS 2000 / UTM 24S',
    'EPSG:3857': 'Web Mercator (EPSG:3857)', 'EPSG:4674': 'SIRGAS 2000 (graus)'
  };
  const erroAmigavel = (msg) => Object.assign(new Error(msg), { amigavel: true });

  const utm = (c) => paraUTM.forward([c[0], c[1]]);
  const deUtm = (p) => { const c = paraUTM.inverse([p[0], p[1]]); return L.latLng(c[1], c[0]); };

  function caixaDe(pts) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    pts.forEach((p) => {
      if (p[0] < b[0]) b[0] = p[0]; if (p[1] < b[1]) b[1] = p[1];
      if (p[0] > b[2]) b[2] = p[0]; if (p[1] > b[3]) b[3] = p[1];
    });
    return b;
  }
  const distCaixas = (a, b) => Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
  const caixasSeTocam = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);

  // Segmentos [ax, ay, bx, by, ref] de linhas e anéis; ref identifica a feição da poligonal
  function segmentosDe(linhas, ref = -1) {
    const s = [];
    linhas.forEach((l) => { for (let i = 1; i < l.length; i++) s.push([l[i - 1][0], l[i - 1][1], l[i][0], l[i][1], ref]); });
    return s;
  }

  function blocos(segs) {
    const out = [];
    for (let i = 0; i < segs.length; i += TAM_BLOCO) {
      const s = segs.slice(i, i + TAM_BLOCO);
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      s.forEach((g) => {
        b[0] = Math.min(b[0], g[0], g[2]); b[1] = Math.min(b[1], g[1], g[3]);
        b[2] = Math.max(b[2], g[0], g[2]); b[3] = Math.max(b[3], g[1], g[3]);
      });
      out.push({ bb: b, s });
    }
    return out;
  }

  function obterIndicePoligonal() {
    if (indicePoligonal) return indicePoligonal;
    const rt = estado.porId.get('poligonal');
    const d = rt && dadosDe(rt);
    if (!d || !d.features.length) return null;
    const polis = [], segs = [], vertices = [];
    d.features.forEach((f, k) => {
      const g = f.geometry;
      const lista = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      lista.forEach((pg) => {
        const aneis = pg.map((a) => a.map(utm));
        polis.push({ aneis, bb: caixaDe(aneis[0]), ref: k });
        segs.push(...segmentosDe(aneis, k));
        aneis[0].forEach((v) => vertices.push([v[0], v[1], k]));
      });
    });
    // "Anexo I - Polígono Marítimo Principal (225.000 m²)" → sem a área entre parênteses
    const nome = (k) => String(d.features[k].properties.Anexo || `Polígono ${k + 1}`).replace(/\s*\([^)]*\)?\s*$/, '').trim();
    indicePoligonal = { polis, blocos: blocos(segs), vertices, nome };
    return indicePoligonal;
  }

  // Ponto praticamente sobre o limite da poligonal (arquivos que copiam as mesmas bordas diferem por centímetros)
  function naBorda(ind, x, y) {
    const tol = TOLERANCIA_LIMITE;
    for (const pb of ind.blocos) {
      if (x < pb.bb[0] - tol || x > pb.bb[2] + tol || y < pb.bb[1] - tol || y > pb.bb[3] + tol) continue;
      for (const s of pb.s) if (pontoSegmento(x, y, s[0], s[1], s[2], s[3]).d <= tol) return true;
    }
    return false;
  }

  function dentroDaPoligonal(ind, x, y) {
    for (const p of ind.polis) {
      if (x >= p.bb[0] && x <= p.bb[2] && y >= p.bb[1] && y <= p.bb[3] && pontoNoPoligono(p.aneis, x, y)) return p.ref;
    }
    return -1;
  }

  function pontoSegmento(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const x = ax + t * dx, y = ay + t * dy;
    return { d: Math.hypot(px - x, py - y), x, y };
  }

  // Posição t (0 a 1) no segmento a onde ele cruza o segmento b; null se não cruzam
  function cruzamento(a, b) {
    const rx = a[2] - a[0], ry = a[3] - a[1], sx = b[2] - b[0], sy = b[3] - b[1];
    const den = rx * sy - ry * sx;
    if (!den) return null;
    const qx = b[0] - a[0], qy = b[1] - a[1];
    const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
  }

  // Menor distância entre dois segmentos e os pontos mais próximos em cada um
  function distSegmentos(a, b) {
    const t = cruzamento(a, b);
    if (t !== null) {
      const p = [a[0] + t * (a[2] - a[0]), a[1] + t * (a[3] - a[1])];
      return { d: 0, pa: p, pb: p };
    }
    let m = null;
    const testa = (d, pa, pb) => { if (!m || d < m.d) m = { d, pa, pb }; };
    let r = pontoSegmento(a[0], a[1], b[0], b[1], b[2], b[3]); testa(r.d, [a[0], a[1]], [r.x, r.y]);
    r = pontoSegmento(a[2], a[3], b[0], b[1], b[2], b[3]); testa(r.d, [a[2], a[3]], [r.x, r.y]);
    r = pontoSegmento(b[0], b[1], a[0], a[1], a[2], a[3]); testa(r.d, [r.x, r.y], [b[0], b[1]]);
    r = pontoSegmento(b[2], b[3], a[0], a[1], a[2], a[3]); testa(r.d, [r.x, r.y], [b[2], b[3]]);
    return m;
  }

  // Busca pelos pares de blocos mais próximos primeiro; para quando nenhum bloco pode melhorar o resultado
  function maisProximo(blocosArea, ind) {
    const pares = [];
    blocosArea.forEach((ua) => ind.blocos.forEach((pb) => pares.push([distCaixas(ua.bb, pb.bb), ua, pb])));
    pares.sort((x, y) => x[0] - y[0]);
    let melhor = { d: Infinity };
    for (const [limite, ua, pb] of pares) {
      if (limite >= melhor.d) break;
      for (const a of ua.s) for (const b of pb.s) {
        const r = distSegmentos(a, b);
        if (r.d < melhor.d) melhor = { d: r.d, pa: r.pa, pb: r.pb, ref: b[4] };
      }
      if (!melhor.d) break;
    }
    return melhor;
  }

  function geometriaUtm(g) {
    const r = { pontos: [], linhas: [], polis: [] };
    const conv = (a) => a.map(utm);
    switch (g.type) {
      case 'Point': r.pontos.push(utm(g.coordinates)); break;
      case 'MultiPoint': g.coordinates.forEach((c) => r.pontos.push(utm(c))); break;
      case 'LineString': r.linhas.push(conv(g.coordinates)); break;
      case 'MultiLineString': g.coordinates.forEach((l) => r.linhas.push(conv(l))); break;
      case 'Polygon': r.polis.push(g.coordinates.map(conv)); break;
      case 'MultiPolygon': g.coordinates.forEach((pg) => r.polis.push(pg.map(conv))); break;
    }
    return r;
  }

  // Dentro, parte dentro ou fora: testa os vértices e o meio de cada trecho entre os
  // cruzamentos com a poligonal (assim, anexos vizinhos contam como uma área só).
  // Pontos sobre o limite não contam; se todos caírem nele, vale um ponto do miolo da área.
  function situacaoDe(f, gu, segs, ind) {
    let dentro = -1, fora = false;
    const marca = (x, y) => {
      if (naBorda(ind, x, y)) return false;
      const r = dentroDaPoligonal(ind, x, y);
      if (r >= 0) { if (dentro < 0) dentro = r; } else fora = true;
      return dentro >= 0 && fora;
    };
    let decidido = gu.pontos.some((p) => marca(p[0], p[1]));
    for (let k = 0; k < segs.length && !decidido; k++) {
      const a = segs[k];
      const bb = [Math.min(a[0], a[2]), Math.min(a[1], a[3]), Math.max(a[0], a[2]), Math.max(a[1], a[3])];
      const ts = [0, 1];
      ind.blocos.forEach((pb) => {
        if (!caixasSeTocam(bb, pb.bb)) return;
        pb.s.forEach((b) => { const t = cruzamento(a, b); if (t !== null) ts.push(t); });
      });
      ts.sort((x, y) => x - y);
      decidido = marca(a[0], a[1]);
      for (let i = 1; i < ts.length && !decidido; i++) {
        if (ts[i] - ts[i - 1] < 1e-9) continue;
        const t = (ts[i] + ts[i - 1]) / 2;
        decidido = marca(a[0] + t * (a[2] - a[0]), a[1] + t * (a[3] - a[1]));
      }
    }
    if (dentro < 0 && !fora) {
      // Contorno inteiro sobre o limite (ex.: o mesmo polígono da poligonal): decide pelo miolo
      const miolo = gu.polis.length && ancoraDe(f);
      const p = miolo ? utm([miolo.lng, miolo.lat]) : null;
      const r = p ? dentroDaPoligonal(ind, p[0], p[1]) : -1;
      if (r >= 0) return { situacao: 'dentro', ref: r };
      if (p) fora = true;
      else { // linha ou ponto sobre o limite: conta como dentro, no anexo mais próximo
        const todos = segs.concat(gu.pontos.map((q) => [q[0], q[1], q[0], q[1], -1]));
        return { situacao: 'dentro', ref: maisProximo(blocos(todos), ind).ref };
      }
    }
    if (dentro >= 0) return { situacao: fora ? 'parcial' : 'dentro', ref: dentro };
    // O contorno ficou todo fora, mas a área pode envolver parte da poligonal
    for (const pg of gu.polis) {
      const bb = caixaDe(pg[0]);
      const v = ind.vertices.find((p) => p[0] >= bb[0] && p[0] <= bb[2] && p[1] >= bb[1] && p[1] <= bb[3] && pontoNoPoligono(pg, p[0], p[1]));
      if (v) return { situacao: 'parcial', ref: v[2] };
    }
    return { situacao: 'fora' };
  }

  function analisarFeicao(f, ind) {
    const gu = geometriaUtm(f.geometry);
    const segs = segmentosDe(gu.linhas.concat(...gu.polis));
    const todos = segs.concat(gu.pontos.map((p) => [p[0], p[1], p[0], p[1], -1]));
    if (!todos.length) return null;
    const s = situacaoDe(f, gu, segs, ind);
    if (s.situacao !== 'fora') return { situacao: s.situacao, d: 0, ref: s.ref };
    const m = maisProximo(blocos(todos), ind);
    return { situacao: 'fora', d: m.d, ref: m.ref, pa: deUtm(m.pa), pb: deUtm(m.pb) };
  }

  // Campo usado como nome da feição na tabela (NM_ é o padrão do IBGE, ex.: NM_MUN)
  const CAMPO_NOME_AREA = /^(nome|name|nm_|denomina|t[ií]tulo|identifica|r[oó]tulo|label|descri)/i;
  function nomeFeicaoArea(f, i) {
    const p = f.properties || {};
    const k = Object.keys(p).find((c) => CAMPO_NOME_AREA.test(c) && p[c] !== null && String(p[c]).trim());
    return k ? String(p[k]).trim() : `Feição ${i + 1}`;
  }

  const nomeSistema = (crs) => NOMES_CRS[crs] || crs;

  // Código EPSG a partir do nome no .prj (mais confiável que interpretar o texto todo)
  function epsgDoPrj(w) {
    const nome = ((w.match(/^\s*\w+\[\s*"([^"]+)"/) || [])[1] || '').replace(/_/g, ' ');
    let m;
    if ((m = nome.match(/SIRGAS ?2000.*UTM ?zone ?(\d{1,2}) ?S/i))) return `EPSG:${31960 + Number(m[1])}`;
    if ((m = nome.match(/WGS ?(19)?84.*UTM ?zone ?(\d{1,2}) ?S/i))) return `EPSG:${32700 + Number(m[2])}`;
    if ((m = nome.match(/SAD ?(19)?69.*UTM ?zone ?(\d{1,2}) ?S/i))) return `EPSG:${29170 + Number(m[2])}`;
    if (/^(GCS )?SIRGAS ?2000$/i.test(nome)) return 'EPSG:4674';
    if (/^(GCS )?WGS ?(19)?84$/i.test(nome)) return 'EPSG:4326';
    return null;
  }

  // Sistema de coordenadas de cada conjunto lido: .prj, nome no GeoJSON ou dedução pelos valores
  function sistemaDoConjunto(c) {
    const nomeWkt = (w) => (w.match(/^\s*\w+\[\s*"([^"]+)"/) || [, 'definido no arquivo .prj'])[1].replace(/_/g, ' ');
    if (c.prj) {
      const epsg = epsgDoPrj(c.prj);
      if (epsg && proj4.defs(epsg)) return { crs: epsg, nome: nomeWkt(c.prj) };
      try { proj4(c.prj, 'EPSG:4326'); return { crs: c.prj, nome: nomeWkt(c.prj) }; }
      catch (e) {
        return { crs: null, nome: 'não reconhecido',
          aviso: 'O sistema de coordenadas do arquivo .prj não foi reconhecido. Exporte a área em GeoJSON com EPSG:4326 e envie de novo.' };
      }
    }
    const crs = detectarCRS({ features: c.features, crs: c.crsNome ? { properties: { name: c.crsNome } } : null });
    if (!crs) return { crs: null, nome: 'graus (latitude e longitude)' };
    const nome = nomeSistema(crs);
    if (c.semPrj) {
      return { crs, nome, aviso: `Faltou o arquivo .prj do shapefile. É ele que diz em qual sistema de coordenadas a área foi desenhada. ` +
        `Sem ele, foi usado ${nome}, o mais comum no Rio. Se a área apareceu no lugar errado, ` +
        `envie de novo o .zip com os arquivos .shp, .shx, .dbf e .prj.` };
    }
    const declarado = c.crsNome && /EPSG/i.test(c.crsNome);
    return { crs, nome, aviso: declarado ? null : `O arquivo não informa o sistema de coordenadas. Foi usado ${nome}; ` +
      'se a área apareceu no lugar errado, exporte-a em GeoJSON com EPSG:4326 e envie de novo.' };
  }

  function statusArea(txt, tipo) {
    const el = $('#areaStatus');
    el.textContent = txt || '';
    el.className = `area-status${tipo ? ' ' + tipo : ''}`;
  }

  function abrirAbaArea() {
    if (document.body.classList.contains('painel-oculto')) $('#btnMenu').click();
    $('.aba-btn[data-aba="area"]').click();
  }

  // 1) Lê o arquivo; 2) processarMinhaArea reprojeta e calcula
  async function carregarMinhaArea(lista) {
    const arquivos = [...(lista || [])];
    if (!arquivos.length) return;
    abrirAbaArea();
    statusArea('Lendo o arquivo…', 'carregando');
    try {
      if (arquivos.some((f) => f.size > LIMITE_MB_AREA * 1024 * 1024)) {
        throw erroAmigavel(`O arquivo tem mais de ${LIMITE_MB_AREA} MB. Envie um arquivo menor ou simplifique a geometria.`);
      }
      const { conjuntos } = await window.GeoLeitor.ler(arquivos);
      Object.assign(minhaArea, {
        brutos: conjuntos,
        arquivo: arquivos.length === 1 ? arquivos[0].name : arquivos.map((f) => f.name).join(', ')
      });
      await processarMinhaArea();
    } catch (e) {
      if (!e.amigavel) console.warn('Minha área:', e);
      statusArea(e.amigavel ? e.message : 'Não foi possível ler o arquivo. Verifique se ele está completo e em um dos formatos aceitos.', 'erro');
    } finally {
      $('#entradaArea').value = '';
    }
  }

  async function processarMinhaArea() {
    const avisos = [], sistemas = new Set(), feicoes = [];
    try {
      minhaArea.brutos.forEach((c) => {
        const s = sistemaDoConjunto(c);
        if (s.aviso) avisos.push(s.aviso);
        if (c.semDbf) avisos.push('Faltou o arquivo .dbf do shapefile, por isso os nomes e atributos das feições não foram lidos.');
        sistemas.add(s.nome);
        preparar({ type: 'FeatureCollection', features: c.features }, s.crs).features.forEach((f) => feicoes.push(f));
      });
      if (!feicoes.length) throw erroAmigavel('Nenhuma área, linha ou ponto foi encontrado no arquivo.');
      const ext = extensaoDe(feicoes);
      const sw = ext.getSouthWest(), ne = ext.getNorthEast();
      if (!(sw.lng >= -75 && ne.lng <= -28 && sw.lat >= -35 && ne.lat <= 7)) {
        throw erroAmigavel('A área ficou fora do Brasil: o sistema de coordenadas do arquivo está faltando ou errado. ' +
          'Envie o shapefile em .zip com o .prj, ou exporte a área em GeoJSON com EPSG:4326.');
      }
      const ind = obterIndicePoligonal();
      if (!ind) throw erroAmigavel('A poligonal do Porto Organizado não está disponível para o cálculo.');
      statusArea(`Calculando a distância de ${NF0.format(feicoes.length)} ${feicoes.length === 1 ? 'feição' : 'feições'} até a poligonal…`, 'carregando');
      await new Promise((r) => setTimeout(r, 30)); // deixa a mensagem aparecer antes do cálculo
      const resultados = [];
      feicoes.forEach((f, i) => {
        const r = analisarFeicao(f, ind);
        if (r) resultados.push(Object.assign({ i: resultados.length, f, nome: nomeFeicaoArea(f, i) }, r));
      });
      if (!resultados.length) throw erroAmigavel('As geometrias do arquivo estão vazias.');
      Object.assign(minhaArea, { sistemas: [...sistemas], avisos, resultados, sel: null });
      statusArea('');
      const poligonal = estado.porId.get('poligonal');
      if (poligonal && !poligonal.visivel) { definirVisibilidade(poligonal, true); aposMudarVisibilidade(); }
      desenharMinhaArea();
      renderMinhaArea();
      renderLegenda();
      aproximarMinhaArea();
      const n = resultados.length;
      aviso(`Área carregada: ${n} ${n === 1 ? 'feição' : 'feições'}. Confira se ela está no lugar certo.`, 4000);
    } catch (e) {
      Object.assign(minhaArea, { sistemas: [...sistemas], avisos, resultados: [], sel: null });
      desenharMinhaArea();
      renderMinhaArea();
      renderLegenda();
      if (!e.amigavel) console.warn('Minha área:', e);
      statusArea(e.amigavel ? e.message : 'Não foi possível calcular com este arquivo.', 'erro');
    }
  }

  const resultadoMaisProximo = () => minhaArea.resultados
    .filter((r) => r.situacao === 'fora').reduce((m, r) => (!m || r.d < m.d ? r : m), null);

  function desenharMinhaArea() {
    camadaMinhaArea.clearLayers();
    if (!minhaArea.resultados.length) {
      map.removeLayer(camadaMinhaArea); map.removeLayer(camadaLigacao);
      return;
    }
    const fc = { type: 'FeatureCollection', features: minhaArea.resultados.map((r) => r.f) };
    const op = { pane: PANE_AREA, interactive: false };
    // Traço branco contínuo sobre um halo escuro: nenhuma camada do geoportal usa branco,
    // e o par claro/escuro aparece tanto no satélite quanto nos mapas claros
    camadaMinhaArea.addLayer(L.geoJSON(fc, Object.assign({}, op, {
      style: () => ({ color: '#0b1220', weight: 6, opacity: 0.55, fill: false }),
      pointToLayer: (f, ll) => L.circleMarker(ll, Object.assign({}, op, { radius: 7, color: '#0b1220', weight: 3, opacity: 0.7, fillColor: '#ffffff', fillOpacity: 1 }))
    })));
    camadaMinhaArea.addLayer(L.geoJSON(fc, Object.assign({}, op, {
      filter: (f) => !/Point/.test(f.geometry.type),
      style: () => ({ color: '#ffffff', weight: 2.5, fillColor: '#ffffff', fillOpacity: 0.18 })
    })));
    const sel = minhaArea.sel !== null && minhaArea.resultados[minhaArea.sel];
    if (sel) {
      camadaMinhaArea.addLayer(L.geoJSON(sel.f, Object.assign({}, op, {
        style: () => ({ color: '#facc15', weight: 4.5, fill: false }),
        pointToLayer: (f, ll) => L.circleMarker(ll, Object.assign({}, op, { radius: 10, color: '#facc15', weight: 3, fill: false }))
      })));
    }
    camadaMinhaArea.addTo(map);
    desenharLigacao();
  }

  // Linha entre os pontos mais próximos da área (ou da feição escolhida na tabela) e da poligonal
  function desenharLigacao() {
    camadaLigacao.clearLayers();
    const r = minhaArea.sel !== null ? minhaArea.resultados[minhaArea.sel] : resultadoMaisProximo();
    if (!r || r.situacao !== 'fora') { map.removeLayer(camadaLigacao); return; }
    const op = { pane: PANE_AREA, interactive: false };
    const pts = [r.pa, r.pb];
    camadaLigacao.addLayer(L.polyline(pts, Object.assign({}, op, { color: '#ffffff', weight: 7, opacity: 0.95 })));
    camadaLigacao.addLayer(L.polyline(pts, Object.assign({}, op, { color: '#1351b4', weight: 3.5 })));
    pts.forEach((p) => camadaLigacao.addLayer(L.circleMarker(p, Object.assign({}, op, { radius: 5, color: '#ffffff', weight: 2, fillColor: '#1351b4', fillOpacity: 1 }))));
    const meio = L.latLng((pts[0].lat + pts[1].lat) / 2, (pts[0].lng + pts[1].lng) / 2);
    camadaLigacao.addLayer(L.tooltip({ permanent: true, direction: 'center', className: 'gp-medida', interactive: false })
      .setLatLng(meio).setContent(formatarDistancia(r.d)));
    camadaLigacao.addTo(map);
  }

  function aproximarMinhaArea(r) {
    const lista = r ? [r] : minhaArea.resultados;
    if (!lista.length) return;
    let ext = extensaoDe(lista.map((x) => x.f));
    const lig = r ? (r.situacao === 'fora' ? r : null) : resultadoMaisProximo();
    // Sem nada dentro da poligonal, enquadra também o ponto mais próximo dela, para a ligação aparecer inteira
    if (lig && (r || !minhaArea.resultados.some((x) => x.situacao !== 'fora'))) ext = ext.extend(lig.pb);
    aproximarDe(ext, 17);
  }

  function selecionarFeicaoArea(i) {
    const r = minhaArea.resultados[i];
    if (!r) return;
    minhaArea.sel = minhaArea.sel === i ? null : i;
    desenharMinhaArea();
    $$('#areaResultado tr[data-i]').forEach((tr) => tr.setAttribute('aria-selected', String(Number(tr.dataset.i) === minhaArea.sel)));
    if (minhaArea.sel === null) { aproximarMinhaArea(); return; }
    aproximarMinhaArea(r);
    if (window.matchMedia('(max-width: 900px)').matches) document.body.classList.add('painel-oculto');
  }

  function removerMinhaArea() {
    Object.assign(minhaArea, { arquivo: '', brutos: [], sistemas: [], avisos: [], resultados: [], sel: null });
    desenharMinhaArea();
    renderMinhaArea();
    renderLegenda();
    statusArea('');
    aviso('Área removida do mapa.');
    $('#areaSoltar').focus();
  }

  function renderMinhaArea() {
    const res = minhaArea.resultados;
    const temArquivo = minhaArea.brutos.length > 0;
    $('#areaInicio').hidden = temArquivo;
    $('#areaResultado').hidden = !temArquivo;
    if (!temArquivo) { $('#areaResultado').innerHTML = ''; return; }
    const cabecalho = `
      <div class="area-arquivo">
        ${icone('file')}
        <div><b title="${esc(minhaArea.arquivo)}">${esc(minhaArea.arquivo)}</b>
          <span>${res.length ? `${NF0.format(res.length)} ${res.length === 1 ? 'feição' : 'feições'} · ${esc(minhaArea.sistemas.join(', '))}` : 'não foi possível calcular'}</span></div>
        <button type="button" class="btn-fechar" data-area="remover" aria-label="Remover a área do mapa" title="Remover a área do mapa">${icone('trash')}</button>
      </div>
      ${minhaArea.avisos.map((a) => `<p class="area-alerta">${esc(a)}</p>`).join('')}`;
    if (!res.length) {
      $('#areaResultado').innerHTML = `${cabecalho}
        <div class="area-acoes"><button type="button" class="btn-sec" data-area="outro">${icone('upload')}Enviar outro arquivo</button></div>`;
      return;
    }
    const ind = obterIndicePoligonal();
    const cont = { dentro: 0, parcial: 0, fora: 0 };
    res.forEach((r) => { cont[r.situacao]++; });
    const n = res.length, umaSo = n === 1;
    const perto = resultadoMaisProximo();
    let destaque;
    if (!cont.dentro && !cont.parcial) {
      destaque = { cls: 'fora', grande: formatarDistancia(perto.d),
        txt: `de distância até a poligonal do Porto Organizado. ${umaSo ? 'A área está fora' : 'Todas as feições estão fora'} da poligonal; o trecho mais próximo é o <b>${esc(ind.nome(perto.ref))}</b>.` };
    } else if (cont.dentro === n) {
      destaque = { cls: 'dentro', grande: 'Dentro da poligonal',
        txt: `${umaSo ? 'A área está totalmente dentro' : 'Todas as feições estão totalmente dentro'} da poligonal do Porto Organizado (<b>${esc(ind.nome(res[0].ref))}</b>).` };
    } else {
      const comParte = cont.dentro + cont.parcial;
      destaque = { cls: 'parcial', grande: umaSo ? 'Parte dentro da poligonal' : 'Em parte na poligonal',
        txt: umaSo
          ? `Uma parte da área fica dentro da poligonal do Porto Organizado (<b>${esc(ind.nome(res[0].ref))}</b>) e outra parte fica fora.`
          : `${comParte} de ${n} feições têm alguma parte dentro da poligonal do Porto Organizado.${perto ? ` Entre as que estão fora, a mais próxima fica a ${formatarDistancia(perto.d)}.` : ''}` };
    }
    const chip = (s) => `<span class="sit sit-${s}">${SITUACAO[s].curto}: ${cont[s]}</span>`;
    // KML/KMZ com pastas (ex.: Atual, Curto Prazo…) repetem nomes: a pasta aparece sob o nome
    const variasPastas = new Set(res.map((r) => r.f.properties.Pasta)).size > 1;
    const linhas = res.slice(0, MAX_LINHAS_TABELA_AREA).map((r) => `
      <tr data-i="${r.i}" tabindex="0" aria-selected="${r.i === minhaArea.sel}">
        <td>${esc(r.nome)}${variasPastas && r.f.properties.Pasta ? `<small class="area-pasta">${esc(r.f.properties.Pasta)}</small>` : ''}</td>
        <td><span class="sit sit-${r.situacao}" title="${SITUACAO[r.situacao].longo}">${SITUACAO[r.situacao].curto}</span></td>
        <td class="num">${r.situacao === 'fora' ? formatarDistancia(r.d) : '0 m'}</td>
      </tr>`).join('');
    $('#areaResultado').innerHTML = `${cabecalho}
      <div class="area-destaque ${destaque.cls}" role="status">
        <strong>${destaque.grande}</strong>
        <p>${destaque.txt}</p>
      </div>
      ${umaSo ? '' : `<div class="area-contagem">${['dentro', 'parcial', 'fora'].filter((s) => cont[s]).map(chip).join('')}</div>`}
      <div class="area-acoes">
        <button type="button" class="btn-sec" data-area="aproximar">${icone('focus')}Aproximar</button>
        <button type="button" class="btn-sec" data-area="csv">${icone('download')}Baixar CSV</button>
        <button type="button" class="btn-sec" data-area="outro">${icone('upload')}Outro arquivo</button>
      </div>
      <table class="area-tabela">
        <caption>Resultado por feição${umaSo ? '' : ' (clique para ver no mapa)'}</caption>
        <thead><tr><th scope="col">Feição</th><th scope="col">Situação</th><th scope="col" class="num">Distância</th></tr></thead>
        <tbody>${linhas}</tbody>
      </table>
      ${n > MAX_LINHAS_TABELA_AREA ? `<p class="area-mais">Mostrando ${MAX_LINHAS_TABELA_AREA} de ${NF0.format(n)} feições. O CSV traz todas.</p>` : ''}
      <p class="area-aviso">Resultado aproximado, calculado em SIRGAS 2000 / UTM 23S entre as bordas mais próximas, com os dados deste geoportal.
        Serve apenas para consulta e não substitui a análise oficial nem os documentos do
        <a href="${CFG.linkPdz}" target="_blank" rel="noopener">PDZ</a>.</p>`;
  }

  function baixarCsvMinhaArea() {
    const res = minhaArea.resultados;
    if (!res.length) return;
    const ind = obterIndicePoligonal();
    const attrs = [];
    res.forEach((r) => camposVisiveis(r.f.properties).forEach((k) => { if (!attrs.includes(k)) attrs.push(k); }));
    const coord = (ll) => (ll ? [Number(ll.lat.toFixed(6)), Number(ll.lng.toFixed(6))] : ['', '']);
    const cab = ['Nº', 'Feição', 'Situação', 'Distância até a poligonal (m)', 'Polígono da poligonal (mais próximo ou que contém)',
      'Ponto mais próximo na sua área (lat)', 'Ponto mais próximo na sua área (lon)',
      'Ponto mais próximo na poligonal (lat)', 'Ponto mais próximo na poligonal (lon)'].concat(attrs);
    const linhas = res.map((r) => [r.i + 1, r.nome, SITUACAO[r.situacao].longo, Number(r.d.toFixed(1)),
      r.ref >= 0 ? ind.nome(r.ref) : '', ...coord(r.pa), ...coord(r.pb)].concat(attrs.map((k) => r.f.properties[k])));
    const nome = minhaArea.arquivo.replace(/\.[^.]+$/, '');
    baixar(`Distância até a poligonal - ${nome}.csv`,
      '﻿' + [cab].concat(linhas).map((l) => l.map(celulaCsv).join(';')).join('\r\n'), 'text/csv;charset=utf-8');
  }

  function htmlLegendaMinhaArea() {
    if (!minhaArea.resultados.length) return '';
    const r = minhaArea.sel !== null ? minhaArea.resultados[minhaArea.sel] : resultadoMaisProximo();
    const lig = r && r.situacao === 'fora';
    return `<div class="leg-grupo"><h3>Minha área de interesse</h3>
      <div class="leg-item"><svg class="simb" viewBox="0 0 28 22" aria-hidden="true"><rect x="3" y="4" width="22" height="14" rx="2" fill="#94a3b8" stroke="#0b1220" stroke-opacity=".55" stroke-width="5"/><rect x="3" y="4" width="22" height="14" rx="2" fill="#ffffff" fill-opacity=".35" stroke="#ffffff" stroke-width="2"/></svg><span>${esc(minhaArea.arquivo)}</span></div>
      ${lig ? `<div class="leg-item"><svg class="simb" viewBox="0 0 28 22" aria-hidden="true"><path d="M3 11h22" stroke="#cbd5e1" stroke-width="7"/><path d="M3 11h22" stroke="#1351b4" stroke-width="3.5"/></svg><span>Menor distância até a poligonal (${formatarDistancia(r.d)})</span></div>` : ''}
    </div>`;
  }

  function ligarMinhaArea() {
    const entrada = $('#entradaArea');
    $('#areaSoltar').addEventListener('click', () => entrada.click());
    entrada.addEventListener('change', () => carregarMinhaArea(entrada.files));
    $('#areaResultado').addEventListener('click', (e) => {
      const b = e.target.closest('[data-area]');
      if (b) {
        if (b.dataset.area === 'remover') removerMinhaArea();
        if (b.dataset.area === 'aproximar') { minhaArea.sel = null; desenharMinhaArea(); renderMinhaArea(); aproximarMinhaArea(); }
        if (b.dataset.area === 'csv') baixarCsvMinhaArea();
        if (b.dataset.area === 'outro') entrada.click();
        return;
      }
      const tr = e.target.closest('tr[data-i]');
      if (tr) selecionarFeicaoArea(Number(tr.dataset.i));
    });
    $('#areaResultado').addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selecionarFeicaoArea(Number(tr.dataset.i)); }
    });
    // Arrastar e soltar: na aba "Minha área" ou direto sobre o mapa
    const temArquivo = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const zona = $('#areaSoltar');
    [$('#aba-area'), $('#areaMapa')].forEach((alvo) => {
      alvo.addEventListener('dragover', (e) => {
        if (!temArquivo(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        zona.classList.add('arrastando');
      });
      alvo.addEventListener('dragleave', (e) => { if (!alvo.contains(e.relatedTarget)) zona.classList.remove('arrastando'); });
      alvo.addEventListener('drop', (e) => {
        if (!temArquivo(e)) return;
        e.preventDefault();
        zona.classList.remove('arrastando');
        carregarMinhaArea(e.dataTransfer.files);
      });
    });
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
    L.popup({ minWidth: 240, maxWidth: 360 }).setLatLng(ll).setContent(html).openOn(map);
    const btn = document.getElementById('btnCopiarCoord');
    if (btn) btn.addEventListener('click', () => copiar(txt));
  }

  async function copiar(txt, msg = 'Coordenadas copiadas.') {
    try { await navigator.clipboard.writeText(txt); aviso(msg, 3200); }
    catch (e) {
      const t = document.createElement('textarea');
      t.value = txt; document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); aviso(msg, 3200); } catch (e2) { aviso(txt, 8000); }
      t.remove();
    }
  }

  /* ------------------------------------------------------------------
     Link da vista atual (estado na URL)
     ------------------------------------------------------------------ */
  let ultimoHash = '';
  let temporizadorUrl = null;

  function montarHash() {
    const c = map.getCenter();
    const p = new URLSearchParams();
    p.set('h', estado.horizonte);
    p.set('c', estado.camadas.filter((rt) => rt.visivel).map((rt) => rt.cfg.id).join(','));
    p.set('b', estado.base);
    p.set('v', `${Number(map.getZoom().toFixed(2))}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`);
    if (comparacao.ativa) p.set('cmp', comparacao.h);
    return '#' + p.toString().replace(/%2C/gi, ',').replace(/%2F/gi, '/');
  }

  // Atualiza o endereço sem criar entradas no histórico do navegador
  function atualizarUrl() {
    if (!estado.iniciado || vistaAntesImpressao) return;
    clearTimeout(temporizadorUrl);
    temporizadorUrl = setTimeout(() => {
      const h = montarHash();
      if (h === location.hash) return;
      ultimoHash = h;
      history.replaceState(null, '', h);
    }, 250);
  }

  // Link colado ou editado na barra de endereço com a página já aberta
  function aplicarUrl() {
    if (!estado.iniciado || location.hash === ultimoHash) return;
    const u = lerUrl();
    if (u.b && basesLeaflet[u.b] && u.b !== estado.base) trocarBase(u.b);
    if (u.c) {
      estado.camadas.forEach((rt) => { const v = u.c.includes(rt.cfg.id); if (rt.visivel !== v) definirVisibilidade(rt, v); });
      aposMudarVisibilidade();
    }
    if (u.h && CFG.horizontes.some((h) => h.id === u.h)) mudarHorizonte(u.h);
    if (u.vista) map.setView(u.vista.centro, u.vista.zoom);
    if (u.cmp && CFG.horizontes.some((h) => h.id === u.cmp)) ativarComparacao(u.cmp);
    else if (!u.cmp && comparacao.ativa) sairComparacao();
  }

  function copiarLink() {
    clearTimeout(temporizadorUrl);
    const h = montarHash();
    ultimoHash = h;
    history.replaceState(null, '', h);
    copiar(location.href, 'Link copiado. Quem abrir verá o mapa como está agora: horizonte, camadas, mapa de fundo e posição.');
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
    map.on('zoomend moveend', () => { atualizarStatus(); atualizarUrl(); });
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
  const FATOR_IMPRESSAO = 1.4; // igual a --imp-fator no CSS: o mapa da folha é desenhado 1,4× maior e reduzido

  // Área do mapa realmente visível na tela: sem o que fica atrás do cabeçalho, do painel de camadas,
  // das ferramentas, do painel estatístico e da barra de status
  function areaVisivelDaTela() {
    const m = map.getContainer().getBoundingClientRect();
    let esq = m.left, dir = m.right;
    const topo = Math.max(m.top, $('.topo').getBoundingClientRect().bottom);
    const baixo = Math.min(m.bottom, $('#barraStatus').getBoundingClientRect().top);
    if (!document.body.classList.contains('painel-oculto')) esq = Math.max(esq, $('#painel').getBoundingClientRect().right);
    dir = Math.min(dir, $('#ferramentas').getBoundingClientRect().left);
    if (estado.estAberto) dir = Math.min(dir, $('#painelEst').getBoundingClientRect().left);
    if (dir - esq < 200 || baixo - topo < 200) { esq = m.left; dir = m.right; } // tela pequena: usa o mapa todo
    return L.latLngBounds(
      map.containerPointToLatLng([esq - m.left, topo - m.top]),
      map.containerPointToLatLng([dir - m.left, baixo - m.top]));
  }

  function prepararImpressao() {
    if (vistaAntesImpressao) return;
    fecharInfo();
    $('#impTitulo').textContent = CFG.titulo;
    $('#impHorizonte').textContent = comparacao.ativa
      ? `${horizonteAtual().nome} (à esquerda) × ${nomeHorizonte(comparacao.h)} (à direita)`
      : horizonteAtual().nome;
    const partes = [...estado.filtros.perfil].concat([...estado.filtros.tipo]);
    $('#impFiltro').textContent = partes.length ? ` · Filtro: ${partes.join(', ')}` : '';
    $('#impData').textContent = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    $('#impLegenda').innerHTML = htmlLegenda() + htmlLegendaMinhaArea();
    vistaAntesImpressao = { centro: map.getCenter(), zoom: map.getZoom(), limites: areaVisivelDaTela() };
    document.body.classList.add('preparando-impressao');
    map.invalidateSize({ pan: false });
    // Enquadra exatamente a área que o usuário vê entre os painéis (zoom fracionário, sem arredondar);
    // as frestas entre blocos do mapa de fundo são evitadas pelo CSS de impressão
    map.options.zoomSnap = 0;
    map.fitBounds(vistaAntesImpressao.limites, { animate: false, padding: [0, 0] });
    map.options.zoomSnap = 0.25;
    // Escala numérica da folha impressa (96 px por polegada → 1 px = 0,2646 mm)
    const lat = map.getCenter().lat;
    const metrosPorPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
    const escala = (metrosPorPx * FATOR_IMPRESSAO) / 0.0002645833; // cada px do mapa vale 1/1,4 px no papel
    const passo = Math.pow(10, Math.floor(Math.log10(escala)) - 1);
    $('#impEscala').textContent = `Escala aproximada 1:${NF0.format(Math.round(escala / passo) * passo)} (folha A4 a 100%)`;
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
      case 'rotulos': alternarRotulos(); break;
      case 'minha-area': abrirAbaArea(); break;
      case 'comparar': if (comparacao.ativa) sairComparacao(); else ativarComparacao(); break;
      case 'copiar-link': copiarLink(); break;
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
    // O gráfico por horizonte usa todos os horizontes: baixa os que faltam antes de desenhar
    if (!todosHorizontesCarregados()) {
      $('#estFiltros').innerHTML = '';
      $('#estCorpo').innerHTML = '<p class="est-vazio est-carregando">Carregando os dados dos outros horizontes…</p>';
      carregarTodosHorizontes().then(renderEst).catch(() => {
        $('#estCorpo').innerHTML = '<p class="est-vazio">Não foi possível carregar os dados dos outros horizontes. Verifique a conexão e abra o painel de novo.</p>';
      });
      return;
    }

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
    document.body.classList.add('est-aberto');
    renderEst();
  }
  function fecharEst() {
    estado.estAberto = false;
    $('#painelEst').hidden = true;
    $('#estTooltip').hidden = true;
    $('#btnPainelEst').setAttribute('aria-expanded', 'false');
    document.body.classList.remove('est-aberto');
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
    // Resumo pronto do indice.js; sem ele (pasta carregada à mão), conta a partir dos dados
    let nArquivos, feicoes, crs;
    if (INDICE) {
      ({ arquivos: nArquivos, feicoes, crsOrigem: crs } = INDICE.resumo);
    } else {
      const arquivos = new Set();
      feicoes = 0;
      estado.camadas.forEach((rt) => {
        const hs = rt.cfg.horizonte ? CFG.horizontes.map((h) => h.id) : [estado.horizonte];
        hs.forEach((h) => {
          const d = dadosDe(rt, h);
          if (d) { arquivos.add(arquivoDe(rt, h)); feicoes += d.features.length; }
        });
      });
      nArquivos = arquivos.size;
      crs = [...new Set([...estado.preparados.values()].filter(Boolean).map((d) => d.crsOrigem))];
    }
    const ferr = (ic, nome, txt) => `<li><span class="sobre-ico">${icone(ic)}</span><span><b>${nome}</b> — ${txt}</span></li>`;
    const limites = CFG.fontes && CFG.fontes.limites;
    $('#sobreCorpo').innerHTML = `
      <div class="sobre-aviso" role="note">
        <p><b>Este geoportal é uma ferramenta de consulta.</b> Ele não substitui os documentos oficiais do porto, publicados no site
          do Ministério de Portos e Aeroportos:
          <a href="${CFG.linkPdz}" target="_blank" rel="noopener">Plano de Desenvolvimento e Zoneamento (PDZ)</a>.</p>
        <p class="sobre-data">As informações exibidas têm <b>caráter indicativo</b>.</p>
        ${CFG.dataAtualizacao ? `<p class="sobre-data">Dados atualizados em <b>${esc(CFG.dataAtualizacao)}</b>.</p>` : ''}
        ${CFG.versaoPlano ? `<p class="sobre-data">Plano de referência: <b>${esc(CFG.versaoPlano)}</b>.</p>` : ''}
      </div>

      <div class="stats">
        <div class="stat"><b>${estado.camadas.length}</b><span>camadas temáticas</span></div>
        <div class="stat"><b>${nArquivos}</b><span>arquivos de dados</span></div>
        <div class="stat"><b>${NF0.format(feicoes)}</b><span>feições</span></div>
      </div>

      <h3>Primeiros passos</h3>
      <ol class="sobre-passos">
        <li>Na aba <b>Camadas</b>, à esquerda, marque o que deseja ver no mapa.</li>
        <li>No topo, escolha o <b>horizonte</b>: ${CFG.horizontes.map((h) => esc(h.nome)).join(', ')}.
          As camadas com a etiqueta do horizonte mudam conforme a escolha; as demais são iguais em todos.</li>
        <li><b>Clique em uma área</b> do mapa para ver as informações dela. Se houver várias camadas no ponto, todas aparecem na lista.</li>
      </ol>

      <h3>Camadas e cores</h3>
      <ul>
        <li><b>Cores por perfil de carga:</b> cada perfil (Contêineres, Veículos, Passageiros…) tem sempre a mesma cor
          em todas as camadas. Quando uma camada com perfis está ligada, um cartão com as cores aparece no canto inferior do mapa;
          ele pode ser minimizado ou fechado (o botão "Legenda" o reabre). A legenda completa está na aba <b>Legenda</b>.</li>
        <li><b>Menu ⋯ de cada camada:</b> nele você ajusta o preenchimento, muda a ordem no mapa, aproxima a camada,
          abre a tabela de dados e baixa os arquivos.</li>
        <li><b>Qual camada fica por cima:</b> quando duas camadas ligadas ocupam o mesmo lugar, a que está na frente cobre a outra.
          Para mudar isso, abra o menu ⋯ da camada e clique em <b>↑ Para frente</b> ou <b>↓ Para trás</b>.
          Exemplo: para ver as áreas afetas por cima da poligonal, ligue as duas camadas e clique em "Para frente" nas áreas afetas.
          A ordem da lista no painel continua a mesma; muda apenas o que aparece por cima no mapa.
          Para desfazer, clique em <b>Restaurar ordem</b>, que aparece ao lado de "Desligar todas".</li>
        <li><b>Poligonal do Porto Organizado:</b> no menu ⋯ você pode mudar a cor, a transparência e a espessura da linha.
          O botão "Restaurar padrão" volta ao vermelho original.</li>
      </ul>

      <h3>Ferramentas do mapa</h3>
      <ul class="sobre-ferr">
        ${ferr('plus', 'Aproximar e afastar', 'também funciona com a roda do mouse.')}
        ${ferr('home', 'Extensão inicial', 'volta à vista do Porto Organizado.')}
        ${ferr('locate', 'Minha localização', 'mostra onde você está (o navegador pede permissão).')}
        ${ferr('ruler', 'Medir distância', 'clique nos pontos e dê duplo clique para terminar.')}
        ${ferr('area', 'Medir área', 'desenhe o contorno e dê duplo clique para terminar; mostra área e perímetro.')}
        ${ferr('trash', 'Limpar', 'apaga medições e destaques.')}
        ${ferr('rotulo', 'Rótulos', 'mostra os nomes das áreas no mapa ao aproximar. No menu ⋯ você escolhe quais camadas mostram nomes.')}
        ${ferr('upload', 'Minha área', 'abre a aba "Minha área", explicada abaixo.')}
        ${ferr('compare', 'Comparar horizontes', 'divide o mapa em dois: à esquerda o horizonte escolhido no topo, à direita o escolhido na barra de comparação. Arraste a divisória (ou use as setas do teclado) para ver o que muda. Esc encerra.')}
        ${ferr('link', 'Copiar link', 'copia o endereço desta vista (horizonte, camadas ligadas, mapa de fundo e posição) para enviar a outra pessoa.')}
        ${ferr('print', 'Imprimir', 'gera uma folha A4 com título, legenda, norte e escala.')}
        ${ferr('map', 'Mapa de fundo', 'no canto inferior esquerdo: Satélite, Cinza claro ou Ruas.')}
        ${ferr('moon', 'Tema escuro', 'botão da lua no topo; a escolha fica salva neste navegador.')}
        <li><span class="sobre-ico">${icone('copy')}</span><span><b>Coordenadas</b> — clique com o botão direito no mapa para ver e copiar as coordenadas do ponto.</span></li>
      </ul>

      <h3>Minha área de interesse</h3>
      <ul>
        <li>Na aba <b>Minha área</b>, envie o arquivo de um terreno, empreendimento ou projeto: shapefile compactado (.zip),
          GeoJSON, KML ou KMZ. Também dá para arrastar o arquivo direto para o mapa.</li>
        <li>O geoportal mostra se a área fica <b>dentro</b>, <b>parte dentro</b> ou <b>fora</b> da poligonal do Porto Organizado
          e, se estiver fora, a menor distância até ela, com uma linha azul no mapa. O resultado pode ser baixado em CSV.</li>
        <li><b>Shapefile:</b> envie o .zip com os arquivos .shp, .shx, .dbf e .prj. Sem o .prj a área pode aparecer no lugar errado.
          Depois de enviar, confira no mapa se a área está no lugar certo.</li>
        <li><b>Privacidade:</b> o arquivo é lido apenas no seu navegador e não é enviado para nenhum servidor.
          Ao fechar ou recarregar a página, a área some.</li>
        <li>O cálculo é aproximado e serve só para consulta; não substitui a análise oficial.</li>
      </ul>

      <h3>Pesquisa e painel estatístico</h3>
      <ul>
        <li>A aba <b>Pesquisar</b> encontra arrendatários, berços, trechos, armazéns, códigos de área e outros nomes.</li>
        <li>O <b>Painel estatístico</b> resume os perfis de carga. Clique em uma barra para filtrar o mapa, as tabelas e os outros
          gráficos; o mapa se aproxima das áreas filtradas. Clique de novo na barra para remover o filtro.</li>
      </ul>

      <h3>Imprimir e exportar</h3>
      <ul>
        <li><b>Impressão:</b> para que a escala numérica fique correta, imprima em A4 paisagem, a 100%, sem "ajustar à página".</li>
        <li><b>Tabela (CSV):</b> abra a tabela pelo menu ⋯ e clique em CSV. O arquivo abre no Excel.</li>
        <li><b>Dados geográficos (GeoJSON):</b> baixe pelo menu ⋯. As coordenadas estão em WGS 84 (EPSG:4326).</li>
        <li><b>Atalhos de teclado:</b> <kbd>Esc</kbd> fecha painéis e cancela medições; <kbd>←</kbd> <kbd>→</kbd> trocam o horizonte quando o seletor está selecionado.</li>
      </ul>

      <details class="sobre-tecnico">
        <summary>Informações técnicas e fontes</summary>
        <ul>
          <li><b>Sistemas de referência:</b> arquivos de origem em ${crs.map(esc).join(', ') || '—'}, convertidos para WGS 84 (EPSG:4326) na publicação.
            A barra inferior mostra também as coordenadas em SIRGAS 2000 / UTM zona 23S (EPSG:31983).</li>
          <li><b>Fontes dos dados:</b> todas as camadas referentes ao zoneamento do porto foram obtidas da base
            georreferenciada do PDZ do Porto do Rio de Janeiro, disponível no
            <a href="${CFG.linkPdz}" target="_blank" rel="noopener">site oficial do PDZ</a>.</li>
          ${limites ? `<li><b>Limites:</b> ${esc(limites.texto)} ${limites.ano ? `Malha de ${esc(limites.ano)}.` : ''}</li>` : ''}
          ${CFG.basemaps.map((b) => `<li><b>Mapa de fundo ${esc(b.nome)}:</b> ${b.atribuicao}</li>`).join('')}
        </ul>
      </details>

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

  // O foco fica preso dentro do "Sobre" enquanto ele está aberto e volta ao botão que o abriu
  let focoAntesSobre = null;
  function abrirSobre() {
    focoAntesSobre = document.activeElement;
    renderSobre();
    $('#modalSobre').hidden = false;
    $('#modalSobre .btn-fechar').focus();
  }
  function fecharSobre() {
    $('#modalSobre').hidden = true;
    if (focoAntesSobre && document.contains(focoAntesSobre)) focoAntesSobre.focus();
    focoAntesSobre = null;
  }
  function prenderFocoSobre(e) {
    if (e.key !== 'Tab' || $('#modalSobre').hidden) return;
    const focaveis = $$('#modalSobre a[href], #modalSobre button, #modalSobre summary, #modalSobre [tabindex]:not([tabindex="-1"])')
      .filter((el) => el.offsetParent !== null);
    if (!focaveis.length) return;
    const primeiro = focaveis[0], ultimo = focaveis[focaveis.length - 1];
    if (e.shiftKey && (document.activeElement === primeiro || !$('#modalSobre').contains(document.activeElement))) {
      e.preventDefault(); ultimo.focus();
    } else if (!e.shiftKey && (document.activeElement === ultimo || !$('#modalSobre').contains(document.activeElement))) {
      e.preventDefault(); primeiro.focus();
    }
  }

  /* ------------------------------------------------------------------
     Interface geral
     ------------------------------------------------------------------ */
  function ligarInterface() {
    // Abas (padrão WAI-ARIA: só a aba ativa entra no Tab; setas, Home e End trocam de aba)
    const abas = $$('.aba-btn');
    abas.forEach((b) => b.addEventListener('click', () => {
      abas.forEach((x) => {
        x.classList.toggle('ativa', x === b);
        x.setAttribute('aria-selected', String(x === b));
        x.tabIndex = x === b ? 0 : -1;
      });
      $$('.aba').forEach((s) => s.classList.toggle('ativa', s.id === `aba-${b.dataset.aba}`));
      if (b.dataset.aba === 'pesquisa') setTimeout(() => $('#campoPesquisa').focus(), 30);
    }));
    $('.abas').addEventListener('keydown', (e) => {
      const i = abas.indexOf(document.activeElement);
      if (i < 0) return;
      const destino = { ArrowRight: (i + 1) % abas.length, ArrowLeft: (i - 1 + abas.length) % abas.length, Home: 0, End: abas.length - 1 }[e.key];
      if (destino === undefined) return;
      e.preventDefault();
      abas[destino].focus();
      abas[destino].click();
    });

    // Árvore
    const arvore = $('#arvore');
    ['click', 'change', 'input'].forEach((t) => arvore.addEventListener(t, aoInteragirArvore));
    $('#filtroCamadas').addEventListener('input', renderArvore);
    $('#btnOrdemPadrao').addEventListener('click', restaurarOrdemDesenho);
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
    document.addEventListener('keydown', prenderFocoSobre);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#modalSobre').hidden) { fecharSobre(); return; }
      if (estado.medicao) { cancelarMedicao(); return; }
      if (!$('#info').hidden) { fecharInfo(); return; }
      if (!$('#tabela').hidden) { fecharTabela(); return; }
      if (estado.estAberto) { fecharEst(); return; }
      if (comparacao.ativa) { sairComparacao(); return; }
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
    // Link com camadas (#c=...): liga exatamente as camadas do link
    if (URL_INICIAL.c) estado.camadas.forEach((rt) => { rt.visivel = URL_INICIAL.c.includes(rt.cfg.id); });
    criarPanesCamadas();
    criarCamadaRotulos();
    criarPadroes();
    estado.camadas.forEach(atualizarCamada);

    const poligonal = estado.porId.get('poligonal');
    let ext = poligonal ? extensaoDe((dadosDe(poligonal) || {}).features) : null;
    if (!ext) ext = extensaoDe(estado.camadas.filter((rt) => rt.visivel).flatMap((rt) => rt.features));
    estado.extensaoInicial = ext;
    if (URL_INICIAL.vista) map.setView(URL_INICIAL.vista.centro, URL_INICIAL.vista.zoom, { animate: false });
    else if (ext) map.fitBounds(ext, margensMapa());

    renderArvore();
    renderLegenda();
    ligarEventosMapa();
    atualizarStatus(map.getCenter());

    // Pelo índice, sem preparar (reprojetar) camadas só para contar
    const n = estado.camadas.filter((rt) => (INDICE ? arquivosDoIndice.has(chave(arquivoDe(rt))) : dadosDe(rt))).length;
    $('#rodapeContagem').textContent = `${n} camadas disponíveis`;
    $('#rodapeContagem').title = n < estado.camadas.length
      ? `${estado.camadas.length - n} camada(s) sem arquivo de dados neste horizonte`
      : 'Todas as camadas do catálogo têm dados';

    const tela = $('#carregando');
    tela.classList.add('sumindo');
    setTimeout(() => { tela.hidden = true; }, 400);

    window.addEventListener('hashchange', aplicarUrl);
    if (URL_INICIAL.cmp && CFG.horizontes.some((h) => h.id === URL_INICIAL.cmp)) ativarComparacao(URL_INICIAL.cmp);
    atualizarUrl();
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
    ligarMinhaArea();
    ligarComparacao();
    sincronizarBotaoRotulos();
    $('#btnMinLegenda').addEventListener('click', () =>
      mudarLegendaFlutuante(estadoLegendaFlutuante() === 'minimizada' ? 'aberta' : 'minimizada'));
    $('#btnFecharLegenda').addEventListener('click', () => mudarLegendaFlutuante('fechada'));
    $('#btnReabrirLegenda').addEventListener('click', () => mudarLegendaFlutuante('aberta'));
    [$('#legendaFlutuante'), $('#btnReabrirLegenda')].forEach((el) => {
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
    });
    aplicarTema(armazenamento.ler('tema', 'claro'), true);

    try { localStorage.removeItem('geoportal-rj:horizonte'); } catch (e) { /* o horizonte agora vem do link */ }
    $('#btnTentarNovamente').addEventListener('click', () => location.reload());
    $('#semDadosAdmin').hidden = !ADMIN;
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
