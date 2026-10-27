# -*- coding: utf-8 -*-
"""
Geoportal - gera os dados compactos em assets/js/dados/ a partir dos .geojson da pasta.

  - reprojeta tudo para WGS 84 (EPSG:4326) com 6 casas decimais (~0,1 m), sem a coordenada Z;
    o navegador não precisa mais detectar nem converter o sistema de coordenadas;
  - simplifica os limites do IBGE (UF e municípios) preservando a topologia: cada divisa
    compartilhada é simplificada uma única vez e usada pelos dois vizinhos, sem frestas;
  - simplifica levemente linhas muito detalhadas (acessos rodoviários externos);
  - remove espaços no fim dos nomes de atributos e dá nomes claros aos campos do IBGE;
  - separa os dados em um arquivo comum e um por horizonte (o site carrega o horizonte
    escolhido primeiro e os demais só quando necessário);
  - grava indice.js com tamanhos, versões (hash) e um resumo pronto para o "Sobre" e o rodapé;
  - atualiza o ?v= dos scripts e estilos no index.html com o hash de cada arquivo.

Rode sempre que mudar os dados OU os arquivos do site (Atualizar dados.bat).
"""
import datetime
import glob
import hashlib
import json
import math
import os
import re
import sys
from collections import defaultdict

# Endereço público do site (com / no fim). Usado na prévia do link (og:url e og:image) do index.html.
# Quando o site mudar de endereço, troque aqui e rode "Atualizar dados.bat".
URL_PUBLICA = 'https://planos-de-desenvolvimento-e-zoneamento.github.io/TESTERJ/'

RAIZ = os.path.dirname(os.path.abspath(__file__))
PASTA_SAIDA = os.path.join(RAIZ, 'assets', 'js', 'dados')
ANTIGO = os.path.join(RAIZ, 'assets', 'js', 'dados.js')  # formato anterior (um arquivo só)

# Horizontes: sufixo do nome do arquivo -> parte (mesmos sufixos do config.js)
HORIZONTES = {
    'Situação Atual': 'atual',
    'Curto Prazo': 'curto',
    'Médio Prazo': 'medio',
    'Longo Prazo': 'longo',
}

# Simplificação topológica (tolerância em metros), mais fina perto do porto, onde o usuário aproxima o mapa:
#   perto: trechos a até RAIO_PORTO_KM do porto; rj: divisas do estado do RJ; longe: demais divisas
CENTRO_PORTO = (-43.2, -22.88)
RAIO_PORTO_KM = 40.0
TOPOLOGIA = {
    'UF BR JSON': {'perto': 20.0, 'rj': 100.0, 'longe': 1000.0},
    'Malha Municipal RJ JSON': {'perto': 20.0, 'rj': 100.0, 'longe': 100.0},
}
# Ilhas e furos menores que isto (km²), longe do porto, são descartados (milhares de ilhotas na costa)
AREA_MINIMA_KM2 = {
    'UF BR JSON': 5.0,
    'Malha Municipal RJ JSON': 0.2,
}
# Linhas muito detalhadas (tolerância em metros)
LINHAS = {
    'Acessos Rodoviários Externos': 5.0,
}

# Nomes claros para os campos abreviados das malhas do IBGE
CAMPOS_IBGE = {
    'CD_MUN': 'Código IBGE do município',
    'NM_MUN': 'Município',
    'CD_RGI': 'Código da região geográfica imediata',
    'NM_RGI': 'Região geográfica imediata',
    'CD_RGINT': 'Código da região geográfica intermediária',
    'NM_RGINT': 'Região geográfica intermediária',
    'CD_UF': 'Código IBGE da UF',
    'NM_UF': 'Unidade da Federação',
    'SIGLA_UF': 'Sigla da UF',
    'CD_REGIAO': 'Código da região',
    'NM_REGIAO': 'Região',
    'SIGLA_RG': 'Sigla da região',
    'CD_CONCURB': 'Código da concentração urbana',
    'NM_CONCURB': 'Concentração urbana',
    'AREA_KM2': 'Área (km²)',
}
RENOMEAR = {
    'UF BR JSON': CAMPOS_IBGE,
    'Malha Municipal RJ JSON': CAMPOS_IBGE,
}

NOMES_CRS = {
    'CRS84': 'WGS 84 (CRS84)',
    '4326': 'WGS 84 (EPSG:4326)',
    '4674': 'SIRGAS 2000 (EPSG:4674)',
    '3857': 'Web Mercator (EPSG:3857)',
    '31983': 'SIRGAS 2000 / UTM 23S (EPSG:31983)',
}

