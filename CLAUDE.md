# Radar de Lançamentos SP

Site estático (GitHub Pages, branch `main`, pasta raiz) com um mapa de satélite dos lançamentos imobiliários de São Paulo.
A dona do projeto não programa: fale em português simples, sem jargão.

## Como os dados entram
- Tudo está em `dados/lancamentos.json`: `empreendimentos` (um por pin), `historico[id]` (estoque e preço por data-base, do mais recente ao mais antigo) e `fontes`.
- A pessoa manda no chat apresentações (.pptx/.pdf), planilhas (.xlsx), prints ou textos do setor de inteligência de mercado.
  Leia o material, monte um JSON no formato descrito em `ferramentas/mesclar.py` e rode:
  `python3 -I ferramentas/mesclar.py dados/lancamentos.json <novos.json> <cache_geo.json>`
  Ele junta ao mapa, guarda o histórico e localiza endereços no Nominatim (precisa do host nominatim.openstreetmap.org liberado no ambiente).
- Para empreendimentos novos, pesquise na web o que faltar (endereço com número, incorporadora, datas). Os números da inteligência de mercado têm prioridade sobre a web.
- Preço por m² do resumo: média ponderada pela área vendável (área × unidades). Ticket: média ponderada pelas unidades.
- Não publique no repositório os arquivos originais enviados (o repositório é público).

## Mapa
- Camadas só da Esri (satélite, vias em cinza, lugares, mapa de ruas). As camadas da CARTO exigem chave e mostram marca d'água.
- Os filtros de cor ficam em `.camada-satelite .leaflet-tile` e `.camada-vias .leaflet-tile` (por bloco; no contêiner causa névoa ao dar zoom).
- Cores dos pins: % vendido; roxo para breve lançamento, decorado ou stand; borda tracejada para posição aproximada.

Antes de publicar, confira o visual com o mapa real quando possível e mostre à pessoa o que mudou.
