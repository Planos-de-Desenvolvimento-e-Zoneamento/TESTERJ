/* =====================================================================
   Leitor de arquivos geográficos — usado em "Minha área de interesse"
   Tudo acontece no navegador: nenhum arquivo é enviado para a internet.
   Formatos: Shapefile (.zip, ou .shp/.dbf/.prj/.cpg selecionados juntos),
   GeoJSON (.geojson/.json), KML e KMZ. Sem bibliotecas externas: o .zip é
   aberto com o DecompressionStream nativo do navegador.
   Saída de GeoLeitor.ler(arquivos):
     { conjuntos: [{ nome, features, prj, crsNome }] }
   As coordenadas ficam no sistema de origem; a reprojeção é feita pelo app.
   ===================================================================== */
(function () {
  'use strict';

  const erro = (msg) => Object.assign(new Error(msg), { amigavel: true });
  const ext = (nome) => (nome.match(/\.([^.\/\\]+)$/) || [, ''])[1].toLowerCase();
  const base = (nome) => nome.replace(/^.*[\/\\]/, '').replace(/\.[^.]+$/, '');

  /* ------------------------------------------------------------------ ZIP */
  function listarZip(buf) {
    const dv = new DataView(buf);
    let fim = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { fim = i; break; }
    }
    if (fim < 0) throw erro('O arquivo .zip está corrompido ou não é um .zip.');
    const n = dv.getUint16(fim + 10, true);
    let p = dv.getUint32(fim + 16, true);
    const entradas = [];
    for (let k = 0; k < n && p + 46 <= buf.byteLength; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const flags = dv.getUint16(p + 8, true);
      const metodo = dv.getUint16(p + 10, true);
      const tamanho = dv.getUint32(p + 20, true);
      const lNome = dv.getUint16(p + 28, true), lExtra = dv.getUint16(p + 30, true), lCom = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const nome = new TextDecoder(flags & 0x800 ? 'utf-8' : 'windows-1252').decode(new Uint8Array(buf, p + 46, lNome));
      p += 46 + lNome + lExtra + lCom;
      if (nome.endsWith('/') || /(^|\/)__MACOSX\//.test(nome)) continue;
      if (flags & 1) throw erro('O .zip está protegido por senha. Envie um arquivo sem senha.');
      const ini = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      entradas.push({ nome, ler: () => descompactar(metodo, new Uint8Array(buf, ini, tamanho)) });
    }
    return entradas;
  }

  async function descompactar(metodo, dados) {
    if (metodo === 0) return dados.slice().buffer;
    if (metodo !== 8) throw erro('Este .zip usa um tipo de compactação não suportado. Compacte novamente com o padrão do Windows.');
    if (typeof DecompressionStream === 'undefined') {
      throw erro('Este navegador não abre arquivos .zip. Atualize o navegador ou envie a área em GeoJSON ou KML.');
    }
    const fluxo = new Blob([dados]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(fluxo).arrayBuffer();
  }

  /* ------------------------------------------------------------- Geometria */
  function areaAssinada(a) {
    let s = 0;
    for (let i = 0, j = a.length - 1; i < a.length; j = i++) s += a[j][0] * a[i][1] - a[i][0] * a[j][1];
    return s / 2;
  }
  function noAnel(pt, anel) {
    let dentro = false;
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const [xi, yi] = anel[i], [xj, yj] = anel[j];
      if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
    return dentro;
  }
  const fechar = (a) => {
    const p = a[0], u = a[a.length - 1];
    return p[0] === u[0] && p[1] === u[1] ? a : a.concat([p.slice()]);
  };

  // No shapefile, anéis externos giram no sentido horário e furos no anti-horário
  function montarPoligonos(aneis) {
    const externos = [], furos = [];
    aneis.filter((a) => a.length >= 4).forEach((a) => (areaAssinada(a) <= 0 ? externos : furos).push(a));
    if (!externos.length) { externos.push(...furos); furos.length = 0; }
    const polis = externos.map((a) => [a]);
    furos.forEach((f) => {
      const dono = polis.find((pg) => noAnel(f[0], pg[0]));
      if (dono) dono.push(f); else polis.push([f]);
    });
    if (!polis.length) return null;
    return polis.length === 1 ? { type: 'Polygon', coordinates: polis[0] } : { type: 'MultiPolygon', coordinates: polis };
  }

  // Junta geometrias simples do mesmo tipo (pontos, linhas, polígonos) em uma feição cada
  function juntar(geoms, props) {
    const pts = [], lin = [], pol = [];
    geoms.forEach((g) => {
      if (!g || !g.coordinates) return;
      switch (g.type) {
        case 'Point': pts.push(g.coordinates); break;
        case 'MultiPoint': pts.push(...g.coordinates); break;
        case 'LineString': lin.push(g.coordinates); break;
        case 'MultiLineString': lin.push(...g.coordinates); break;
        case 'Polygon': pol.push(g.coordinates); break;
        case 'MultiPolygon': pol.push(...g.coordinates); break;
      }
    });
    const saida = [];
    const f = (geometry) => saida.push({ type: 'Feature', properties: Object.assign({}, props), geometry });
    if (pol.length) f(pol.length === 1 ? { type: 'Polygon', coordinates: pol[0] } : { type: 'MultiPolygon', coordinates: pol });
    if (lin.length) f(lin.length === 1 ? { type: 'LineString', coordinates: lin[0] } : { type: 'MultiLineString', coordinates: lin });
    if (pts.length) f(pts.length === 1 ? { type: 'Point', coordinates: pts[0] } : { type: 'MultiPoint', coordinates: pts });
    return saida;
  }

  // Coleções de geometrias viram feições simples (o app não trabalha com GeometryCollection)
  function achatar(feat) {
    const g = feat && feat.geometry;
    if (!g) return [];
    if (g.type !== 'GeometryCollection') return [feat];
    const simples = [];
    (function vis(x) { (x.geometries || []).forEach((y) => (y.type === 'GeometryCollection' ? vis(y) : simples.push(y))); })(g);
    return juntar(simples, feat.properties || {});
  }

  /* ------------------------------------------------------------ Shapefile */
  function lerShp(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength < 100 || dv.getInt32(0, false) !== 9994) throw erro('O arquivo .shp está corrompido.');
    const geoms = [];
    let p = 100;
    while (p + 12 <= buf.byteLength) {
      const tam = dv.getInt32(p + 4, false) * 2;
      const ini = p + 8;
      if (tam < 4 || ini + tam > buf.byteLength) break;
      geoms.push(geometriaShp(dv, ini, dv.getInt32(ini, true)));
      p = ini + tam;
    }
    return geoms;
  }

  function geometriaShp(dv, o, tipo) {
    if (tipo === 0 || tipo === 31) return null; // nula ou multipatch (3D)
    const t = tipo % 10; // 1 ponto · 3 linha · 5 polígono · 8 multiponto (inclui variantes Z e M)
    const xy = (q) => [dv.getFloat64(q, true), dv.getFloat64(q + 8, true)];
    if (t === 1) return { type: 'Point', coordinates: xy(o + 4) };
    if (t === 8) {
      const n = dv.getInt32(o + 36, true), pts = [];
      for (let i = 0; i < n; i++) pts.push(xy(o + 40 + i * 16));
      return n === 1 ? { type: 'Point', coordinates: pts[0] } : { type: 'MultiPoint', coordinates: pts };
    }
    if (t === 3 || t === 5) {
      const nPartes = dv.getInt32(o + 36, true), nPts = dv.getInt32(o + 40, true);
      const partes = [];
      for (let i = 0; i < nPartes; i++) partes.push(dv.getInt32(o + 44 + i * 4, true));
      const op = o + 44 + nPartes * 4;
      const aneis = partes.map((ini, i) => {
        const fim = i + 1 < nPartes ? partes[i + 1] : nPts, a = [];
        for (let j = ini; j < fim; j++) a.push(xy(op + j * 16));
        return a;
      }).filter((a) => a.length > 1);
      if (!aneis.length) return null;
      if (t === 3) return aneis.length === 1 ? { type: 'LineString', coordinates: aneis[0] } : { type: 'MultiLineString', coordinates: aneis };
      return montarPoligonos(aneis);
    }
    return null;
  }

  function codificacaoDe(cpg) {
    const c = String(cpg || '').trim().toLowerCase();
    if (!c) return null;
    if (/utf-?8/.test(c)) return 'utf-8';
    if (/1252|ansi/.test(c)) return 'windows-1252';
    if (/8859-?1|latin/.test(c)) return 'iso-8859-1';
    try { new TextDecoder(c); return c; } catch (e) { return null; }
  }

  function lerDbf(buf, cpg) {
    const dv = new DataView(buf), bytes = new Uint8Array(buf);
    const nReg = dv.getUint32(4, true), tamCab = dv.getUint16(8, true), tamReg = dv.getUint16(10, true);
    // Sem .cpg: tenta UTF-8 e, se houver bytes inválidos, usa a codificação do Windows (padrão do ArcGIS/QGIS antigo)
    let cod = codificacaoDe(cpg);
    if (!cod) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(32, Math.min(bytes.length, tamCab + nReg * tamReg))); cod = 'utf-8'; }
      catch (e) { cod = 'windows-1252'; }
    }
    const dec = new TextDecoder(cod);
    const campos = [];
    for (let p = 32; p + 32 <= tamCab && bytes[p] !== 0x0d; p += 32) {
      const nome = dec.decode(bytes.subarray(p, p + 11)).replace(/\0[\s\S]*$/, '').trim();
      campos.push({ nome, tipo: String.fromCharCode(bytes[p + 11]), tam: bytes[p + 16] });
    }
    const registros = [];
    for (let r = 0; r < nReg; r++) {
      let p = tamCab + r * tamReg;
      if (p + tamReg > bytes.length) break;
      const apagado = bytes[p] === 0x2a;
      p++;
      const props = {};
      campos.forEach((c) => {
        const txt = dec.decode(bytes.subarray(p, p + c.tam)).replace(/\0/g, '').trim();
        p += c.tam;
        props[c.nome] = valorDbf(txt, c.tipo);
      });
      registros.push(apagado ? null : props);
    }
    return registros;
  }

  function valorDbf(txt, tipo) {
    if (txt === '') return null;
    if (tipo === 'N' || tipo === 'F') { const n = Number(txt); return Number.isFinite(n) ? n : txt; }
    if (tipo === 'L') return /^[TtYy]$/.test(txt) ? 'Sim' : /^[FfNn]$/.test(txt) ? 'Não' : null;
    if (tipo === 'D' && /^\d{8}$/.test(txt)) return `${txt.slice(6, 8)}/${txt.slice(4, 6)}/${txt.slice(0, 4)}`;
    return txt;
  }

  async function lerShapefile(grupo) {
    if (!grupo.shp) throw erro(`Falta o arquivo .shp de "${grupo.nome}".`);
    const geoms = lerShp(await grupo.shp.ler());
    const registros = grupo.dbf ? lerDbf(await grupo.dbf.ler(), grupo.cpg ? await textoDe(grupo.cpg) : null) : [];
    const features = [];
    geoms.forEach((g, i) => {
      if (registros[i] === null) return; // registro apagado
      if (g) features.push({ type: 'Feature', properties: registros[i] || {}, geometry: g });
    });
    return { nome: grupo.nome, features, prj: grupo.prj ? (await textoDe(grupo.prj)).trim() : null, semPrj: !grupo.prj, semDbf: !grupo.dbf };
  }

  /* -------------------------------------------------------------- GeoJSON */
  function lerGeoJSON(texto, nome) {
    let gj;
    try { gj = JSON.parse(texto.replace(/^﻿/, '')); } catch (e) { throw erro(`O arquivo "${nome}" não é um GeoJSON válido.`); }
    let feats = [];
    if (gj && gj.type === 'FeatureCollection') feats = gj.features || [];
    else if (gj && gj.type === 'Feature') feats = [gj];
    else if (gj && (gj.coordinates || gj.geometries)) feats = [{ type: 'Feature', properties: {}, geometry: gj }];
    const crsNome = gj && gj.crs && gj.crs.properties && gj.crs.properties.name;
    return { nome: base(nome), features: feats.flatMap(achatar), crsNome: crsNome || null };
  }

  /* ------------------------------------------------------------------ KML */
  function lerKml(texto, nome) {
    const doc = new DOMParser().parseFromString(texto, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw erro(`O arquivo "${nome}" não é um KML válido.`);
    const tags = (el, t) => Array.from(el.getElementsByTagNameNS('*', t));
    const filho = (el, t) => Array.from(el.children).find((c) => c.localName === t);
    const coords = (el) => {
      const c = el && tags(el, 'coordinates')[0];
      if (!c) return [];
      return c.textContent.trim().split(/\s+/).map((t) => t.split(',').map(Number))
        .filter((p) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]]);
    };
    function geometrias(el) {
      switch (el.localName) {
        case 'Point': { const c = coords(el); return c.length ? [{ type: 'Point', coordinates: c[0] }] : []; }
        case 'LineString':
        case 'LinearRing': { const c = coords(el); return c.length > 1 ? [{ type: 'LineString', coordinates: c }] : []; }
        case 'Polygon': {
          const externo = coords(filho(el, 'outerBoundaryIs'));
          if (externo.length < 3) return [];
          const furos = Array.from(el.children).filter((c) => c.localName === 'innerBoundaryIs').map(coords).filter((a) => a.length >= 3);
          return [{ type: 'Polygon', coordinates: [fechar(externo)].concat(furos.map(fechar)) }];
        }
        case 'MultiGeometry': return Array.from(el.children).flatMap(geometrias);
        default: return [];
      }
    }
    const features = [];
    tags(doc, 'Placemark').forEach((pm) => {
      const geoms = Array.from(pm.children).flatMap(geometrias);
      if (!geoms.length) return;
      const props = {};
      const n = filho(pm, 'name');
      if (n && n.textContent.trim()) props.Nome = n.textContent.trim();
      tags(pm, 'Data').forEach((d) => { const v = filho(d, 'value'); if (d.getAttribute('name')) props[d.getAttribute('name')] = v ? v.textContent.trim() : ''; });
      tags(pm, 'SimpleData').forEach((d) => { if (d.getAttribute('name')) props[d.getAttribute('name')] = d.textContent.trim(); });
      // Pasta do Google Earth (ex.: "Acostagem (Atual)"): o mesmo nome pode se repetir em pastas diferentes
      let pasta = pm.parentElement;
      while (pasta && pasta.localName !== 'Folder') pasta = pasta.parentElement;
      const nomePasta = pasta && filho(pasta, 'name');
      if (nomePasta && nomePasta.textContent.trim()) props.Pasta = nomePasta.textContent.trim();
      const desc = filho(pm, 'description');
      if (desc) {
        const html = desc.textContent;
        if (/<td/i.test(html)) {
          // Exportação do ArcGIS: atributos numa tabela HTML de duas colunas (campo | valor)
          new DOMParser().parseFromString(html, 'text/html').querySelectorAll('tr').forEach((tr) => {
            const tds = Array.from(tr.children).filter((c) => c.tagName === 'TD');
            if (tds.length !== 2 || tds[0].querySelector('table')) return;
            const k = tds[0].textContent.trim(), v = tds[1].textContent.trim();
            if (k && !(k in props)) props[k] = v;
          });
        } else {
          const txt = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
          if (txt && txt.length <= 300) props['Descrição'] = txt;
        }
      }
      features.push(...juntar(geoms, props));
    });
    return { nome: base(nome), features, crsNome: null }; // KML é sempre WGS 84
  }

  /* ------------------------------------------------------------- Entrada */
  const textoDe = async (arq) => new TextDecoder('utf-8').decode(await arq.ler());

  // Lê uma lista de arquivos (File) e devolve os conjuntos de feições encontrados
  async function ler(lista) {
    const soltos = [];
    for (const f of lista) {
      const e = ext(f.name);
      if (e === 'zip' || e === 'kmz') {
        listarZip(await f.arrayBuffer()).forEach((x) => soltos.push({ nome: x.nome, ler: x.ler }));
      } else soltos.push({ nome: f.name, ler: () => f.arrayBuffer() });
    }

    const conjuntos = [];
    const shapes = new Map();
    for (const a of soltos) {
      const e = ext(a.nome);
      if (['shp', 'dbf', 'prj', 'cpg'].includes(e)) {
        const k = a.nome.replace(/\.[^.]+$/, '').toLowerCase();
        if (!shapes.has(k)) shapes.set(k, { nome: base(a.nome) });
        shapes.get(k)[e] = a;
      } else if (e === 'geojson' || e === 'json') conjuntos.push(lerGeoJSON(await textoDe(a), a.nome));
      else if (e === 'kml') conjuntos.push(lerKml(await textoDe(a), a.nome));
    }
    for (const g of shapes.values()) {
      if (!g.shp && !g.dbf) continue; // .prj ou .cpg sozinhos
      conjuntos.push(await lerShapefile(g));
    }
    if (!conjuntos.length) {
      throw erro('Formato não reconhecido. Envie um shapefile compactado (.zip), GeoJSON, KML ou KMZ.');
    }
    return { conjuntos };
  }

  window.GeoLeitor = { ler };
})();
