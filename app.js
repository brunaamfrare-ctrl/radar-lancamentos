/* Radar de Lançamentos SP — lógica do site */
(() => {
  "use strict";

  const C = window.CONFIG || {};
  const CONFIGURADO = Boolean(
    C.SUPABASE_URL && C.SUPABASE_KEY &&
    !C.SUPABASE_URL.includes("SEU-PROJETO") && !C.SUPABASE_KEY.includes("SUA-CHAVE"),
  );
  // Modo estático: os dados vêm de um arquivo JSON publicado junto com o site (sem banco, sem envio pelo site)
  const ESTATICO = !CONFIGURADO && Boolean(C.DADOS_JSON);
  const sb = CONFIGURADO ? window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY) : null;
  const URL_FUNCAO = CONFIGURADO ? `${C.SUPABASE_URL.replace(/\/$/, "")}/functions/v1/lancamentos` : null;
  const BUCKET = "apresentacoes";
  const PAGINAS_POR_PARTE = 5;
  const SLIDES_POR_PARTE = 12;
  const IMAGENS_POR_PARTE = 4;
  const LEITURAS_SIMULTANEAS = 3;

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ───────────────────────── utilidades ─────────────────────────

  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  const brl0 = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  const int = new Intl.NumberFormat("pt-BR");
  const temValor = (v) => v !== null && v !== undefined && v !== "";
  const m2 = (v) => (temValor(v) ? `${brl0.format(v)}/m²` : "—");
  function ticket(v) {
    if (!temValor(v)) return "—";
    if (v >= 1e6) return `R$ ${(v / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} mi`;
    if (v >= 1e3) return `R$ ${(v / 1e3).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} mil`;
    return brl0.format(v);
  }
  const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
  function data(v) {
    if (!v) return "—";
    const s = String(v);
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    m = s.match(/^(\d{4})-(\d{2})$/);
    if (m) return `${MESES[Number(m[2]) - 1] ?? m[2]}/${m[1]}`;
    return s;
  }
  function hojeISO() {
    return new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  }
  function normalizar(s) {
    return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function pctVendido(e) {
    if (!temValor(e.total_unidades) || !temValor(e.estoque) || e.total_unidades <= 0) return null;
    return Math.max(0, Math.min(1, (e.total_unidades - e.estoque) / e.total_unidades));
  }
  // breve lançamento, abertura de decorado/stand: ainda sem vendas de verdade
  const preLancamento = (e) => Boolean(e.status) && !/^lançamento$/i.test(e.status.trim());
  function corVendas(e) {
    const p = pctVendido(e);
    if (preLancamento(e) && !p) return "var(--v-pre)";
    if (p === null) return "var(--v-sem)";
    if (p >= 0.7) return "var(--v-alta)";
    if (p >= 0.4) return "var(--v-media)";
    return "var(--v-baixa)";
  }
  function desconto(e) {
    if (!temValor(e.preco_tabela_m2) || !temValor(e.preco_fechamento_m2) || e.preco_tabela_m2 <= 0) return null;
    return 1 - e.preco_fechamento_m2 / e.preco_tabela_m2;
  }
  const pct = (v) => `${(v * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`;

  let timerToast;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(timerToast);
    timerToast = setTimeout(() => (t.hidden = true), 4200);
  }

  function lerSenha() {
    try { return localStorage.getItem("radar_senha") || ""; } catch { return ""; }
  }
  function gravarSenha(s) {
    try { s ? localStorage.setItem("radar_senha", s) : localStorage.removeItem("radar_senha"); } catch { /* sem armazenamento */ }
  }

  async function funcao(acao, dados = {}) {
    if (!CONFIGURADO) throw new Error("O site está em modo de demonstração. Configure o Supabase no arquivo config.js.");
    let r;
    try {
      r = await fetch(URL_FUNCAO, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: C.SUPABASE_KEY,
          Authorization: `Bearer ${C.SUPABASE_KEY}`,
          "x-senha": estado.senha || "",
        },
        body: JSON.stringify({ acao, ...dados }),
      });
    } catch {
      throw new Error("Sem conexão com o servidor. Confira a internet e tente de novo.");
    }
    let corpo = {};
    try { corpo = await r.json(); } catch { /* resposta sem JSON */ }
    if (r.status === 401 && acao !== "verificar") sairEquipe();
    if (r.status === 504 || r.status === 546) throw new Error("A operação demorou mais que o limite do servidor. Tente de novo; se repetir, divida o arquivo.");
    if (!r.ok) throw new Error(corpo.erro || `O servidor respondeu com erro ${r.status}.`);
    return corpo;
  }

  // ───────────────────────── estado ─────────────────────────

  const estado = {
    lista: [],
    selecionado: null,
    senha: lerSenha(),
    equipe: false,
    marcadores: new Map(),
    movendo: null,
    historicoEstatico: {},
  };

  // ───────────────────────── mapa ─────────────────────────

  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services";
  const ATRIB_ESRI = "Imagens © Esri, Maxar, Earthstar Geographics";
  const camadaSatelite = () => L.tileLayer(`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 20, maxNativeZoom: 19, attribution: ATRIB_ESRI, className: "camada-satelite",
  });
  // Ruas em cinza (o CSS tira a cor da camada de vias da Esri); os nomes das ruas vêm na mesma
  // camada e aparecem conforme o zoom; bairros e lugares vêm da camada de referência.
  const sateliteComRuas = L.layerGroup([
    camadaSatelite(),
    L.tileLayer(`${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 20, maxNativeZoom: 19, className: "camada-vias", opacity: 0.6,
    }),
    L.tileLayer(`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`, {
      maxZoom: 20, maxNativeZoom: 19,
    }),
  ]);
  const mapaRuas = L.tileLayer(`${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`, {
    maxZoom: 20, maxNativeZoom: 19,
    attribution: "© Esri, HERE, Garmin, OpenStreetMap",
  });

  const mapa = L.map("mapa", {
    center: [-23.5615, -46.6560], zoom: 12, zoomControl: false,
    layers: [sateliteComRuas],
  });
  L.control.zoom({ position: "topright", zoomInTitle: "Aproximar", zoomOutTitle: "Afastar" }).addTo(mapa);
  L.control.layers(
    { "Satélite com ruas": sateliteComRuas, "Satélite": camadaSatelite(), "Mapa de ruas": mapaRuas },
    null,
    { position: "topright" },
  ).addTo(mapa);
  L.control.scale({ position: "bottomleft", imperial: false }).addTo(mapa);

  function icone(e, ativo) {
    const classes = ["pin", e.posicao_aproximada ? "aprox" : "", ativo ? "ativo" : ""].join(" ");
    return L.divIcon({
      className: "marcador",
      html: `<span class="${classes}" style="--c:${corVendas(e)}"></span>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
  }

  function desenharMarcadores() {
    const visiveis = new Set(filtrados().map((e) => e.id));
    for (const [id, m] of estado.marcadores) {
      if (!visiveis.has(id) || !estado.lista.find((e) => e.id === id)) {
        m.remove();
        estado.marcadores.delete(id);
      }
    }
    for (const e of estado.lista) {
      if (!visiveis.has(e.id) || !temValor(e.lat) || !temValor(e.lng)) continue;
      const ativo = estado.selecionado === e.id;
      let m = estado.marcadores.get(e.id);
      if (!m) {
        m = L.marker([e.lat, e.lng], { icon: icone(e, ativo), riseOnHover: true, keyboard: true, title: e.nome });
        m.bindTooltip(esc(e.nome), { direction: "top", offset: [0, -10], className: "rotulo-pin" });
        m.on("click", () => selecionar(e.id, { voar: false }));
        m.addTo(mapa);
        estado.marcadores.set(e.id, m);
      } else {
        if (estado.movendo !== e.id) m.setLatLng([e.lat, e.lng]);
        m.setIcon(icone(e, ativo));
        m.setTooltipContent(esc(e.nome));
      }
      m.setZIndexOffset(ativo ? 1000 : 0);
    }
  }

  // ───────────────────────── lista ─────────────────────────

  function filtrados() {
    const q = normalizar($("#busca").value);
    const inc = $("#filtro-incorporadora").value;
    return estado.lista.filter((e) => {
      if (inc && e.incorporadora !== inc) return false;
      if (!q) return true;
      return normalizar([e.nome, e.bairro, e.incorporadora, e.endereco].join(" ")).includes(q);
    });
  }

  function desenharLista() {
    const itens = filtrados();
    $("#contagem").textContent = `${int.format(estado.lista.length)} ${estado.lista.length === 1 ? "empreendimento" : "empreendimentos"}`;
    $("#lista").innerHTML = itens.map((e) => {
      const sub = [e.status, e.bairro, e.incorporadora].filter(Boolean).join(" · ") || "Sem bairro informado";
      const preco = temValor(e.preco_fechamento_m2) ? e.preco_fechamento_m2 : e.preco_tabela_m2;
      const precoRot = temValor(e.preco_fechamento_m2) ? "fechamento" : temValor(e.preco_tabela_m2) ? "tabela" : "";
      const est = temValor(e.estoque) ? `${int.format(e.estoque)} em estoque` : "";
      return `<li><button class="item-lista" type="button" data-id="${esc(e.id)}">
        <span class="bola${e.posicao_aproximada ? " bola-aprox" : ""}" style="--c:${corVendas(e)}"></span>
        <span class="item-nome">${esc(e.nome)}</span>
        <span class="item-preco">${temValor(preco) ? `<strong class="num">${esc(m2(preco))}</strong>${precoRot}` : ""}</span>
        <span class="item-sub">${esc(sub)}${est ? ` · ${esc(est)}` : ""}</span>
      </button></li>`;
    }).join("");
    const vazio = $("#lista-vazia");
    if (estado.lista.length === 0) {
      vazio.hidden = false;
      vazio.textContent = ESTATICO
        ? "Nenhum lançamento cadastrado ainda. Os primeiros entram assim que a equipe de inteligência de mercado enviar o material."
        : "Nenhum lançamento cadastrado ainda. Clique em “Adicionar informações” e envie a primeira apresentação.";
    } else if (itens.length === 0) {
      vazio.hidden = false;
      vazio.textContent = "Nenhum empreendimento corresponde à busca.";
    } else vazio.hidden = true;
  }

  function atualizarFiltroIncorporadoras() {
    const sel = $("#filtro-incorporadora");
    const atual = sel.value;
    const nomesInc = [...new Set(estado.lista.map((e) => e.incorporadora).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    sel.innerHTML = `<option value="">Todas as incorporadoras</option>` +
      nomesInc.map((n) => `<option ${n === atual ? "selected" : ""}>${esc(n)}</option>`).join("");
  }

  $("#lista").addEventListener("click", (ev) => {
    const b = ev.target.closest(".item-lista");
    if (b) selecionar(b.dataset.id, { voar: true });
  });
  $("#busca").addEventListener("input", () => { desenharLista(); desenharMarcadores(); });
  $("#filtro-incorporadora").addEventListener("change", () => { desenharLista(); desenharMarcadores(); });

  // ───────────────────────── ficha ─────────────────────────

  async function selecionar(id, { voar } = {}) {
    const e = estado.lista.find((x) => x.id === id);
    if (!e) return;
    estado.selecionado = id;
    desenharMarcadores();
    if (voar && temValor(e.lat)) mapa.flyTo([e.lat, e.lng], Math.max(mapa.getZoom(), 16), { duration: 0.8 });
    $("#vista-lista").hidden = true;
    const v = $("#vista-detalhe");
    v.hidden = false;
    v.scrollTop = 0;
    $("#painel").classList.remove("recolhido");
    v.innerHTML = fichaHTML(e, null);
    const hist = await historico(id);
    if (estado.selecionado === id && !v.querySelector(".form-edicao")) v.innerHTML = fichaHTML(e, hist);
  }

  function fecharFicha() {
    estado.selecionado = null;
    $("#vista-detalhe").hidden = true;
    $("#vista-lista").hidden = false;
    desenharMarcadores();
  }

  async function historico(id) {
    if (ESTATICO) return estado.historicoEstatico[id] ?? [];
    if (!CONFIGURADO) return DEMO_HIST[id] ?? [];
    const { data, error } = await sb.from("registros").select("*")
      .eq("empreendimento_id", id)
      .order("data_referencia", { ascending: false, nullsFirst: false })
      .order("criado_em", { ascending: false })
      .limit(50);
    if (error) return [];
    return data;
  }

  function fichaHTML(e, hist) {
    const p = pctVendido(e);
    const d = desconto(e);
    const chips = [];
    if (e.status) chips.push(`<span class="chip chip-status" style="--c:${corVendas(e)}">${esc(e.status)}</span>`);
    if (e.posicao_aproximada) chips.push(`<span class="chip chip-alerta">Posição aproximada</span>`);
    if (e.pesquisa_status === "pendente") chips.push(`<span class="chip">Pesquisa na web pendente</span>`);
    if (e.pesquisa_status === "erro") chips.push(`<span class="chip chip-alerta">Pesquisa na web falhou</span>`);
    if (e.data_referencia) chips.push(`<span class="chip">Data-base ${esc(data(e.data_referencia))}</span>`);

    const fatos = [
      ["Lançamento", data(e.data_lancamento)],
      ["Entrega", e.entrega ? data(e.entrega) : null],
      ["Endereço", e.endereco || "—"],
      ["Bairro", [e.bairro, e.cidade && e.cidade !== "São Paulo" ? e.cidade : null].filter(Boolean).join(" · ") || "—"],
      ["Terreno", temValor(e.area_terreno_m2) ? `${int.format(e.area_terreno_m2)} m²` : "—"],
      ["Produto", e.produto || "—"],
      ["Metragens", e.metragens || "—"],
      ["Vendedora", e.vendedora || null],
    ].filter(([, v]) => v !== null).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("");

    const tips = Array.isArray(e.tipologias) ? e.tipologias : [];
    const temVenda = tips.some((t) => temValor(t.estoque) || temValor(t.vendido_pct));
    const temFech = tips.some((t) => temValor(t.preco_fechamento_m2));
    const tipsHTML = !tips.length ? "" : `<section><h3 class="secao-titulo">Tipologias</h3><div class="tabela-rolagem"><table class="hist">
        <thead><tr><th>Unidade</th><th style="text-align:right">Unid.</th><th style="text-align:right">Vagas</th>
          ${temVenda ? `<th style="text-align:right">Estoque</th><th style="text-align:right">Vend.</th>` : ""}
          <th style="text-align:right">${temFech ? "Fech." : "Tabela"} R$/m²</th><th style="text-align:right">Ticket</th></tr></thead>
        <tbody>${tips.map((t) => {
          const area = t.area_txt || (temValor(t.area) ? `${String(t.area).replace(".", ",")} m²` : "—");
          const desc = [t.descricao, t.dorms ? `${t.dorms} dorm${t.dorms > 1 ? "s" : ""}.` : null, t.tipo && t.tipo !== "Mercado" ? t.tipo : null].filter(Boolean).join(" · ");
          const preco = temFech ? t.preco_fechamento_m2 : (t.preco_atual_m2 || t.preco_lancamento_m2);
          return `<tr><td>${esc(area)}${desc ? `<div class="fonte">${esc(desc)}</div>` : ""}</td>
            <td class="n">${temValor(t.unidades) ? int.format(t.unidades) : "—"}</td>
            <td class="n">${temValor(t.vagas) ? t.vagas : "—"}</td>
            ${temVenda ? `<td class="n">${temValor(t.estoque) ? int.format(t.estoque) : "—"}</td><td class="n">${temValor(t.vendido_pct) ? `${int.format(t.vendido_pct)}%` : "—"}</td>` : ""}
            <td class="n">${temValor(preco) ? int.format(Math.round(preco)) : "—"}</td>
            <td class="n">${esc(ticket(t.ticket))}</td></tr>`;
        }).join("")}</tbody></table></div>
        <p class="nota">Preço e ticket por tipologia; o resumo acima usa a média ponderada pela área vendável.</p></section>`;

    const estoqueBloco = temValor(e.estoque) || temValor(e.total_unidades)
      ? `<div class="largo"><div>
            <div class="rot">Estoque</div>
            <div class="val">${temValor(e.estoque) ? int.format(e.estoque) : "—"}<span class="det"> de ${temValor(e.total_unidades) ? int.format(e.total_unidades) : "—"} unid.</span></div>
          </div>
          <div style="text-align:right;min-width:40%">
            <div class="det">${p === null ? "" : `${pct(p)} vendido`}</div>
            ${p === null ? "" : `<div class="estoque-barra"><span style="width:${(p * 100).toFixed(1)}%;--c:${corVendas(e)}"></span></div>`}
          </div></div>`
      : `<div class="largo"><div><div class="rot">Estoque</div><div class="det">Sem informação ainda</div></div></div>`;

    const precos = `<div class="precos">
        <div><div class="rot">Tabela</div><div class="val">${esc(m2(e.preco_tabela_m2))}</div><div class="det">ticket ${esc(ticket(e.ticket_tabela))}</div></div>
        <div><div class="rot">Fechamento</div><div class="val">${esc(m2(e.preco_fechamento_m2))}</div><div class="det">ticket ${esc(ticket(e.ticket_fechamento))}</div></div>
        ${d !== null ? `<div class="largo"><div class="rot">Desconto médio sobre a tabela</div><div class="val">${pct(d)}</div></div>` : ""}
        ${estoqueBloco}
      </div>`;

    let histHTML = `<p class="nota">Carregando histórico…</p>`;
    if (hist) {
      histHTML = hist.length === 0
        ? `<p class="nota">Ainda não há histórico de estoque e preço.</p>`
        : `<div class="tabela-rolagem"><table class="hist">
            <thead><tr><th>Data-base</th><th style="text-align:right">Estoque</th><th style="text-align:right">Tabela</th><th style="text-align:right">Fech.</th></tr></thead>
            <tbody>${hist.map((h) => `<tr>
              <td>${esc(data(h.data_referencia))}<div class="fonte">${esc(h.fonte_desc || "")}</div></td>
              <td class="n">${temValor(h.estoque) ? int.format(h.estoque) : "—"}</td>
              <td class="n">${temValor(h.preco_tabela_m2) ? int.format(Math.round(h.preco_tabela_m2)) : "—"}</td>
              <td class="n">${temValor(h.preco_fechamento_m2) ? int.format(Math.round(h.preco_fechamento_m2)) : "—"}</td>
            </tr>`).join("")}</tbody></table></div>
            <p class="nota">Preços em R$/m².</p>`;
    }

    const q = encodeURIComponent(temValor(e.lat) ? `${e.lat},${e.lng}` : `${e.endereco || e.nome}, São Paulo`);
    const links = [`<a href="https://www.google.com/maps/search/?api=1&query=${q}" target="_blank" rel="noopener">Abrir no Google Maps</a>`];
    if (temValor(e.lat)) links.push(`<a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${e.lat},${e.lng}" target="_blank" rel="noopener">Street View</a>`);
    if (e.site && /^https?:\/\//.test(e.site)) links.push(`<a href="${esc(e.site)}" target="_blank" rel="noopener">Site do empreendimento</a>`);

    const fontesWeb = Array.isArray(e.pesquisa_fontes) && e.pesquisa_fontes.length
      ? `<p class="nota">Pesquisa na web${e.pesquisa_resumo ? `: ${esc(e.pesquisa_resumo)}` : ""}<br>${e.pesquisa_fontes
          .filter((u) => /^https?:\/\//.test(u)).slice(0, 6)
          .map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(new URL(u).hostname.replace(/^www\./, ""))}</a>`).join(" · ")}</p>`
      : "";

    const equipe = estado.equipe ? `<div class="acoes-equipe">
        <button class="btn btn-peq" type="button" data-acao="editar">Editar dados</button>
        <button class="btn btn-peq" type="button" data-acao="mover">Mover pin</button>
        <button class="btn btn-peq" type="button" data-acao="pesquisar">Pesquisar na web</button>
        <button class="btn btn-peq btn-perigo" type="button" data-acao="excluir">Excluir</button>
      </div>` : "";

    return `<article class="ficha" data-id="${esc(e.id)}">
      <button class="voltar" type="button" data-acao="voltar">← Todos os lançamentos</button>
      <header class="ficha-cabeca">
        <h2>${esc(e.nome)}</h2>
        <p>${esc(e.incorporadora || "Incorporadora não informada")}</p>
        ${chips.length ? `<div class="chips">${chips.join("")}</div>` : ""}
      </header>
      ${precos}
      <dl class="fatos">${fatos}</dl>
      ${e.observacoes ? `<p class="nota">${esc(e.observacoes)}</p>` : ""}
      ${tipsHTML}
      <section><h3 class="secao-titulo">Histórico</h3>${histHTML}</section>
      <div class="links">${links.join("")}</div>
      ${fontesWeb}
      ${equipe}
      <div id="ficha-msg"></div>
    </article>`;
  }

  const CAMPOS_FORM = [
    ["nome", "Nome", "text"], ["incorporadora", "Incorporadora", "text"],
    ["endereco", "Endereço", "text"], ["bairro", "Bairro", "text"],
    ["data_lancamento", "Lançamento (AAAA-MM)", "text"], ["area_terreno_m2", "Terreno (m²)", "number"],
    ["produto", "Produto", "text"], ["metragens", "Metragens", "text"],
    ["total_unidades", "Total de unidades", "number"], ["estoque", "Estoque", "number"],
    ["preco_tabela_m2", "Tabela (R$/m²)", "number"], ["preco_fechamento_m2", "Fechamento (R$/m²)", "number"],
    ["ticket_tabela", "Ticket tabela (R$)", "number"], ["ticket_fechamento", "Ticket fechamento (R$)", "number"],
    ["data_referencia", "Data-base", "date"], ["site", "Site", "text"],
    ["observacoes", "Observações", "textarea"],
  ];
  const LINHAS_FORM = [
    ["nome"], ["incorporadora"], ["endereco"], ["bairro", "data_lancamento"],
    ["produto"], ["metragens", "area_terreno_m2"], ["total_unidades", "estoque"],
    ["preco_tabela_m2", "preco_fechamento_m2"], ["ticket_tabela", "ticket_fechamento"],
    ["data_referencia", "site"], ["observacoes"],
  ];

  function formEdicaoHTML(e) {
    const campo = (c) => {
      const [, rot, tipo] = CAMPOS_FORM.find((x) => x[0] === c);
      const v = e[c] ?? "";
      const entrada = tipo === "textarea"
        ? `<textarea id="ed-${c}" name="${c}" rows="3">${esc(v)}</textarea>`
        : `<input id="ed-${c}" name="${c}" type="${tipo}" ${tipo === "number" ? 'step="any"' : ""} value="${esc(v)}">`;
      return `<div><label class="rotulo" for="ed-${c}">${rot}</label>${entrada}</div>`;
    };
    const linhas = LINHAS_FORM.map((l) => (l.length > 1 ? `<div class="duplo">${l.map(campo).join("")}</div>` : campo(l[0])));
    return `<form class="ficha form-edicao" data-id="${esc(e.id)}">
      <button class="voltar" type="button" data-acao="cancelar-edicao">← Cancelar edição</button>
      <h2>Editar ${esc(e.nome)}</h2>
      <div>${linhas.join("")}</div>
      <p class="nota">Ao mudar estoque ou preço, o valor anterior fica no histórico.</p>
      <p class="erro" id="ed-erro" hidden></p>
      <div class="dialogo-rodape"><button class="btn" type="button" data-acao="cancelar-edicao">Cancelar</button><button class="btn btn-primario" type="submit">Salvar</button></div>
    </form>`;
  }

  $("#vista-detalhe").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-acao]");
    if (!b) return;
    const id = estado.selecionado;
    const e = estado.lista.find((x) => x.id === id);
    const acao = b.dataset.acao;
    if (acao === "voltar") return fecharFicha();
    if (!e) return;
    if (acao === "editar") {
      $("#vista-detalhe").innerHTML = formEdicaoHTML(e);
      $("#vista-detalhe").scrollTop = 0;
    } else if (acao === "cancelar-edicao") {
      selecionar(id);
    } else if (acao === "mover") {
      iniciarMover(e);
    } else if (acao === "pesquisar") {
      b.disabled = true;
      b.textContent = "Pesquisando… (até 2 min)";
      try {
        const r = await funcao("pesquisar", { id });
        substituir(r.empreendimento);
        toast("Pesquisa concluída.");
      } catch (err) {
        toast(err.message);
      }
      await recarregar();
      if (estado.selecionado === id) selecionar(id);
    } else if (acao === "excluir") {
      $("#ficha-msg").innerHTML = `<div class="confirmar"><span>Excluir “${esc(e.nome)}” e todo o histórico?</span>
        <button class="btn btn-peq btn-perigo" type="button" data-acao="excluir-sim">Excluir</button>
        <button class="btn btn-peq" type="button" data-acao="excluir-nao">Manter</button></div>`;
    } else if (acao === "excluir-nao") {
      $("#ficha-msg").innerHTML = "";
    } else if (acao === "excluir-sim") {
      b.disabled = true;
      try {
        await funcao("excluir", { id });
        estado.lista = estado.lista.filter((x) => x.id !== id);
        fecharFicha();
        redesenhar();
        toast("Empreendimento excluído.");
      } catch (err) {
        toast(err.message);
        b.disabled = false;
      }
    }
  });

  $("#vista-detalhe").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const id = form.dataset.id;
    const e = estado.lista.find((x) => x.id === id);
    const campos = {};
    for (const [c] of CAMPOS_FORM) {
      const novo = form.elements[c].value.trim();
      const antigo = e[c] === null || e[c] === undefined ? "" : String(e[c]);
      if (novo !== antigo) campos[c] = novo === "" ? null : novo;
    }
    if (Object.keys(campos).length === 0) return selecionar(id);
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Salvando…";
    try {
      const r = await funcao("editar", { id, campos });
      substituir(r.empreendimento);
      redesenhar();
      selecionar(id);
      toast("Dados salvos.");
    } catch (err) {
      const el = $("#ed-erro");
      el.textContent = err.message;
      el.hidden = false;
      btn.disabled = false;
      btn.textContent = "Salvar";
    }
  });

  // ───────────────────────── mover pin ─────────────────────────

  function iniciarMover(e) {
    let m = estado.marcadores.get(e.id);
    if (!m) {
      const c = mapa.getCenter();
      e.lat = c.lat;
      e.lng = c.lng;
      desenharMarcadores();
      m = estado.marcadores.get(e.id);
    }
    estado.movendo = e.id;
    m.dragging.enable();
    mapa.flyTo(m.getLatLng(), Math.max(mapa.getZoom(), 17), { duration: 0.6 });
    $("#aviso-mover").hidden = false;
  }
  function terminarMover() {
    const m = estado.marcadores.get(estado.movendo);
    if (m) m.dragging.disable();
    estado.movendo = null;
    $("#aviso-mover").hidden = true;
  }
  $("#btn-mover-cancelar").addEventListener("click", () => {
    terminarMover();
    desenharMarcadores();
  });
  $("#btn-mover-ok").addEventListener("click", async () => {
    const id = estado.movendo;
    const m = estado.marcadores.get(id);
    if (!m) return terminarMover();
    const { lat, lng } = m.getLatLng();
    const btn = $("#btn-mover-ok");
    btn.disabled = true;
    try {
      const r = await funcao("editar", { id, campos: { lat, lng, posicao_aproximada: false } });
      substituir(r.empreendimento);
      toast("Posição salva.");
    } catch (err) {
      toast(err.message);
    }
    btn.disabled = false;
    terminarMover();
    redesenhar();
    if (estado.selecionado === id) selecionar(id);
  });

  // ───────────────────────── dados ─────────────────────────

  function substituir(emp) {
    if (!emp) return;
    const i = estado.lista.findIndex((x) => x.id === emp.id);
    if (i >= 0) estado.lista[i] = emp;
    else estado.lista.unshift(emp);
  }

  function redesenhar() {
    atualizarFiltroIncorporadoras();
    desenharLista();
    desenharMarcadores();
  }

  async function recarregar({ enquadrar = false } = {}) {
    if (ESTATICO) {
      try {
        const r = await fetch(`${C.DADOS_JSON}?v=${Date.now()}`, { cache: "no-store" });
        if (!r.ok) throw new Error(`erro ${r.status}`);
        const dados = await r.json();
        estado.lista = (dados.empreendimentos || []).map((e) => ({ pesquisa_fontes: [], ...e }));
        estado.historicoEstatico = dados.historico || {};
        if (dados.atualizado_em) $("#atualizado").textContent = ` · atualizado em ${data(dados.atualizado_em)}`;
      } catch (err) {
        toast(`Não foi possível carregar os lançamentos (${err.message}).`);
        return;
      }
    } else if (!CONFIGURADO) {
      if (!estado.lista.length) estado.lista = DEMO.map((e) => ({ ...e }));
    } else {
      const { data, error } = await sb.from("empreendimentos").select("*").order("atualizado_em", { ascending: false });
      if (error) {
        toast(`Não foi possível carregar os lançamentos: ${error.message}`);
        return;
      }
      estado.lista = data;
    }
    redesenhar();
    if (enquadrar) {
      const pts = estado.lista.filter((e) => temValor(e.lat)).map((e) => [e.lat, e.lng]);
      if (pts.length > 1) mapa.fitBounds(pts, { padding: [60, 60], maxZoom: 15 });
      else if (pts.length === 1) mapa.setView(pts[0], 15);
    }
  }

  // ───────────────────────── equipe ─────────────────────────

  function definirEquipe(ativa) {
    estado.equipe = ativa;
    $("#btn-equipe").textContent = ativa ? "Sair da equipe" : "Entrar como equipe";
    $("#btn-fontes").hidden = !ativa;
    if (estado.selecionado && !$("#vista-detalhe").querySelector(".form-edicao")) selecionar(estado.selecionado);
  }
  function sairEquipe() {
    estado.senha = "";
    gravarSenha("");
    definirEquipe(false);
  }

  function abrir(dlg) {
    if (typeof dlg.showModal === "function") dlg.showModal();
    else dlg.setAttribute("open", "");
  }
  function fechar(dlg) {
    if (typeof dlg.close === "function") dlg.close();
    else dlg.removeAttribute("open");
  }
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-fechar]");
    if (b) fechar(b.closest("dialog"));
  });

  let depoisDeEntrar = null;
  function pedirSenha(proximo) {
    depoisDeEntrar = proximo || null;
    $("#senha").value = "";
    $("#senha-erro").hidden = true;
    abrir($("#dlg-senha"));
    setTimeout(() => $("#senha").focus(), 50);
  }

  $("#btn-equipe").addEventListener("click", () => {
    if (estado.equipe) {
      sairEquipe();
      toast("Você saiu do modo equipe.");
    } else pedirSenha();
  });

  $("#form-senha").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const senha = $("#senha").value;
    const btn = ev.target.querySelector('[type="submit"]');
    btn.disabled = true;
    estado.senha = senha;
    try {
      await funcao("verificar");
      gravarSenha(senha);
      definirEquipe(true);
      fechar($("#dlg-senha"));
      toast("Modo equipe ativo.");
      if (depoisDeEntrar) depoisDeEntrar();
    } catch (err) {
      estado.senha = "";
      $("#senha-erro").textContent = err.message;
      $("#senha-erro").hidden = false;
    }
    btn.disabled = false;
  });

  // ───────────────────────── apresentações enviadas ─────────────────────────

  $("#btn-fontes").addEventListener("click", async () => {
    const box = $("#fontes-conteudo");
    box.innerHTML = `<p class="vazio">Carregando…</p>`;
    abrir($("#dlg-fontes"));
    try {
      const { fontes } = await funcao("listar_fontes");
      if (!fontes.length) {
        box.innerHTML = `<p class="vazio">Nenhum material enviado ainda.</p>`;
        return;
      }
      const tipos = { apresentacao: "Apresentação", print: "Print", texto: "Texto" };
      box.innerHTML = `<table class="fontes"><thead><tr><th>Enviado em</th><th>Material</th><th>Data-base</th><th></th></tr></thead><tbody>
        ${fontes.map((f) => `<tr>
          <td class="num">${esc(new Date(f.criado_em).toLocaleDateString("pt-BR"))}</td>
          <td><strong>${esc(f.nome || tipos[f.tipo] || f.tipo)}</strong>${f.origem ? `<br><span class="nota">${esc(f.origem)}</span>` : ""}${f.resumo ? `<br><span class="nota">${esc(f.resumo)}</span>` : ""}</td>
          <td class="num">${esc(data(f.data_referencia))}</td>
          <td>${f.link ? `<a href="${esc(f.link)}" target="_blank" rel="noopener">Abrir</a>` : ""}</td>
        </tr>`).join("")}</tbody></table>`;
    } catch (err) {
      box.innerHTML = `<p class="erro">${esc(err.message)}</p>`;
    }
  });

  // ───────────────────────── envio de material ─────────────────────────

  const envio = { arquivos: [], fontes: [], itens: [] };

  function mostrarPasso(nome) {
    for (const p of ["envio", "progresso", "revisao", "fim"]) $(`#passo-${p}`).hidden = p !== nome;
  }

  function abrirEnvio() {
    envio.arquivos = [];
    envio.fontes = [];
    envio.itens = [];
    $("#arquivos").value = "";
    $("#texto-livre").value = "";
    $("#envio-erro").hidden = true;
    if (!$("#data-ref").value) $("#data-ref").value = hojeISO();
    desenharArquivos();
    mostrarPasso("envio");
    abrir($("#dlg-adicionar"));
  }

  $("#btn-adicionar").addEventListener("click", () => {
    if (!CONFIGURADO) return toast("Modo de demonstração: configure o Supabase no arquivo config.js para enviar materiais.");
    if (!estado.equipe) return pedirSenha(abrirEnvio);
    abrirEnvio();
  });

  function desenharArquivos() {
    $("#arquivos-lista").innerHTML = envio.arquivos.map((f, i) =>
      `<li><span>${esc(f.name)}</span><button class="btn-x" type="button" data-remover="${i}" aria-label="Remover ${esc(f.name)}">×</button></li>`).join("");
  }
  $("#arquivos-lista").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-remover]");
    if (!b) return;
    envio.arquivos.splice(Number(b.dataset.remover), 1);
    desenharArquivos();
  });
  function adicionarArquivos(lista) {
    for (const f of lista) envio.arquivos.push(f);
    desenharArquivos();
  }
  $("#arquivos").addEventListener("change", (ev) => {
    adicionarArquivos(ev.target.files);
    ev.target.value = "";
  });
  const zona = $("#zona");
  zona.addEventListener("dragover", (ev) => { ev.preventDefault(); zona.classList.add("arrastando"); });
  zona.addEventListener("dragleave", () => zona.classList.remove("arrastando"));
  zona.addEventListener("drop", (ev) => {
    ev.preventDefault();
    zona.classList.remove("arrastando");
    adicionarArquivos(ev.dataTransfer.files);
  });
  // colar print direto (Ctrl+V) com a janela aberta
  $("#dlg-adicionar").addEventListener("paste", (ev) => {
    const imgs = [...(ev.clipboardData?.files || [])].filter((f) => f.type.startsWith("image/"));
    if (imgs.length && $("#passo-envio").hidden === false) {
      ev.preventDefault();
      adicionarArquivos(imgs.map((f, i) => new File([f], `print-colado-${Date.now()}-${i + 1}.png`, { type: f.type })));
    }
  });

  function tipoArquivo(f) {
    const n = f.name.toLowerCase();
    if (n.endsWith(".pdf") || f.type === "application/pdf") return "pdf";
    if (n.endsWith(".pptx")) return "pptx";
    if (/\.(png|jpe?g|webp|gif)$/.test(n) || f.type.startsWith("image/")) return "imagem";
    if (/\.(txt|csv|md)$/.test(n) || f.type.startsWith("text/")) return "texto";
    if (n.endsWith(".ppt")) return "ppt-antigo";
    return "outro";
  }

  function blobParaBase64(blob) {
    return new Promise((ok, falha) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1]);
      r.onerror = () => falha(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function imagemParaJpeg(f) {
    const url = URL.createObjectURL(f);
    try {
      const img = await new Promise((ok, falha) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.onerror = () => falha(new Error(`Não consegui abrir a imagem ${f.name}. Use PNG ou JPG.`));
        i.src = url;
      });
      const max = 1800;
      const escala = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * escala);
      c.height = Math.round(img.naturalHeight * escala);
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.88));
      return { tipo: "imagem", media_type: "image/jpeg", base64: await blobParaBase64(blob) };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function partesDoPdf(f) {
    const buf = await f.arrayBuffer();
    let doc;
    try {
      doc = await PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
    } catch {
      return [{ conteudo: [{ tipo: "pdf", base64: await blobParaBase64(f) }], rotulo: f.name }];
    }
    const n = doc.getPageCount();
    if (n <= PAGINAS_POR_PARTE) return [{ conteudo: [{ tipo: "pdf", base64: await blobParaBase64(f) }], rotulo: f.name }];
    const partes = [];
    for (let i = 0; i < n; i += PAGINAS_POR_PARTE) {
      const fim = Math.min(n, i + PAGINAS_POR_PARTE);
      const novo = await PDFLib.PDFDocument.create();
      const paginas = await novo.copyPages(doc, Array.from({ length: fim - i }, (_, k) => i + k));
      paginas.forEach((p) => novo.addPage(p));
      const bytes = await novo.save();
      partes.push({
        conteudo: [{ tipo: "pdf", base64: await blobParaBase64(new Blob([bytes], { type: "application/pdf" })) }],
        rotulo: `${f.name} · páginas ${i + 1} a ${fim}`,
      });
    }
    return partes;
  }

  async function partesDoPptx(f) {
    const zip = await JSZip.loadAsync(await f.arrayBuffer());
    const slides = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()));
    if (!slides.length) throw new Error(`Não encontrei slides em ${f.name}.`);
    const textos = [];
    for (const [i, nome] of slides.entries()) {
      const xml = new DOMParser().parseFromString(await zip.file(nome).async("string"), "application/xml");
      const linhas = [];
      for (const tr of xml.getElementsByTagName("a:tr")) {
        const celulas = [...tr.getElementsByTagName("a:tc")].map((tc) =>
          [...tc.getElementsByTagName("a:t")].map((t) => t.textContent).join(" ").trim());
        linhas.push(`| ${celulas.join(" | ")} |`);
      }
      for (const p of xml.getElementsByTagName("a:p")) {
        let dentroTabela = false;
        for (let el = p.parentNode; el; el = el.parentNode) if (el.nodeName === "a:tc") { dentroTabela = true; break; }
        if (dentroTabela) continue;
        const t = [...p.getElementsByTagName("a:t")].map((x) => x.textContent).join("").trim();
        if (t) linhas.push(t);
      }
      textos.push(`--- Slide ${i + 1} ---\n${linhas.join("\n")}`);
    }
    const partes = [];
    for (let i = 0; i < textos.length; i += SLIDES_POR_PARTE) {
      const fim = Math.min(textos.length, i + SLIDES_POR_PARTE);
      partes.push({
        conteudo: [{ tipo: "texto", texto: textos.slice(i, fim).join("\n\n") }],
        rotulo: `${f.name} · slides ${i + 1} a ${fim}`,
      });
    }
    return partes;
  }

  async function enviarOriginal(f, fonte) {
    try {
      const { caminho, token } = await funcao("upload_url", { nome: f.name });
      const { error } = await sb.storage.from(BUCKET).uploadToSignedUrl(caminho, token, f, { contentType: f.type || undefined });
      if (error) throw error;
      fonte.caminho = caminho;
    } catch (err) {
      console.warn("Falha ao guardar o arquivo original", err);
    }
  }

  function linhaProgresso(texto, alvo = "#progresso") {
    const li = document.createElement("li");
    li.innerHTML = `<span>${esc(texto)}</span>`;
    $(alvo).append(li);
    const detalhe = (det) => { if (det) li.firstElementChild.insertAdjacentHTML("beforeend", `<small>${esc(det)}</small>`); };
    return {
      ok(det) { li.className = "ok"; detalhe(det); },
      falha(det) { li.className = "falha"; detalhe(det); },
      info(det) { li.className = "info"; detalhe(det); },
    };
  }

  async function emParalelo(tarefas, limite) {
    const resultados = new Array(tarefas.length);
    let proxima = 0;
    async function trabalhador() {
      while (proxima < tarefas.length) {
        const i = proxima++;
        try { resultados[i] = { ok: true, valor: await tarefas[i]() }; } catch (erro) { resultados[i] = { ok: false, erro }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limite, tarefas.length) }, trabalhador));
    return resultados;
  }

  $("#btn-ler").addEventListener("click", async () => {
    const texto = $("#texto-livre").value.trim();
    const origem = $("#origem").value.trim();
    const dataRef = $("#data-ref").value || null;
    const erro = $("#envio-erro");
    erro.hidden = true;
    if (!envio.arquivos.length && !texto) {
      erro.textContent = "Escolha pelo menos um arquivo ou cole um texto.";
      erro.hidden = false;
      return;
    }
    const recusados = envio.arquivos.filter((f) => ["ppt-antigo", "outro"].includes(tipoArquivo(f)));
    if (recusados.length) {
      erro.textContent = `Formato não suportado: ${recusados.map((f) => f.name).join(", ")}. Salve como PDF (ou .pptx) e envie de novo.`;
      erro.hidden = false;
      return;
    }

    mostrarPasso("progresso");
    $("#progresso").innerHTML = "";
    envio.fontes = [];
    envio.itens = [];
    const tarefas = [];
    const guardar = [];
    const imagens = [];

    for (const f of envio.arquivos) {
      const tipo = tipoArquivo(f);
      const idx = envio.fontes.length;
      const fonte = { tipo: tipo === "imagem" ? "print" : "apresentacao", nome: f.name, origem, data_referencia: dataRef };
      envio.fontes.push(fonte);
      guardar.push(enviarOriginal(f, fonte));
      if (tipo === "imagem") { imagens.push({ f, idx }); continue; }

      const prep = linhaProgresso(`Preparando ${f.name}`);
      let partes;
      try {
        partes = tipo === "pdf" ? await partesDoPdf(f)
          : tipo === "pptx" ? await partesDoPptx(f)
          : [{ conteudo: [{ tipo: "texto", texto: await f.text() }], rotulo: f.name }];
        prep.ok(partes.length > 1 ? `${partes.length} partes para ler` : null);
      } catch (err) {
        prep.falha(err.message);
        continue;
      }
      partes.forEach((p, k) => tarefas.push({ ...p, idx, nome: f.name, parte: partes.length > 1 ? `${k + 1} de ${partes.length}` : null }));
    }

    for (let i = 0; i < imagens.length; i += IMAGENS_POR_PARTE) {
      const grupo = imagens.slice(i, i + IMAGENS_POR_PARTE);
      const prep = linhaProgresso(`Preparando ${grupo.length === 1 ? grupo[0].f.name : `${grupo.length} imagens`}`);
      try {
        const conteudo = [];
        for (const { f } of grupo) conteudo.push(await imagemParaJpeg(f));
        prep.ok();
        tarefas.push({ conteudo, idx: grupo[0].idx, nome: grupo.map((g) => g.f.name).join(", "), rotulo: grupo.map((g) => g.f.name).join(", ") });
      } catch (err) {
        prep.falha(err.message);
      }
    }

    if (texto) {
      const idx = envio.fontes.length;
      envio.fontes.push({ tipo: "texto", nome: "Texto colado", texto, origem, data_referencia: dataRef });
      tarefas.push({ conteudo: [{ tipo: "texto", texto }], idx, nome: "Texto colado", rotulo: "Texto colado" });
    }

    const linhas = tarefas.map((t) => linhaProgresso(`Lendo ${t.rotulo}`));
    const resultados = await emParalelo(tarefas.map((t, i) => async () => {
      const r = await funcao("extrair", {
        conteudo: t.conteudo, nome_arquivo: t.nome, parte: t.parte, origem, data_referencia: dataRef,
      });
      const n = r.itens?.length ?? 0;
      linhas[i].ok(n ? `${n} ${n === 1 ? "empreendimento encontrado" : "empreendimentos encontrados"}` : "Nenhum lançamento encontrado nesta parte");
      return r;
    }), LEITURAS_SIMULTANEAS);

    resultados.forEach((r, i) => {
      if (!r.ok) return linhas[i].falha(r.erro.message);
      const fonte = envio.fontes[tarefas[i].idx];
      if (!fonte.resumo && r.valor.resumo) fonte.resumo = r.valor.resumo;
      if (!fonte.data_referencia && r.valor.data_referencia_documento) fonte.data_referencia = r.valor.data_referencia_documento;
      for (const it of r.valor.itens || []) envio.itens.push({ ...it, fonte_idx: tarefas[i].idx });
    });
    const g = linhaProgresso("Guardando os arquivos originais");
    await Promise.all(guardar);
    g.ok();

    envio.itens = juntarItens(envio.itens);
    if (!envio.itens.length) {
      linhaProgresso("Nenhum lançamento foi encontrado no material.").info("Confira se o arquivo tem nomes de empreendimentos e números de estoque ou preço.");
      $("#passo-progresso").insertAdjacentHTML("beforeend", `<div class="dialogo-rodape"><button class="btn" type="button" id="btn-tentar">Voltar</button></div>`);
      $("#btn-tentar").addEventListener("click", () => { $("#btn-tentar").parentElement.remove(); mostrarPasso("envio"); });
      return;
    }
    desenharRevisao();
    mostrarPasso("revisao");
  });

  function juntarItens(itens) {
    const ids = new Set(estado.lista.map((e) => e.id));
    const mapaItens = new Map();
    for (const it of itens) {
      if (it.empreendimento_id && !ids.has(it.empreendimento_id)) it.empreendimento_id = null;
      const k = it.empreendimento_id || normalizar(it.nome);
      if (!k) continue;
      const atual = mapaItens.get(k);
      if (!atual) { mapaItens.set(k, { ...it }); continue; }
      for (const [c, v] of Object.entries(it)) if (!temValor(atual[c]) && temValor(v)) atual[c] = v;
    }
    return [...mapaItens.values()];
  }

  function resumoItem(it) {
    const d = [];
    if (temValor(it.estoque)) d.push(["Estoque", `${int.format(it.estoque)}${temValor(it.total_unidades) ? ` de ${int.format(it.total_unidades)}` : ""}`]);
    else if (temValor(it.total_unidades)) d.push(["Unidades", int.format(it.total_unidades)]);
    if (temValor(it.preco_tabela_m2)) d.push(["Tabela", m2(it.preco_tabela_m2)]);
    if (temValor(it.preco_fechamento_m2)) d.push(["Fechamento", m2(it.preco_fechamento_m2)]);
    if (temValor(it.ticket_tabela)) d.push(["Ticket tab.", ticket(it.ticket_tabela)]);
    if (temValor(it.ticket_fechamento)) d.push(["Ticket fech.", ticket(it.ticket_fechamento)]);
    if (it.bairro) d.push(["Bairro", it.bairro]);
    if (it.endereco) d.push(["Endereço", it.endereco]);
    if (it.data_lancamento) d.push(["Lançamento", data(it.data_lancamento)]);
    if (temValor(it.area_terreno_m2)) d.push(["Terreno", `${int.format(it.area_terreno_m2)} m²`]);
    if (it.produto) d.push(["Produto", it.produto]);
    if (it.data_referencia) d.push(["Data-base", data(it.data_referencia)]);
    return d.map(([k, v]) => `<li><b>${esc(k)}</b> ${esc(v)}</li>`).join("");
  }

  function desenharRevisao() {
    const existentes = [...estado.lista].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    const nNovos = envio.itens.filter((i) => !i.empreendimento_id).length;
    const nAtual = envio.itens.length - nNovos;
    $("#revisao-resumo").textContent =
      `A IA encontrou ${envio.itens.length} ${envio.itens.length === 1 ? "empreendimento" : "empreendimentos"}: ` +
      `${nAtual} já no mapa e ${nNovos} ${nNovos === 1 ? "novo" : "novos"}. Confira, ajuste se precisar e salve. Os novos serão pesquisados na web em seguida.`;
    $("#revisao").innerHTML = envio.itens.map((it, i) => `
      <div class="rev-item" data-i="${i}">
        <input type="checkbox" id="rev-ok-${i}" checked aria-label="Incluir ${esc(it.nome)}">
        <div class="rev-corpo">
          <div class="rev-topo">
            <input type="text" id="rev-nome-${i}" value="${esc(it.nome)}" aria-label="Nome do empreendimento">
            <select id="rev-destino-${i}" aria-label="O que fazer">
              <option value="">Criar pin novo</option>
              ${existentes.map((e) => `<option value="${esc(e.id)}" ${e.id === it.empreendimento_id ? "selected" : ""}>Atualizar: ${esc(e.nome)}</option>`).join("")}
            </select>
          </div>
          <ul class="rev-dados">${resumoItem(it) || "<li>Sem números</li>"}</ul>
          ${it.observacao ? `<p class="rev-obs">${esc(it.observacao)}</p>` : ""}
        </div>
      </div>`).join("");
  }

  $("#revisao").addEventListener("change", (ev) => {
    if (ev.target.type === "checkbox") ev.target.closest(".rev-item").classList.toggle("desligado", !ev.target.checked);
  });
  $("#btn-voltar-envio").addEventListener("click", () => mostrarPasso("envio"));

  $("#btn-aplicar").addEventListener("click", async () => {
    const itens = [];
    envio.itens.forEach((it, i) => {
      if (!$(`#rev-ok-${i}`).checked) return;
      itens.push({ ...it, nome: $(`#rev-nome-${i}`).value.trim() || it.nome, empreendimento_id: $(`#rev-destino-${i}`).value || null });
    });
    const erro = $("#revisao-erro");
    erro.hidden = true;
    if (!itens.length) {
      erro.textContent = "Marque pelo menos um empreendimento.";
      erro.hidden = false;
      return;
    }
    const btn = $("#btn-aplicar");
    btn.disabled = true;
    btn.textContent = "Salvando…";
    let res;
    try {
      res = await funcao("aplicar", { fontes: envio.fontes, itens });
    } catch (err) {
      erro.textContent = err.message;
      erro.hidden = false;
      btn.disabled = false;
      btn.textContent = "Salvar no mapa";
      return;
    }
    btn.disabled = false;
    btn.textContent = "Salvar no mapa";
    mostrarPasso("fim");
    $("#progresso-fim").innerHTML = "";
    if (res.atualizados.length) linhaProgresso(`${res.atualizados.length} ${res.atualizados.length === 1 ? "empreendimento atualizado" : "empreendimentos atualizados"}`, "#progresso-fim").ok(res.atualizados.map((e) => e.nome).join(", "));
    if (res.criados.length) linhaProgresso(`${res.criados.length} ${res.criados.length === 1 ? "pin novo criado" : "pins novos criados"}`, "#progresso-fim").ok(res.criados.map((e) => e.nome).join(", "));
    await recarregar();

    for (const novo of res.criados) {
      const l = linhaProgresso(`Pesquisando na web: ${novo.nome}`, "#progresso-fim");
      try {
        const r = await funcao("pesquisar", { id: novo.id });
        substituir(r.empreendimento);
        redesenhar();
        l.ok(r.empreendimento.posicao_aproximada ? "Endereço exato não encontrado; o pin ficou na posição aproximada." : "Dados completados e pin posicionado.");
      } catch (err) {
        l.falha(`${err.message} Dá para tentar de novo na ficha do empreendimento.`);
      }
    }
    if (res.criados.length) linhaProgresso("Pronto. Os pins com borda tracejada estão em posição aproximada; use “Mover pin” na ficha para corrigir.", "#progresso-fim").info();
    await recarregar();
  });

  // ───────────────────────── celular: gaveta ─────────────────────────

  $("#alca").addEventListener("click", () => $("#painel").classList.toggle("recolhido"));

  // ───────────────────────── demonstração ─────────────────────────

  const DEMO = [
    {
      id: "demo-1", nome: "Exemplo · Residencial Jardim das Acácias", incorporadora: "Incorporadora Exemplo A",
      endereco: "Rua Exemplo, 100 – Vila Mariana", bairro: "Vila Mariana", lat: -23.5869, lng: -46.6368,
      posicao_aproximada: false, data_lancamento: "2026-03", area_terreno_m2: 2150, produto: "Residencial vertical, 2 e 3 dorms, 1 torre",
      metragens: "62 a 98 m²", total_unidades: 168, estoque: 41, preco_tabela_m2: 15200, preco_fechamento_m2: 14100,
      ticket_tabela: 1150000, ticket_fechamento: 1070000, data_referencia: "2026-10-15", pesquisa_status: "concluida", pesquisa_fontes: [],
      observacoes: "Dados fictícios para demonstração.",
    },
    {
      id: "demo-2", nome: "Exemplo · Vista Pinheiros Studios", incorporadora: "Incorporadora Exemplo B",
      endereco: "Rua Exemplo, 250 – Pinheiros", bairro: "Pinheiros", lat: -23.5663, lng: -46.6917,
      posicao_aproximada: false, data_lancamento: "2026-06", area_terreno_m2: 980, produto: "Studios e 1 dorm, uso misto",
      metragens: "24 a 41 m²", total_unidades: 312, estoque: 187, preco_tabela_m2: 19800, preco_fechamento_m2: 17900,
      ticket_tabela: 590000, ticket_fechamento: 540000, data_referencia: "2026-10-15", pesquisa_status: "concluida", pesquisa_fontes: [],
      observacoes: "Dados fictícios para demonstração.",
    },
    {
      id: "demo-3", nome: "Exemplo · Parque Tatuapé Residence", incorporadora: "Incorporadora Exemplo A",
      endereco: null, bairro: "Tatuapé", lat: -23.5401, lng: -46.5762,
      posicao_aproximada: true, data_lancamento: "2025-11", area_terreno_m2: null, produto: "Residencial vertical, 3 dorms, 2 torres",
      metragens: "84 a 126 m²", total_unidades: 220, estoque: 96, preco_tabela_m2: 11900, preco_fechamento_m2: null,
      ticket_tabela: null, ticket_fechamento: null, data_referencia: "2026-09-30", pesquisa_status: "pendente", pesquisa_fontes: [],
      observacoes: "Dados fictícios para demonstração.",
    },
    {
      id: "demo-4", nome: "Exemplo · Brooklin Office & Living", incorporadora: "Incorporadora Exemplo C",
      endereco: "Avenida Exemplo, 1200 – Brooklin", bairro: "Brooklin", lat: -23.6085, lng: -46.6950,
      posicao_aproximada: false, data_lancamento: "2026-08", area_terreno_m2: 3400, produto: "Uso misto: residencial 2 e 3 dorms + lajes",
      metragens: "70 a 140 m²", total_unidades: 260, estoque: null, preco_tabela_m2: 17400, preco_fechamento_m2: null,
      ticket_tabela: null, ticket_fechamento: null, data_referencia: "2026-10-15", pesquisa_status: "concluida", pesquisa_fontes: [],
      observacoes: "Dados fictícios para demonstração.",
    },
  ];
  const DEMO_HIST = {
    "demo-1": [
      { data_referencia: "2026-10-15", estoque: 41, preco_tabela_m2: 15200, preco_fechamento_m2: 14100, fonte_desc: "Exemplo · apresentação de outubro" },
      { data_referencia: "2026-07-10", estoque: 63, preco_tabela_m2: 14800, preco_fechamento_m2: 13900, fonte_desc: "Exemplo · print de WhatsApp" },
      { data_referencia: "2026-04-02", estoque: 110, preco_tabela_m2: 14500, preco_fechamento_m2: null, fonte_desc: "Exemplo · apresentação de abril" },
    ],
  };

  // ───────────────────────── início ─────────────────────────

  if (window.matchMedia("(max-width: 760px)").matches) $("#legenda").open = false;
  if (ESTATICO) {
    $("#btn-adicionar").hidden = true;
    $("#btn-equipe").hidden = true;
  } else if (!CONFIGURADO) {
    document.body.classList.add("demo");
    $("#demo").hidden = false;
  }
  recarregar({ enquadrar: true });
  if (CONFIGURADO) {
    if (estado.senha) funcao("verificar").then(() => definirEquipe(true)).catch(() => sairEquipe());
    setInterval(() => { if (!document.hidden && !estado.movendo) recarregar(); }, 120000);
  }
})();