# Campos "Id"/"Id_1" que guardam códigos com significado (têm letras, ex.: RDJ06A, R02, 2N01)
# ganham um nome claro e ficam visíveis. Ids só numéricos são técnicos e continuam ocultos no site.
CAMPO_ID = re.compile(r'^id(_\d+)?$', re.IGNORECASE)


def renomear_codigos(features):
    codigos = []
    for chave in {k for f in features for k in (f.get('properties') or {})}:
        if CAMPO_ID.match(chave.strip()) and any(
                re.search(r'[A-Za-z]', str((f.get('properties') or {}).get(chave) or '')) for f in features):
            codigos.append(chave)
    if not codigos:
        return
    codigos.sort(key=lambda k: k.strip().lower())  # "Id" antes de "Id_1"
    nomes = {codigos[0]: 'Código da área'}
    if len(codigos) > 1:
        nomes[codigos[1]] = 'Código da instalação'
    for f in features:
        if f.get('properties'):
            f['properties'] = {nomes.get(k, k): v for k, v in f['properties'].items()}


# ------------------------------------------------------------------ Reprojeção para WGS 84
def crs_de(gj):
    """Código do sistema de origem: 'CRS84', '4326', '4674', '3857' ou '31983'."""
    nome = str(((gj.get('crs') or {}).get('properties') or {}).get('name', '')).upper()
    if 'CRS84' in nome:
        return 'CRS84'
    for cod in ('4326', '4674', '3857', '900913', '31983'):
        if cod in nome:
            return '3857' if cod == '900913' else cod
    # Sem CRS declarado: deduz pela primeira coordenada (mesma regra usada antes no navegador)
    for f in gj.get('features', []):
        c = (f.get('geometry') or {}).get('coordinates')
        while isinstance(c, list) and c and isinstance(c[0], list):
            c = c[0]
        if c:
            if abs(c[0]) <= 180 and abs(c[1]) <= 90:
                return 'CRS84'
            return '31983' if c[1] > 1e6 else '3857'
    return 'CRS84'


R_MERC = 6378137.0


def de_3857(x, y):
    return math.degrees(x / R_MERC), math.degrees(2 * math.atan(math.exp(y / R_MERC)) - math.pi / 2)


# SIRGAS 2000 / UTM 23S -> graus (Transversa de Mercator inversa, elipsoide GRS80; erro < 1 mm no fuso)
_A, _F = 6378137.0, 1 / 298.257222101
_E2 = _F * (2 - _F)
_EP2 = _E2 / (1 - _E2)
_E1 = (1 - math.sqrt(1 - _E2)) / (1 + math.sqrt(1 - _E2))
_K0, _LON0, _FE, _FN = 0.9996, math.radians(-45.0), 500000.0, 10000000.0


def de_31983(x, y):
    m = (y - _FN) / _K0
    mu = m / (_A * (1 - _E2 / 4 - 3 * _E2 ** 2 / 64 - 5 * _E2 ** 3 / 256))
    phi1 = (mu + (3 * _E1 / 2 - 27 * _E1 ** 3 / 32) * math.sin(2 * mu)
            + (21 * _E1 ** 2 / 16 - 55 * _E1 ** 4 / 32) * math.sin(4 * mu)
            + (151 * _E1 ** 3 / 96) * math.sin(6 * mu)
            + (1097 * _E1 ** 4 / 512) * math.sin(8 * mu))
    s, c, t = math.sin(phi1), math.cos(phi1), math.tan(phi1)
    c1, t1 = _EP2 * c * c, t * t
    n1 = _A / math.sqrt(1 - _E2 * s * s)
    r1 = _A * (1 - _E2) / (1 - _E2 * s * s) ** 1.5
    d = (x - _FE) / (n1 * _K0)
    lat = phi1 - (n1 * t / r1) * (d ** 2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * _EP2) * d ** 4 / 24
                                 + (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * _EP2 - 3 * c1 ** 2) * d ** 6 / 720)
    lon = _LON0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6
                   + (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * _EP2 + 24 * t1 ** 2) * d ** 5 / 120) / c
    return math.degrees(lon), math.degrees(lat)


CONVERSORES = {'3857': de_3857, '31983': de_31983}


