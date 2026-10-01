/* =====================================================================
   Geoportal do Porto do Rio de Janeiro — catálogo de camadas
   ---------------------------------------------------------------------
   Cada camada aponta para um arquivo .geojson da pasta do Geoportal.
   Camadas com "horizonte: true" usam o arquivo "<arquivo> - <sufixo>",
   onde o sufixo vem do horizonte de planejamento selecionado.
   Todas as simbologias usam linhas sólidas. "contorno" desenha um halo
   sob a linha principal para destacá-la sobre qualquer mapa de fundo.
   ===================================================================== */
// Cor fixa de cada perfil de carga — a mesma em todas as camadas que têm o campo
const CORES_PERFIL = {
  'Contêineres': '#1d4ed8',
  'Veículos': '#7c3aed',
  'Passageiros': '#db2777',
  'Multiuso': '#0891b2',
  'Granéis Líquidos': '#9a3412',
  'Granéis Sólidos': '#ca8a04',
  'Trigo': '#eab308',
  'Offshore': '#0f766e',
  'Apoio Logístico Offshore': '#2dd4bf',
  'Carga Geral e Offshore': '#059669',
  'Carga Geral': '#16a34a',
  'Carga Geral e Granel Sólido': '#84cc16',
  'Produtos Siderúrgicos': '#475569',
  'Não informado': '#ff7a00'   // laranja vivo: visível sobre satélite, mapa claro e ruas
};
const POR_PERFIL = { campo: 'Perfil de Carga', cores: CORES_PERFIL };

// Opacidade única do preenchimento dos polígonos (0,45 = 45%): mostra a cor da
// categoria e ainda deixa ver o mapa de fundo; o contorno fica sempre opaco.
const OPACIDADE_PADRAO = 0.45;

