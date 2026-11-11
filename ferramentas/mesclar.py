"""Junta empreendimentos novos ou atualizados em dados/lancamentos.json.

Uso:
    python3 -I ferramentas/mesclar.py dados/lancamentos.json novos.json [cache_geo.json]

novos.json:
    {
      "fonte": {"data": "AAAA-MM-DD", "nome": "...", "tipo": "apresentacao|planilha|print|texto"},
      "empreendimentos": [ { "nome": ..., "endereco": ..., "bairro": ..., "cidade": "São Paulo",
                             "data_referencia": "AAAA-MM-DD", "estoque": ..., "tipologias": [...], ... } ]
    }

Regras (as mesmas do site com banco de dados):
- O empreendimento é identificado pelo "id" (ou pelo nome sem acentos, em minúsculas, com hífens).
- Já existe: os campos de cadastro vazios são preenchidos; estoque, preços, tipologias e status
  são trocados só se a data-base nova for igual ou mais recente. O registro entra no histórico.
- Não existe: entra como novo e ganha a primeira linha do histórico.
- Sem lat/lng: o endereço é localizado no OpenStreetMap (Nominatim). Sem o número exato da casa,
  o pin fica marcado como posição aproximada.
"""
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

CADASTRO = ["incorporadora", "vendedora", "endereco", "bairro", "cidade", "data_lancamento", "entrega",
            "area_terreno_m2", "produto", "metragens", "site", "observacoes"]
MERCADO = ["status", "estoque", "total_unidades", "preco_tabela_m2", "preco_fechamento_m2",
           "ticket_tabela", "ticket_fechamento", "tipologias", "metragens", "produto"]


def slug(s):
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


class Geo:
    def __init__(self, cache_arq):
        self.arq = cache_arq
        self.cache = json.load(open(cache_arq)) if cache_arq and os.path.exists(cache_arq) else {}

    def _busca(self, params):
        chave = json.dumps(params, sort_keys=True, ensure_ascii=False)
        if chave in self.cache:
            return self.cache[chave]
        url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
            {"format": "jsonv2", "limit": 5, "countrycodes": "br", "addressdetails": 1, **params})
        req = urllib.request.Request(url, headers={"User-Agent": "radar-lancamentos-sp/1.0", "Accept-Language": "pt-BR"})
        for espera in (2, 10, 30, 60):
            time.sleep(2)
            try:
                res = json.load(urllib.request.urlopen(req, timeout=20))
                self.cache[chave] = res
                if self.arq:
                    json.dump(self.cache, open(self.arq, "w"), ensure_ascii=False)
                return res
            except urllib.error.HTTPError as err:
                if err.code != 429:
                    raise
                time.sleep(espera)
        raise RuntimeError("O Nominatim continua limitando as consultas; tente mais tarde.")

    @staticmethod
    def _na_cidade(r, cidade):
        a = r.get("address", {})
        return cidade in (a.get("city"), a.get("town"), a.get("municipality"))

    def localizar(self, endereco, bairro, cidade):
        """Devolve (lat, lng, aproximada, descrição) ou None."""
        numero = (re.search(r",\s*(\d+)", endereco or "") or [None, None])[1]
        rua = (endereco or "").split(",")[0].strip()
        tentativas = []
        if rua and numero:
            tentativas.append({"street": f"{numero} {rua}", "city": cidade, "state": "São Paulo"})
        if rua:
            tentativas += [{"street": rua, "city": cidade, "state": "São Paulo"}, {"q": f"{rua}, {bairro}, {cidade}"}]
        for t in tentativas:
            for r in self._busca(t):
                if not self._na_cidade(r, cidade):
                    continue
                exato = bool(numero) and r.get("address", {}).get("house_number") == numero
                return float(r["lat"]), float(r["lon"]), not exato, r["display_name"]
        if bairro:
            for r in self._busca({"q": f"{bairro}, {cidade}, SP"}):
                if self._na_cidade(r, cidade):
                    return float(r["lat"]), float(r["lon"]), True, "bairro: " + r["display_name"]
        return None


def linha_historico(e, fonte):
    return {k: e.get(k) for k in ("data_referencia", "estoque", "total_unidades", "preco_tabela_m2", "preco_fechamento_m2")} | {
        "fonte_desc": fonte.get("nome")}


def main(base_arq, novos_arq, cache_arq=None):
    base = json.load(open(base_arq))
    novos = json.load(open(novos_arq))
    fonte = novos["fonte"]
    geo = Geo(cache_arq)
    por_id = {e["id"]: e for e in base["empreendimentos"]}
    hist = base.setdefault("historico", {})
    relatorio = []

    for n in novos["empreendimentos"]:
        n.setdefault("cidade", "São Paulo")
        n["id"] = n.get("id") or slug(n["nome"])
        n.setdefault("data_referencia", fonte["data"])
        atual = por_id.get(n["id"])
        if atual is None:
            e = {"pesquisa_status": "concluida", "pesquisa_fontes": [], **n}
            if e.get("lat") is None:
                r = geo.localizar(e.get("endereco"), e.get("bairro"), e["cidade"])
                e["lat"], e["lng"] = (round(r[0], 6), round(r[1], 6)) if r else (None, None)
                e["posicao_aproximada"] = r[2] if r else True
                relatorio.append(f"NOVO        {e['nome'][:40]:40} {'APROX' if e['posicao_aproximada'] else 'ok   '} {r[3][:70] if r else 'não localizado'}")
            else:
                e.setdefault("posicao_aproximada", False)
                relatorio.append(f"NOVO        {e['nome'][:40]:40} posição informada")
            e["atualizado_em"] = fonte["data"]
            base["empreendimentos"].append(e)
            por_id[e["id"]] = e
        else:
            e = atual
            for c in CADASTRO:
                if e.get(c) in (None, "") and n.get(c) not in (None, ""):
                    e[c] = n[c]
            if not e.get("data_referencia") or n["data_referencia"] >= e["data_referencia"]:
                for c in MERCADO:
                    if n.get(c) is not None:
                        e[c] = n[c]
                e["data_referencia"] = n["data_referencia"]
                e["atualizado_em"] = fonte["data"]
                relatorio.append(f"ATUALIZADO  {e['nome'][:40]:40} estoque {n.get('estoque')}, tabela {n.get('preco_tabela_m2')}")
            else:
                relatorio.append(f"HISTÓRICO   {e['nome'][:40]:40} dado mais antigo que o atual: só entrou no histórico")
        if any(n.get(k) is not None for k in ("estoque", "preco_tabela_m2", "preco_fechamento_m2")):
            lista = [h for h in hist.get(e["id"], []) if not (h.get("data_referencia") == n["data_referencia"] and h.get("fonte_desc") == fonte.get("nome"))]
            lista.append(linha_historico(n, fonte))
            hist[e["id"]] = sorted(lista, key=lambda h: h.get("data_referencia") or "", reverse=True)

    base.setdefault("fontes", [])
    if fonte not in base["fontes"]:
        base["fontes"].append(fonte)
    base["atualizado_em"] = max(base.get("atualizado_em") or "", fonte["data"])
    json.dump(base, open(base_arq, "w"), ensure_ascii=False, indent=1)
    print("\n".join(relatorio))
    print(f"{len(base['empreendimentos'])} empreendimentos no mapa")


if __name__ == "__main__":
    main(*sys.argv[1:])