def reprojetar(coords, conv):
    if isinstance(coords[0], (int, float)):
        x, y = conv(coords[0], coords[1]) if conv else (coords[0], coords[1])
        return [x, y]
    return [reprojetar(c, conv) for c in coords]


def arredondar(coords):
    """6 casas decimais e sem pontos repetidos em sequência."""
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], 6), round(coords[1], 6)]
    if isinstance(coords[0][0], (int, float)):
        saida = []
        for x, y in coords:
            p = [round(x, 6), round(y, 6)]
            if not saida or saida[-1] != p:
                saida.append(p)
        return saida
    return [arredondar(c) for c in coords]


# ------------------------------------------------------------------ Simplificação
def dist_seg(p, a, b):
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def douglas_peucker(pts_graus, tol_m):
    """Douglas-Peucker com distâncias em metros (projeção local); devolve os pontos mantidos."""
    if len(pts_graus) < 3:
        return pts_graus
    lat = sum(p[1] for p in pts_graus) / len(pts_graus)
    kx, ky = 111320.0 * math.cos(math.radians(lat)), 110574.0
    pts = [(p[0] * kx, p[1] * ky) for p in pts_graus]
    manter = [False] * len(pts)
    manter[0] = manter[-1] = True
    pilha = [(0, len(pts) - 1)]
    while pilha:
        i, j = pilha.pop()
        dmax, idx = 0.0, -1
        for k in range(i + 1, j):
            d = dist_seg(pts[k], pts[i], pts[j])
            if d > dmax:
                dmax, idx = d, k
        if dmax > tol_m and idx > 0:
            manter[idx] = True
            pilha.append((i, idx))
            pilha.append((idx, j))
    return [p for p, m in zip(pts_graus, manter) if m]