window.GEOPORTAL_CONFIG = {
  titulo: 'Zoneamento do Porto do Rio de Janeiro',
  subtitulo: 'Zoneamento, infraestrutura e acessos portuários',
  orgao: { linha1: 'Ministério de', linha2: 'Portos e Aeroportos' },
  opacidadePadrao: OPACIDADE_PADRAO,

  // Fontes exibidas no "Sobre"
  fontes: {
    limites: {
      texto: 'Municípios e Unidades da Federação: IBGE — Malha Territorial.',
      ano: null // ano da malha não consta nos arquivos de origem
    }
  },

  horizontes: [
    { id: 'atual', nome: 'Situação Atual', curto: 'Atual', sufixo: 'Situação Atual' },
    { id: 'curto', nome: 'Curto Prazo', curto: 'Curto', sufixo: 'Curto Prazo' },
    { id: 'medio', nome: 'Médio Prazo', curto: 'Médio', sufixo: 'Médio Prazo' },
    { id: 'longo', nome: 'Longo Prazo', curto: 'Longo', sufixo: 'Longo Prazo' }
  ],

  // Três mapas de fundo (serviços públicos Esri, sem chave de API)
  baseInicial: 'satelite',
  basemaps: [
    {
      id: 'cinza',
      nome: 'Cinza claro',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      rotulos: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      maxNativo: 16,
      atribuicao: 'Mapa base &copy; Esri, HERE, Garmin, &copy; colaboradores do OpenStreetMap',
      miniatura: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/13/4631/3112'
    },
    {
      id: 'satelite',
      nome: 'Satélite',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      rotulos: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      maxNativo: 19,
      atribuicao: 'Imagens &copy; Esri, Maxar, Earthstar Geographics',
      miniatura: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/13/4631/3112'
    },
    {
      id: 'ruas',
      nome: 'Ruas',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
      maxNativo: 19,
      atribuicao: 'Mapa base &copy; Esri, HERE, Garmin, USGS, &copy; colaboradores do OpenStreetMap',
      miniatura: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/13/4631/3112'
    }
  ],

  // Painel estatístico de perfis de carga
  estatisticas: {
    campoPerfil: 'Perfil de Carga',
    campoTipo: 'Tipo de Instalação',
    camadaAreas: 'afetas',
    camadaCais: 'acostagem',
    camadaArrendadas: 'arrendadas',
    camadaDisponiveis: 'disp_arr',
    // Grafias equivalentes unificadas nos gráficos e filtros
    sinonimos: {
      'Granel Sólido': 'Granéis Sólidos',
      'Granel Líquido': 'Granéis Líquidos',
      '-': 'Não informado'
    }
  },

  grupos: [
    { id: 'ref', nome: 'Limites e Referências' },
    { id: 'zon', nome: 'Zoneamento Portuário' },
    { id: 'inst', nome: 'Instalações Portuárias' },
    { id: 'aqua', nome: 'Acessos Aquaviários' },
    { id: 'terr', nome: 'Acessos Terrestres' },
    { id: 'amb', nome: 'Meio Ambiente, Patrimônio e Uso do Solo' }
  ],

  camadas: [
    /* ---------------- Zoneamento portuário ---------------- */
    {
      id: 'afetas', grupo: 'zon', tipo: 'poligono', horizonte: true,
      nome: 'Áreas afetas às operações portuárias',
      arquivo: 'Áreas Afetas às Operações Portuárias',
      painel: 'pn-zoneamento', rotulo: ['Nome'],
      estilo: { cor: '#1e3a8a', espessura: 2.5, opacidadePreenchimento: 0.45 },
      categorias: POR_PERFIL
    },
    {
      id: 'arrendadas', grupo: 'zon', tipo: 'poligono', horizonte: true,
      nome: 'Áreas arrendadas',
      arquivo: 'Áreas Afetas às Operações Portuárias Arrendadas',
      painel: 'pn-zoneamento', rotulo: ['Arrendatário'],
      estilo: { cor: '#6d28d9', espessura: 2.5, opacidadePreenchimento: 0.45 },
      categorias: POR_PERFIL
    },
    {
      id: 'disp_arr', grupo: 'zon', tipo: 'poligono', horizonte: true,
      nome: 'Áreas disponíveis para arrendamento',
      arquivo: 'Áreas Afetas às Operações Portuárias Disponíveis para Arrendamento',
      painel: 'pn-zoneamento', rotulo: ['Nome'],
      estilo: { cor: '#15803d', espessura: 2.5, opacidadePreenchimento: 0.45 },
      categorias: POR_PERFIL
    },
    {
      id: 'nao_afetas', grupo: 'zon', tipo: 'poligono', horizonte: true,
      nome: 'Áreas não afetas às operações portuárias',
      arquivo: 'Áreas Não Afetas às Operações Portuárias',
      painel: 'pn-zoneamento', rotulo: ['Nome'],
      estilo: { cor: '#c2410c', preenchimento: '#fb923c', espessura: 1.5, opacidadePreenchimento: 0.35 }
    },
    {
      id: 'nao_afetas_expl', grupo: 'zon', tipo: 'poligono', horizonte: true,
      nome: 'Áreas não afetas em exploração indireta',
      arquivo: 'Áreas Não Afetas às Operações Portuárias em Exploração Indireta',
      painel: 'pn-zoneamento', rotulo: ['Nome'],
      estilo: { cor: '#a21caf', preenchimento: '#e879f9', espessura: 1.5, opacidadePreenchimento: 0.3 }
    },
    {
      id: 'nao_afetas_disp', grupo: 'zon', tipo: 'poligono', horizonte: true,
      nome: 'Áreas não afetas disponíveis para exploração indireta',
      arquivo: 'Áreas Não Afetas às Operações Portuárias Disponíveis para Exploração Indireta',
      painel: 'pn-zoneamento', rotulo: ['Nome'],
      estilo: { cor: '#0f766e', espessura: 2, padrao: { cor: '#14b8a6', espaco: 7, espessura: 2 } }
    },

    /* ---------------- Instalações portuárias ---------------- */
    {
      id: 'acostagem', grupo: 'inst', tipo: 'poligono', horizonte: true,
      nome: 'Acostagem (berços)',
      arquivo: 'Acostagem',
      painel: 'pn-instalacoes', rotulo: ['Identificador do Berço'],
      estilo: { cor: '#9f1239', espessura: 2.5, opacidadePreenchimento: 0.6 },
      categorias: POR_PERFIL
    },
    {
      id: 'armazenagem', grupo: 'inst', tipo: 'poligono', horizonte: true,
      nome: 'Armazenagem',
      arquivo: 'Armazenagem',
      painel: 'pn-instalacoes', rotulo: ['Tipo da Instalação'],
      estilo: { cor: '#92400e', preenchimento: '#f59e0b', espessura: 1.2, opacidadePreenchimento: 0.55 }
    },
    {
      id: 'terminais', grupo: 'inst', tipo: 'poligono', horizonte: true,
      nome: 'Terminais de passageiros',
      arquivo: 'Terminais de Passageiros',
      painel: 'pn-instalacoes', rotulo: ['Nome'],
      estilo: { cor: '#1d4ed8', preenchimento: '#3b82f6', espessura: 1.5, opacidadePreenchimento: 0.5 }
    },
    {
      id: 'alfandegadas', grupo: 'inst', tipo: 'poligono',
      nome: 'Áreas e instalações alfandegadas',
      arquivo: 'Áreas e Instalações Alfandegadas',
      painel: 'pn-instalacoes', rotulo: ['Legenda'],
      // Amarelo com halo escuro: contorno visível sobre satélite e sobre o mapa claro
      estilo: { cor: '#facc15', espessura: 2.5, padrao: { cor: '#facc15', espaco: 6, espessura: 1.5, angulo: -45 }, contorno: { cor: '#1f2937', espessura: 5.5 } }
    },

    /* ---------------- Acessos aquaviários ---------------- */
    {
      id: 'canais', grupo: 'aqua', tipo: 'poligono', horizonte: true,
      nome: 'Canais de acesso',
      arquivo: 'Canais de Acesso',
      painel: 'pn-aquaviario', rotulo: ['Trecho'],
      estilo: { cor: '#0369a1', preenchimento: '#38bdf8', espessura: 1.2, opacidadePreenchimento: 0.35 }
    },
    {
      id: 'bacias', grupo: 'aqua', tipo: 'poligono', horizonte: true,
      nome: 'Bacias de evolução',
      arquivo: 'Bacias de Evolução',
      painel: 'pn-aquaviario', rotulo: ['Nome'],
      estilo: { cor: '#0e7490', preenchimento: '#22d3ee', espessura: 1.8, opacidadePreenchimento: 0.25 }
    },
    {
      id: 'fundeadouros', grupo: 'aqua', tipo: 'poligono', horizonte: true,
      nome: 'Fundeadouros',
      arquivo: 'Fundeadouros',
      painel: 'pn-aquaviario', rotulo: ['Número de Identificação'],
      estilo: { cor: '#3730a3', preenchimento: '#6366f1', espessura: 1.6, opacidadePreenchimento: 0.15 }
    },

    /* ---------------- Acessos terrestres ---------------- */
    {
      id: 'rod_ext', grupo: 'terr', tipo: 'linha',
      nome: 'Acessos rodoviários externos',
      arquivo: 'Acessos Rodoviários Externos',
      painel: 'pn-acessos', rotulo: ['Legenda', 'Nome'],
      estilo: { cor: '#f97316', espessura: 3.5, contorno: { cor: '#7c2d12', espessura: 6 } }
    },
    {
      id: 'rod_int', grupo: 'terr', tipo: 'linha', horizonte: true,
      nome: 'Acessos rodoviários internos',
      arquivo: 'Acessos Rodoviários Internos',
      painel: 'pn-acessos', rotulo: ['Identificação'],
      estilo: { cor: '#fdba74', espessura: 2.5, contorno: { cor: '#9a3412', espessura: 4.5 } }
    },
    {
      id: 'fer_ext', grupo: 'terr', tipo: 'linha',
      nome: 'Acessos ferroviários externos',
      arquivo: 'Acessos Ferroviários Externos',
      painel: 'pn-acessos', rotulo: ['Trecho'],
      estilo: { cor: '#1f2937', espessura: 3, contorno: { cor: '#ffffff', espessura: 6 } }
    },
    {
      id: 'fer_int', grupo: 'terr', tipo: 'linha', horizonte: true,
      nome: 'Acessos ferroviários internos',
      arquivo: 'Acessos Ferroviários Internos',
      painel: 'pn-acessos', rotulo: ['Nome'],
      estilo: { cor: '#6b7280', espessura: 2.5, contorno: { cor: '#ffffff', espessura: 5 } }
    },
    {
      id: 'dutos', grupo: 'terr', tipo: 'linha',
      nome: 'Acessos dutoviários externos',
      arquivo: 'Acessos Dutoviários Externos',
      painel: 'pn-acessos', rotulo: ['Nome'],
      estilo: { cor: '#9333ea', espessura: 3, contorno: { cor: '#ffffff', espessura: 5.5 } }
    },

    /* ---------------- Meio ambiente, patrimônio e uso do solo ---------------- */
    {
      id: 'uc', grupo: 'amb', tipo: 'poligono',
      nome: 'Unidades de conservação',
      arquivo: 'Unidades de Conservação',
      painel: 'pn-ambiental', rotulo: ['Nome'],
      estilo: { cor: '#15803d', espessura: 2, padrao: { cor: '#16a34a', espaco: 8, espessura: 1.5, fundo: '#bbf7d0', opacidadeFundo: 0.35 } }
    },
    {
      id: 'tombados', grupo: 'amb', tipo: 'poligono',
      nome: 'Imóveis tombados',
      arquivo: 'Imóveis Tombados',
      painel: 'pn-instalacoes', rotulo: ['Nome'],
      estilo: { cor: '#7f1d1d', espessura: 2, padrao: { cor: '#b91c1c', espaco: 6, espessura: 1.5, angulo: 45 } }
    },
    {
      id: 'urbanas', grupo: 'amb', tipo: 'poligono',
      nome: 'Áreas urbanas e rurais',
      arquivo: 'Áreas Urbanas e Rurais',
      painel: 'pn-limites', rotulo: ['Tipo de Área'],
      estilo: { cor: '#a16207', espessura: 1.2, opacidadePreenchimento: 0.2 },
      categorias: { campo: 'Tipo de Área', cores: { 'Urbana': '#f59e0b', 'Rural': '#84cc16' } }
    },

    /* ---------------- Limites e referências ---------------- */
    {
      id: 'poligonal', grupo: 'ref', tipo: 'poligono', visivel: true,
      nome: 'Poligonal do Porto Organizado',
      arquivo: 'Poligonal da Área do Porto Organizado do Rio de Janeiro',
      painel: 'pn-poligonal', rotulo: ['Anexo'],
      personalizavel: true,    // cor, opacidade e largura do traço editáveis no menu ⋯
      identificarPorUltimo: true,
      // Sempre vermelha, com halo branco para destacar em qualquer mapa
      estilo: { cor: '#e52207', espessura: 3, semPreenchimento: true, contorno: { cor: '#ffffff', espessura: 7 } }
    },
    {
      id: 'municipios', grupo: 'ref', tipo: 'poligono',
      nome: 'Municípios do Rio de Janeiro',
      arquivo: 'Malha Municipal RJ JSON',
      painel: 'pn-limites', rotulo: ['Município'], semTooltip: true,
      estilo: { cor: '#334155', preenchimento: '#334155', espessura: 2, opacidadePreenchimento: OPACIDADE_PADRAO, contorno: { cor: '#ffffff', espessura: 5 } }
    },
    {
      id: 'uf', grupo: 'ref', tipo: 'poligono',
      nome: 'Unidades da Federação',
      arquivo: 'UF BR JSON',
      painel: 'pn-limites', rotulo: ['Unidade da Federação', 'Sigla da UF'], semTooltip: true,
      estilo: { cor: '#0f172a', preenchimento: '#0f172a', espessura: 3, opacidadePreenchimento: OPACIDADE_PADRAO, contorno: { cor: '#ffffff', espessura: 7 } }
    }
  ]
};