def perto_do_porto(arco):
    """Algum ponto do arco a menos de RAIO_PORTO_KM do porto."""
    lon0, lat0 = CENTRO_PORTO
    kx, ky = 111.32 * math.cos(math.radians(lat0)), 110.574
    passo = max(1, len(arco) // 50)
    return any(math.hypot((p[0] - lon0) * kx, (p[1] - lat0) * ky) < RAIO_PORTO_KM for p in arco[::passo] + [arco[-1]])


def simplificar_topologico(features, tols, eh_rj):
    """Divide os anéis em arcos entre os nós (pontos onde muda o conjunto de vizinhos)
    e simplifica cada arco uma só vez, reaproveitando o resultado no vizinho."""
    aneis = []  # (indice da feição, lista do polígono, índice do anel)
    for fi, f in enumerate(features):
        g = f.get('geometry') or {}
        polis = [g['coordinates']] if g.get('type') == 'Polygon' else g.get('coordinates', []) if g.get('type') == 'MultiPolygon' else []
        for pg in polis:
            for ri in range(len(pg)):
                aneis.append((fi, pg, ri))
    chave = lambda p: (round(p[0], 7), round(p[1], 7))
    donos = defaultdict(set)
    for idx, (fi, pg, ri) in enumerate(aneis):
        for p in pg[ri][:-1]:
            donos[chave(p)].add(idx)
    cache = {}
    for idx, (fi, pg, ri) in enumerate(aneis):
        anel = pg[ri][:-1] if pg[ri][0] == pg[ri][-1] else pg[ri]
        n = len(anel)
        if n < 4:
            continue
        conj = [frozenset(donos[chave(p)]) for p in anel]
        nos = [i for i in range(n) if len(conj[i]) >= 3 or conj[i] != conj[i - 1] or conj[i] != conj[(i + 1) % n]]
        if not nos:
            nos = [min(range(n), key=lambda i: chave(anel[i]))]
        novo = []
        for k, ini in enumerate(nos):
            fim = nos[(k + 1) % len(nos)]
            passos = (fim - ini) % n or n
            arco = [anel[(ini + j) % n] for j in range(passos + 1)]
            meio = conj[(ini + 1) % n] if passos > 1 else (conj[ini] & conj[fim % n])
            if perto_do_porto(arco):
                t = tols['perto']
            elif any(eh_rj(aneis[a][0]) for a in meio):
                t = tols['rj']
            else:
                t = tols['longe']
            chaves = tuple(chave(p) for p in arco)
            inverso = chaves[::-1] < chaves
            canon = chaves[::-1] if inverso else chaves
            if (canon, t) not in cache:
                base = arco[::-1] if inverso else arco
                cache[(canon, t)] = douglas_peucker(base, t)
            s = cache[(canon, t)]
            s = s[::-1] if inverso else s
            novo.extend(s[:-1])
        novo.append(novo[0])
        if len(novo) >= 4:
            pg[ri] = novo


def area_km2(anel):
    lat = sum(p[1] for p in anel) / len(anel)
    kx, ky = 111.32 * math.cos(math.radians(lat)), 110.574
    s = 0.0
    for i in range(len(anel)):
        x1, y1 = anel[i - 1]
        x2, y2 = anel[i]
        s += (x1 * kx) * (y2 * ky) - (x2 * kx) * (y1 * ky)
    return abs(s) / 2


def descartar_ilhotas(features, minimo):
    """Remove partes e furos pequenos longe do porto; a maior parte de cada feição sempre fica."""
    for f in features:
        g = f['geometry']
        if g['type'] not in ('Polygon', 'MultiPolygon'):
            continue
        polis = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
        maior = max(polis, key=lambda pg: area_km2(pg[0]))
        manter = lambda anel: perto_do_porto(anel) or area_km2(anel) >= minimo
        novos = []
        for pg in polis:
            if pg is not maior and not manter(pg[0]):
                continue
            novos.append([pg[0]] + [furo for furo in pg[1:] if manter(furo)])
        if g['type'] == 'Polygon' or len(novos) == 1:
            g['type'], g['coordinates'] = 'Polygon', novos[0]
        else:
            g['coordinates'] = novos


def simplificar_linhas(coords, tol):
    if isinstance(coords[0][0], (int, float)):
        return douglas_peucker(coords, tol)
    return [simplificar_linhas(c, tol) for c in coords]


def contar_vertices(c):
    if isinstance(c[0], (int, float)):
        return 1
    return sum(contar_vertices(x) for x in c)


# ------------------------------------------------------------------ Versões no index.html
def atualizar_versoes():
    """Troca o ?v= de cada script/estilo local do index.html pelo hash do conteúdo do arquivo:
    o navegador só baixa de novo o que mudou, sem ninguém precisar lembrar de trocar números."""
    caminho = os.path.join(RAIZ, 'index.html')
    if not os.path.exists(caminho):
        return
    with open(caminho, 'r', encoding='utf-8', newline='') as fh:
        html = fh.read()

    def troca(m):
        rel = m.group(1)
        arq = os.path.join(RAIZ, *rel.split('/'))
        if not os.path.exists(arq):
            return m.group(0)
        with open(arq, 'rb') as fa:
            return '%s?v=%s' % (rel, hashlib.md5(fa.read()).hexdigest()[:10])

    novo = re.sub(r'(assets/[\w./-]+\.(?:js|css))(?:\?v=[\w.-]*)?', troca, html)
    # Prévia do link: endereço completo do site e da imagem (exigido pelo WhatsApp e redes sociais)
    novo = re.sub(r'(<meta property="og:url" content=")[^"]*(")', lambda m: m.group(1) + URL_PUBLICA + m.group(2), novo)
    novo = re.sub(r'(<meta property="og:image" content=")[^"]*(")', lambda m: m.group(1) + URL_PUBLICA + 'mpor-br.jpg' + m.group(2), novo)
    if novo != html:
        with open(caminho, 'w', encoding='utf-8', newline='') as fh:
            fh.write(novo)
    print('Versões (?v=) do index.html atualizadas.')


# ------------------------------------------------------------------ Principal
def parte_de(nome):
    for sufixo, parte in HORIZONTES.items():
        if nome.endswith(' - ' + sufixo):
            return parte
    return 'comum'


def main():
    arquivos = sorted(glob.glob(os.path.join(RAIZ, '*.geojson')))
    if not arquivos:
        print('Nenhum arquivo .geojson encontrado em', RAIZ)
        return 1
    os.makedirs(PASTA_SAIDA, exist_ok=True)
    partes = defaultdict(list)
    indice_arquivos = {}
    total_orig = 0
    for caminho in arquivos:
        nome = os.path.splitext(os.path.basename(caminho))[0]
        total_orig += os.path.getsize(caminho)
        with open(caminho, 'r', encoding='utf-8-sig') as fh:
            gj = json.load(fh)
        crs = crs_de(gj)
        conv = CONVERSORES.get(crs)
        feats = [f for f in gj.get('features', []) if f and (f.get('geometry') or {}).get('coordinates')]
        mapa = RENOMEAR.get(nome)
        renomear_codigos(feats)
        v_antes = 0
        for f in feats:
            # Nomes de atributos sem espaços nas pontas (e nomes claros do IBGE)
            props = {}
            for k, v in (f.get('properties') or {}).items():
                k2 = k.strip()
                props[(mapa or {}).get(k2, k2)] = v
            f['properties'] = props
            g = f['geometry']
            v_antes += contar_vertices(g['coordinates'])
            g['coordinates'] = reprojetar(g['coordinates'], conv)
        if nome in TOPOLOGIA:
            # Na malha municipal todas as feições são do RJ; na de UF, só a do Rio de Janeiro
            eh_rj = lambda fi: str(feats[fi]['properties'].get('Sigla da UF', 'RJ')).upper() == 'RJ'
            simplificar_topologico(feats, TOPOLOGIA[nome], eh_rj)
        if nome in AREA_MINIMA_KM2:
            descartar_ilhotas(feats, AREA_MINIMA_KM2[nome])
        if nome in LINHAS:
            for f in feats:
                if f['geometry']['type'] in ('LineString', 'MultiLineString'):
                    f['geometry']['coordinates'] = simplificar_linhas(f['geometry']['coordinates'], LINHAS[nome])
        v_depois = 0
        for f in feats:
            f['geometry']['coordinates'] = arredondar(f['geometry']['coordinates'])
            v_depois += contar_vertices(f['geometry']['coordinates'])
        saida = {'type': 'FeatureCollection', 'wgs84': True, 'crsOrigem': NOMES_CRS.get(crs, crs),
                 'features': [{'type': 'Feature', 'properties': f['properties'], 'geometry': f['geometry']} for f in feats]}
        texto = json.dumps(saida, ensure_ascii=False, separators=(',', ':'))
        parte = parte_de(nome)
        partes[parte].append('GEOPORTAL_DADOS[%s]=%s;' % (json.dumps(nome, ensure_ascii=False), texto))
        indice_arquivos[nome] = {'parte': parte, 'feicoes': len(feats), 'crsOrigem': NOMES_CRS.get(crs, crs)}
        print('  + %-80s %8.1f KB -> %8.1f KB  vértices %7d -> %7d' % (
            nome[:80], os.path.getsize(caminho) / 1024, len(texto.encode('utf-8')) / 1024, v_antes, v_depois))

    indice_partes = {}
    for parte, linhas in sorted(partes.items()):
        conteudo = ('/* Gerado automaticamente por gerar_dados.py - não editar. */\n'
                    'var GEOPORTAL_DADOS = window.GEOPORTAL_DADOS = window.GEOPORTAL_DADOS || {};\n'
                    + '\n'.join(linhas) + '\n')
        bruto = conteudo.encode('utf-8')
        nome_arq = parte + '.js'
        with open(os.path.join(PASTA_SAIDA, nome_arq), 'wb') as fh:
            fh.write(bruto)
        indice_partes[parte] = {'arquivo': nome_arq, 'bytes': len(bruto), 'hash': hashlib.md5(bruto).hexdigest()[:10]}

    resumo = {
        'arquivos': len(indice_arquivos),
        'feicoes': sum(a['feicoes'] for a in indice_arquivos.values()),
        'crsOrigem': sorted({a['crsOrigem'] for a in indice_arquivos.values()}),
    }
    indice = {'gerado': datetime.datetime.now().strftime('%d/%m/%Y %H:%M'), 'partes': indice_partes,
              'arquivos': indice_arquivos, 'resumo': resumo}
    with open(os.path.join(PASTA_SAIDA, 'indice.js'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write('/* Gerado automaticamente por gerar_dados.py - não editar. */\n')
        fh.write('window.GEOPORTAL_INDICE=%s;\n' % json.dumps(indice, ensure_ascii=False, separators=(',', ':')))
    if os.path.exists(ANTIGO):
        os.remove(ANTIGO)  # substituído pela pasta assets/js/dados/

    total = sum(p['bytes'] for p in indice_partes.values())
    print('')
    for parte, p in sorted(indice_partes.items()):
        print('  %-6s %8.2f MB' % (parte, p['bytes'] / 1048576))
    print('Original: %.1f MB  ->  dados: %.2f MB em %d partes (%d arquivos, %d feições)' % (
        total_orig / 1048576, total / 1048576, len(indice_partes), resumo['arquivos'], resumo['feicoes']))
    atualizar_versoes()
    return 0


if __name__ == '__main__':
    sys.exit(main())
