// Roda dentro da página do Google Maps.
// • Salvar uma empresa: lê na tela os dados da empresa aberta, mostra para conferir e manda para o Prospecta.
// • Coletar uma busca: percorre a lista de resultados (até o limite escolhido), junta tudo numa lista
//   SEM enviar, avisa as repetidas, e só envia quando a pessoa clica em "Enviar".
(() => {
  if (window.__prospectaExt) return;
  window.__prospectaExt = true;

  const enviar = (msg) => chrome.runtime.sendMessage(msg);
  const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
  const semAcento = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const soDigitos = (s) => String(s || '').replace(/\D/g, '');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI',
    'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
  // velocidade da coleta: pausa entre uma empresa e outra + tempo extra para o telefone/endereço aparecerem
  const VELOCIDADES = {
    lenta: { nome: 'Lenta', pausa: 2500, carregar: 1200 },
    normal: { nome: 'Normal', pausa: 1000, carregar: 700 },
    rapida: { nome: 'Rápida', pausa: 350, carregar: 450 },
    personalizada: { nome: 'Personalizada', pausa: 1000, carregar: 400 },
  };
  // Personalizada: a pessoa escolhe a pausa (em milissegundos, pode ser 0).
  // O mínimo de 400 ms para o telefone e o endereço aparecerem continua valendo, senão eles vêm vazios.
  const CARREGAR_MINIMO = 400;
  let pref = { limite: 20, infinito: false, velocidade: 'normal', pausa_ms: 1000 };
  const velocidadeAtual = () => (pref.velocidade === 'personalizada'
    ? { nome: 'Personalizada', pausa: Math.max(0, Number(pref.pausa_ms) || 0), carregar: CARREGAR_MINIMO }
    : VELOCIDADES[pref.velocidade] || VELOCIDADES.normal);
  chrome.storage.local.get('pref_coleta').then((d) => { if (d.pref_coleta) pref = { ...pref, ...d.pref_coleta }; });
  const guardarPref = () => chrome.storage.local.set({ pref_coleta: pref });

  // ==================================================================
  // 1) LER A TELA DO MAPS
  // Os "endereços" abaixo (classes e data-item-id) são os que o Maps usa hoje.
  // Se o Google mudar a página, é aqui que se ajusta.
  // ==================================================================
  const tirarRotulo = (t) => (t || '').replace(/^[^:]{1,25}:\s*/, '').trim(); // "Endereço: Rua X" → "Rua X"

  function lerEmpresa() {
    const titulo = document.querySelector('h1.DUwDvf') || document.querySelector('div[role="main"] h1');
    const nome = titulo?.textContent.trim();
    if (!nome) return null;
    const painel = titulo.closest('div[role="main"]') || document;

    const btnEnd = painel.querySelector('button[data-item-id="address"]');
    const endereco = btnEnd ? tirarRotulo(btnEnd.getAttribute('aria-label') || btnEnd.textContent) : '';
    const btnTel = painel.querySelector('button[data-item-id^="phone:tel:"], a[data-item-id^="phone:tel:"]');
    const telefone = btnTel ? formatarTelefone(btnTel.getAttribute('data-item-id').replace('phone:tel:', '')) : '';
    const site = painel.querySelector('a[data-item-id="authority"]')?.href || '';
    const btnCat = painel.querySelector('button.DkEaL') || painel.querySelector('button[jsaction*="category"]');
    const categoria = btnCat?.textContent.trim() || '';
    const link = location.href.split('/data=')[0];

    // sem endereço, sem telefone e sem o título de empresa: é uma lista, não uma empresa
    if (!btnEnd && !btnTel && !document.querySelector('h1.DUwDvf')) return null;
    return { nome, telefone, site, categoria, link, endereco, ...separarEndereco(endereco) };
  }

  // "+5581999990000" → "(81) 99999-0000"
  function formatarTelefone(t) {
    let d = soDigitos(t);
    if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
    if (/^0[3589]00/.test(d)) return String(t).trim(); // 0800, 0300...
    if (d.startsWith('0') && (d.length === 11 || d.length === 12)) d = d.slice(1); // "011919250707" → "11919250707"
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return String(t).trim();
  }

  // "Av. Boa Viagem, 1000 - Boa Viagem, Recife - PE, 51011-000" → { estado: 'PE', cidade: 'Recife', bairro: 'Boa Viagem' }
  function separarEndereco(end) {
    const partes = (end || '').split(',').map((p) => p.trim()).filter(Boolean);
    for (let i = partes.length - 1; i >= 0; i--) {
      const m = partes[i].match(/^(.+?)\s+-\s+([A-Z]{2})$/);
      if (m && UFS.includes(m[2])) {
        const anterior = partes[i - 1] || '';
        const bairro = anterior.includes(' - ') ? anterior.split(' - ').pop().trim() : '';
        return { cidade: m[1].trim(), estado: m[2], bairro };
      }
    }
    const m = (end || '').match(/([^,\-]+?)\s+-\s+([A-Z]{2})\b/);
    if (m && UFS.includes(m[2])) return { cidade: m[1].trim(), estado: m[2], bairro: '' };
    return { cidade: '', estado: '', bairro: '' };
  }

  // lista de resultados da busca (coluna da esquerda)
  const lerFeed = () => document.querySelector('div[role="feed"]');
  const linksDoFeed = (feed) => [...feed.querySelectorAll('a.hfpxzc, a[href*="/maps/place/"]')]
    .filter((a, i, todos) => a.getAttribute('aria-label') && todos.findIndex((b) => b.href === a.href) === i);
  // o que foi pesquisado no Maps ("fotógrafo"): tenta a caixa de pesquisa, depois o título da lista, depois o endereço da página
  function termoBuscado() {
    const caixa = document.querySelector('#searchboxinput, input[name="q"], form[role="search"] input, input[aria-label*="esquis"], input[aria-label*="Search"]');
    if (caixa?.value?.trim()) return caixa.value.trim();
    const titulo = lerFeed()?.getAttribute('aria-label') || '';
    const m = titulo.match(/^(?:Resultados para|Results for)\s+(.+)$/i);
    if (m) return m[1].trim();
    const u = location.pathname.match(/\/maps\/search\/([^/@]+)/);
    if (u) { try { return decodeURIComponent(u[1].replace(/\+/g, ' ')).trim(); } catch { /* endereço estranho */ } }
    return '';
  }
  // "fotógrafo em recife" → "Fotógrafo" (tira o lugar e deixa a primeira letra maiúscula)
  function nichoDaPesquisa(termo) {
    let t = String(termo || '').replace(/\s+(em|no|na|nos|nas|perto de|próximo a|proximo a)\s+.+$/i, '').trim();
    if (!t) return '';
    const igual = nichoParecido(t);
    if (igual) return igual.nome;
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // ==================================================================
  // 2) TELA (shadow DOM, para o estilo do Maps não bagunçar)
  // ==================================================================
  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483000; top: 0; left: 0;';
  document.documentElement.appendChild(host);
  const raiz = host.attachShadow({ mode: 'open' });
  raiz.innerHTML = `
  <style>
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .barra { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); display: flex; gap: 8px; max-width: 80vw; }
    .pilula { display: flex; align-items: center; gap: 8px; border: 0; border-radius: 999px; padding: 11px 18px; font-size: 14px;
      font-weight: 600; box-shadow: 0 6px 20px rgba(30, 27, 75, .35); cursor: pointer; white-space: nowrap; max-width: 46vw; }
    .pilula span { overflow: hidden; text-overflow: ellipsis; }
    .pilula.roxa { background: #4f46e5; color: #fff; }
    .pilula.roxa:hover { background: #4338ca; }
    .pilula.branca { background: #fff; color: #4338ca; }
    .pilula.branca:hover { background: #eef0ff; }
    .pilula svg { width: 18px; height: 18px; flex: none; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
    .janela { position: fixed; right: 16px; top: 72px; width: 390px; max-height: calc(100vh - 96px); overflow: auto; background: #fff;
      color: #15171c; border-radius: 16px; box-shadow: 0 12px 40px rgba(15, 23, 42, .28); font-size: 14px; }
    .cab { position: sticky; top: 0; background: #fff; display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 14px 16px; border-bottom: 1px solid #e3e5ea; z-index: 2; }
    .cab strong { font-size: 15px; }
    .cab .acoes { display: flex; gap: 6px; align-items: center; }
    .x, .voltar { border: 0; background: #f1f2f5; height: 30px; border-radius: 999px; cursor: pointer; font-size: 13px; color: #5e6370; font-weight: 600; }
    .x { width: 30px; font-size: 16px; }
    .voltar { padding: 0 12px; }
    .corpo { padding: 14px 16px 16px; display: grid; gap: 11px; }
    label { display: grid; gap: 5px; font-size: 12.5px; font-weight: 600; color: #5e6370; }
    input, select, textarea { font: inherit; font-size: 14px; color: #15171c; padding: 8px 10px; border: 1px solid #d5d8de; border-radius: 9px;
      outline: none; background: #fff; width: 100%; }
    textarea { resize: vertical; min-height: 56px; }
    input:focus, select:focus, textarea:focus { border-color: #4f46e5; box-shadow: 0 0 0 3px #4f46e522; }
    .tres { display: grid; grid-template-columns: 0.9fr 1.1fr 1.1fr; gap: 8px; }
    .duas { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .status { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .status button { font: inherit; font-size: 13px; font-weight: 600; padding: 8px 4px; border-radius: 9px; border: 1px solid #d5d8de;
      background: #fff; cursor: pointer; color: #15171c; }
    .status button[data-s="aceitou"].sel { background: #dcfce7; border-color: #16a34a; color: #15803d; }
    .status button[data-s="pensando"].sel { background: #fef3c7; border-color: #d97706; color: #b45309; }
    .status button[data-s="recusou"].sel { background: #fee2e2; border-color: #dc2626; color: #b91c1c; }
    .prim { font: inherit; font-weight: 600; background: #4f46e5; color: #fff; border: 0; border-radius: 10px; padding: 11px; cursor: pointer; width: 100%; }
    .prim:disabled { opacity: .55; cursor: default; }
    .sec { font: inherit; font-weight: 600; background: #f1f2f5; color: #15171c; border: 0; border-radius: 10px; padding: 10px; cursor: pointer; width: 100%; }
    .sec.perigo { color: #b91c1c; background: #fef2f2; }
    .dica { margin: 0; font-size: 12px; color: #6b7080; font-weight: 500; }
    .erro { margin: 0; font-size: 13px; color: #dc2626; }
    .aviso { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 10px; padding: 10px 12px; display: grid; gap: 6px; font-size: 13px; }
    .aviso b { color: #9a3412; }
    .aviso ul { margin: 0; padding-left: 18px; }
    .ok { text-align: center; padding: 26px 16px; display: grid; gap: 10px; }
    .ok .icone { width: 52px; height: 52px; margin: 0 auto; border-radius: 50%; background: #dcfce7; color: #16a34a; display: grid; place-items: center; font-size: 28px; }
    .ok strong { font-size: 16px; }
    .quem { font-size: 12px; color: #6b7080; margin: 0; }
    .progresso { height: 8px; background: #eef0f3; border-radius: 99px; overflow: hidden; }
    .progresso i { display: block; height: 100%; background: #4f46e5; border-radius: 99px; transition: width .3s; }
    .resumo { display: flex; gap: 6px; flex-wrap: wrap; }
    .chip { font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 99px; background: #f1f2f5; color: #3f4350; }
    .chip.nova { background: #eef0ff; color: #4338ca; }
    .chip.rep { background: #fff7ed; color: #9a3412; }
    .chip.env { background: #dcfce7; color: #15803d; }
    .chip.err { background: #fee2e2; color: #b91c1c; }
    .lista { display: grid; gap: 6px; }
    .item { border: 1px solid #e3e5ea; border-radius: 11px; padding: 9px 11px; display: grid; gap: 4px; }
    .item.rep { border-color: #fed7aa; background: #fffbf5; }
    .item.env { opacity: .6; }
    .item-topo { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
    .item-topo strong { font-size: 13.5px; line-height: 1.3; }
    .item small { font-size: 12px; color: #6b7080; }
    .item-acoes { display: flex; gap: 6px; margin-top: 2px; }
    .item-acoes button { font: inherit; font-size: 12px; font-weight: 600; border: 0; border-radius: 8px; padding: 5px 10px; cursor: pointer; background: #f1f2f5; color: #15171c; }
    .item-acoes button.revisar { background: #eef0ff; color: #4338ca; }
    [hidden] { display: none !important; }
  </style>
  <div class="barra">
    <button class="pilula branca" id="btn-coletar" hidden>
      <svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/><path d="M20.5 18.5 22 20"/></svg><span id="btn-coletar-txt">Coletar esta busca</span>
    </button>
    <button class="pilula roxa" id="btn-salvar" hidden>
      <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span id="btn-salvar-txt">Salvar no Prospecta</span>
    </button>
  </div>
  <div class="janela" id="janela" hidden>
    <div class="cab">
      <strong id="titulo">Prospecta</strong>
      <div class="acoes"><button class="voltar" id="voltar" hidden>‹ Lista</button><button class="x" id="fechar" title="Fechar">✕</button></div>
    </div>
    <div id="conteudo"></div>
  </div>`;

  const $ = (s) => raiz.querySelector(s);
  let marca = 'Prospecta';
  let usuario = null;
  let nichos = [];
  let tela = null;            // 'login' | 'form' | 'ok' | 'coleta'
  let empresaDaTela = null;   // nome da empresa mostrada no formulário / "salvo"
  let telaDepoisLogin = null; // para onde voltar depois de entrar

  // a lista coletada fica guardada (não some se a página do Maps recarregar)
  let fila = [];       // { id, nome, telefone, estado, cidade, bairro, site, categoria, link, situacao, repetida_por, erro }
  let coleta = { rodando: false, parar: false, alvo: 0, termo: '' };
  const guardarFila = () => chrome.storage.local.set({ fila });
  // empresas da busca que já foram olhadas (para o "Continuar" seguir de onde parou)
  let vistosBusca = { termo: '', links: [], acabou: false };
  chrome.storage.local.get('vistos_busca').then((d) => { if (d.vistos_busca) vistosBusca = d.vistos_busca; });
  const guardarVistos = () => chrome.storage.local.set({ vistos_busca: vistosBusca });
  const chaveLink = (href) => String(href || '').split('?')[0].split('/data=')[0];

  enviar({ tipo: 'estado' }).then((e) => {
    marca = e.marca || marca;
    usuario = e.usuario;
  }).catch(() => {});
  chrome.storage.local.get('fila').then((d) => { fila = Array.isArray(d.fila) ? d.fila : []; });

  // ---------- botões flutuantes: aparecem conforme o que está na tela ----------
  setInterval(() => {
    const e = lerEmpresa();
    const feed = lerFeed();
    const janelaAberta = !$('#janela').hidden;

    // trocou de empresa com o formulário ou o "salvo" aberto → fecha, para o botão voltar
    if (janelaAberta && (tela === 'form' || tela === 'ok') && e && empresaDaTela && semAcento(e.nome) !== semAcento(empresaDaTela)) {
      fecharJanela();
    }

    const formAberto = !$('#janela').hidden && (tela === 'form' || tela === 'ok' || tela === 'login');
    $('#btn-salvar').hidden = !e || formAberto || coleta.rodando;
    if (e) $('#btn-salvar-txt').textContent = `Salvar “${e.nome}” no ${marca}`;

    $('#btn-coletar').hidden = (!feed && !fila.length) || coleta.rodando || (!$('#janela').hidden && tela === 'coleta');
    $('#btn-coletar-txt').textContent = fila.length ? `Lista coletada (${fila.length})` : 'Coletar esta busca';
  }, 700);

  // voltou para a aba do Maps (talvez depois de apagar algo no sistema): confere a lista de novo
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && tela === 'coleta' && !coleta.rodando && !$('#janela').hidden) sincronizarComSistema();
  });

  $('#btn-salvar').addEventListener('click', () => abrirEmpresa());
  $('#btn-coletar').addEventListener('click', () => abrirColeta());
  $('#fechar').addEventListener('click', () => {
    if (coleta.rodando) coleta.parar = true;
    fecharJanela();
  });
  $('#voltar').addEventListener('click', () => abrirColeta());

  function mostrarJanela(titulo, html, qualTela) {
    tela = qualTela;
    $('#titulo').textContent = titulo;
    $('#conteudo').innerHTML = html;
    $('#janela').hidden = false;
    $('#voltar').hidden = !(fila.length && qualTela !== 'coleta');
  }
  function fecharJanela() {
    $('#janela').hidden = true;
    tela = null;
    empresaDaTela = null;
  }

  // confere se está logado; se não, mostra o login e depois volta para onde estava
  async function garantirLogin(depois) {
    const est = await enviar({ tipo: 'estado' });
    marca = est.marca || marca;
    if (!est.logado) { telaLogin(depois); return false; }
    usuario = est.usuario;
    if (!nichos.length) {
      const r = await enviar({ tipo: 'nichos' });
      if (r.status === 401) { telaLogin(depois, r.dados.erro); return false; }
      nichos = r.ok ? r.dados : [];
    }
    return true;
  }

  function telaLogin(depois, msg) {
    telaDepoisLogin = depois;
    mostrarJanela('Entrar no ' + marca, `
      <form class="corpo" id="f-login">
        <p class="dica">Entre com o mesmo login e senha do ${esc(marca)}.</p>
        <label>Login<input name="login" autocomplete="username" required></label>
        <label>Senha<input name="senha" type="password" autocomplete="current-password" required></label>
        <p class="erro" id="erro" ${msg ? '' : 'hidden'}>${esc(msg || '')}</p>
        <button class="prim">Entrar</button>
      </form>`, 'login');
    $('#f-login').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      f.querySelector('button').disabled = true;
      $('#erro').hidden = false;
      $('#erro').style.color = '#6b7080';
      $('#erro').textContent = 'Conectando… se o servidor estava parado, pode levar até 1 minuto.';
      const r = await enviar({ tipo: 'login', login: f.login.value.trim(), senha: f.senha.value });
      if (!r.ok) {
        f.querySelector('button').disabled = false;
        $('#erro').style.color = '';
        $('#erro').textContent = r.dados.erro || 'Não foi possível entrar.';
        return;
      }
      usuario = r.dados.usuario;
      nichos = [];
      if (typeof depois === 'function') depois(); else fecharJanela();
    });
    $('#conteudo').querySelector('input').focus();
  }

  // ==================================================================
  // 3) SALVAR UMA EMPRESA (a que está aberta, ou uma da lista coletada para revisar)
  // ==================================================================
  async function abrirEmpresa(itemDaFila = null) {
    const e = itemDaFila || lerEmpresa();
    if (!e) return;
    mostrarJanela('Salvar no ' + marca, '<div class="corpo"><p class="dica">Carregando…</p></div>', 'form');
    empresaDaTela = itemDaFila ? null : e.nome;
    if (!(await garantirLogin(() => abrirEmpresa(itemDaFila)))) return;
    telaForm(e, itemDaFila);
  }

  const nichoParecido = (texto) => nichos.find((n) => semAcento(n.nome) === semAcento(texto));
  const ehInstagram = (url) => /instagram\.com/i.test(url || '');

  function dadosParaEnviar(e, extra) {
    return {
      empresa: e.nome,
      telefone: e.telefone || '',
      estado: e.estado || '',
      cidade: e.cidade || '',
      bairro: e.bairro || '',
      site: e.site && !ehInstagram(e.site) ? e.site : undefined,
      instagram: ehInstagram(e.site) ? e.site : undefined,
      anotacoes: 'Google Maps: ' + e.link,
      ...extra,
    };
  }

  function telaForm(e, itemDaFila) {
    const nichoPadrao = itemDaFila ? nichoDaPesquisa(itemDaFila.termo || coleta.termo) : nichoDaPesquisa(termoBuscado());
    const nichoIgual = nichoPadrao ? { nome: nichoPadrao } : nichoParecido(e.categoria);
    const insta = ehInstagram(e.site);
    mostrarJanela(itemDaFila ? 'Revisar empresa' : 'Salvar no ' + marca, `
      <form class="corpo" id="f-salvar">
        <label>Nome da empresa *<input name="empresa" required maxlength="120" value="${esc(e.nome)}"></label>
        <label>Número<input name="telefone" maxlength="40" value="${esc(e.telefone)}" placeholder="Sem telefone no Maps"></label>
        <div class="tres">
          <label>Estado *<select name="estado" required><option value="">UF</option>${UFS.map((u) => `<option ${u === (e.estado || (itemDaFila ? estadoDaColeta() : '')) ? 'selected' : ''}>${u}</option>`).join('')}</select></label>
          <label>Cidade<input name="cidade" maxlength="80" value="${esc(e.cidade)}"></label>
          <label>Bairro<input name="bairro" maxlength="80" value="${esc(e.bairro)}"></label>
        </div>
        <label>Nicho
          <input name="nicho" list="lista-nichos" maxlength="60" value="${esc(nichoIgual?.nome || '')}" placeholder="Escolha ou digite um novo">
          <datalist id="lista-nichos">${nichos.map((n) => `<option value="${esc(n.nome)}"></option>`).join('')}</datalist>
          ${e.categoria && semAcento(e.categoria) !== semAcento(nichoIgual?.nome) ? `<span class="dica">No Maps está como “${esc(e.categoria)}”.</span>` : ''}
        </label>
        <div>
          <label style="margin-bottom:5px">Resultado *</label>
          <div class="status">
            <button type="button" data-s="aceitou">Aceitou</button>
            <button type="button" data-s="pensando" class="sel">Pensando</button>
            <button type="button" data-s="recusou">Recusou</button>
          </div>
        </div>
        <label>${insta ? 'Instagram' : 'Site'}<input name="${insta ? 'instagram' : 'site'}" maxlength="200" value="${esc(e.site)}"></label>
        <label>Anotações<textarea name="anotacoes" maxlength="4000" placeholder="Opcional"></textarea></label>
        <div id="repetidas"></div>
        <p class="erro" id="erro" hidden></p>
        <button class="prim" id="salvar">Salvar no ${esc(marca)}</button>
        <p class="quem">Vai ficar no nome de <b>${esc(usuario?.nome || '')}</b>. O link do Google Maps vai junto nas anotações.</p>
      </form>`, 'form');

    let status = 'pensando';
    raiz.querySelectorAll('.status button').forEach((b) => b.addEventListener('click', () => {
      status = b.dataset.s;
      raiz.querySelectorAll('.status button').forEach((x) => x.classList.toggle('sel', x === b));
    }));

    // item da lista que já está no Prospecta: mostra o aviso logo de cara
    if (itemDaFila?.situacao === 'repetida') mostrarRepetidas([{ empresa: itemDaFila.nome, telefone: itemDaFila.telefone, usuario_nome: itemDaFila.repetida_por }]);

    const form = $('#f-salvar');
    form.addEventListener('submit', (ev) => { ev.preventDefault(); salvar(false); });

    function mostrarRepetidas(lista) {
      $('#repetidas').innerHTML = `
        <div class="aviso">
          <b>Essa empresa parece já estar cadastrada:</b>
          <ul>${lista.map((x) => `<li>${esc(x.empresa)}${x.telefone ? ' · ' + esc(x.telefone) : ''} — por ${esc(x.usuario_nome || 'alguém')}</li>`).join('')}</ul>
          <button type="button" class="sec" id="mesmo-assim">Salvar mesmo assim</button>
        </div>`;
      $('#mesmo-assim').addEventListener('click', () => salvar(true));
    }

    async function salvar(confirmar) {
      const f = new FormData(form);
      const anot = String(f.get('anotacoes') || '').trim();
      const dados = {
        empresa: String(f.get('empresa')).trim(),
        telefone: String(f.get('telefone') || '').trim(),
        estado: f.get('estado'),
        cidade: String(f.get('cidade') || '').trim(),
        bairro: String(f.get('bairro') || '').trim(),
        nicho: String(f.get('nicho') || '').trim(),
        status,
        site: f.get('site') ? String(f.get('site')).trim() : undefined,
        instagram: f.get('instagram') ? String(f.get('instagram')).trim() : undefined,
        anotacoes: (anot ? anot + '\n\n' : '') + 'Google Maps: ' + e.link,
        confirmar_repetida: confirmar || undefined,
      };
      $('#erro').hidden = true;
      $('#salvar').disabled = true;
      $('#salvar').textContent = 'Salvando…';
      const r = await enviar({ tipo: 'salvar', dados });
      $('#salvar').disabled = false;
      $('#salvar').textContent = 'Salvar no ' + marca;

      if (r.ok) {
        if (itemDaFila) {
          marcar(itemDaFila.id, { situacao: 'enviada', apagada: false });
          return abrirColeta();
        }
        return telaOk(dados.empresa);
      }
      if (r.status === 401) return telaLogin(() => telaForm(e, itemDaFila), r.dados.erro || 'Entre de novo para salvar.');
      if (r.status === 409 && r.dados.repetidas) return mostrarRepetidas(r.dados.repetidas);
      $('#erro').textContent = r.dados.erro || 'Não foi possível salvar.';
      $('#erro').hidden = false;
    }
  }

  function telaOk(nome) {
    mostrarJanela('Salvar no ' + marca, `
      <div class="ok">
        <div class="icone">✓</div>
        <strong>Salvo no ${esc(marca)}!</strong>
        <p class="dica">“${esc(nome)}” já aparece na lista de prospecções. Pode clicar em outra empresa no mapa.</p>
        <button class="sec" id="abrir-sis">Abrir o ${esc(marca)}</button>
      </div>`, 'ok');
    empresaDaTela = nome;
    $('#abrir-sis').addEventListener('click', () => enviar({ tipo: 'abrir' }));
  }

  // ==================================================================
  // 4) COLETAR UMA BUSCA (não envia nada sozinho)
  // ==================================================================
  function marcar(id, mudancas) {
    const it = fila.find((x) => x.id === id);
    if (it) Object.assign(it, mudancas);
    guardarFila();
  }
  const contar = () => ({
    novas: fila.filter((x) => x.situacao === 'nova').length,
    repetidas: fila.filter((x) => x.situacao === 'repetida').length,
    enviadas: fila.filter((x) => x.situacao === 'enviada').length,
    erros: fila.filter((x) => x.situacao === 'erro').length,
  });

  async function abrirColeta() {
    mostrarJanela('Coletar do Google Maps', '<div class="corpo"><p class="dica">Carregando…</p></div>', 'coleta');
    if (!(await garantirLogin(() => abrirColeta()))) return;
    desenharColeta();
    if (!coleta.rodando) sincronizarComSistema();
  }

  // Confere a lista com o Prospecta: o que foi enviado (ou estava "já cadastrada") e depois foi apagado
  // lá no sistema volta a ser "Nova", para poder enviar de novo.
  let sincronizando = false;
  async function sincronizarComSistema() {
    if (sincronizando) return;
    const conferir = fila.filter((x) => x.situacao === 'enviada' || x.situacao === 'repetida');
    if (!conferir.length) return;
    sincronizando = true;
    let voltaram = 0;
    for (let i = 0; i < conferir.length; i += 5) {
      await Promise.all(conferir.slice(i, i + 5).map(async (it) => {
        const r = await enviar({ tipo: 'repetidas', empresa: it.nome, telefone: it.telefone });
        if (!r.ok || !Array.isArray(r.dados)) return;
        if (!r.dados.length) {
          Object.assign(it, { situacao: 'nova', repetida_por: '', apagada: true });
          voltaram += 1;
        } else if (it.situacao === 'repetida') {
          it.repetida_por = r.dados[0].usuario_nome || it.repetida_por;
        }
      }));
    }
    sincronizando = false;
    if (voltaram) {
      guardarFila();
      desenharColeta();
    }
  }

  function desenharColeta() {
    if (tela !== 'coleta') return;
    const c = contar();
    const termo = coleta.termo || termoBuscado();
    const temFeed = Boolean(lerFeed());
    const continuando = temFeed && vistosBusca.links.length > 0 && semAcento(vistosBusca.termo) === semAcento(termoBuscado());

    const feitas = fila.length - coleta.inicio;
    const topo = coleta.rodando ? `
        <div class="duas" style="align-items:center">
          <strong>Coletando “${esc(termo)}”…</strong>
          <span class="dica" style="text-align:right">${coleta.alvo === Infinity ? `${feitas} coletada${feitas === 1 ? '' : 's'} · até acabar` : `${feitas} de ${coleta.alvo}`}</span>
        </div>
        <div class="progresso">${coleta.alvo === Infinity
          ? '<i style="width:100%;opacity:.35"></i>'
          : `<i style="width:${Math.min(100, (feitas / coleta.alvo) * 100)}%"></i>`}</div>
        <div class="resumo">
          <span class="chip">${coleta.olhadas} olhada${coleta.olhadas === 1 ? '' : 's'}</span>
          <span class="chip nova">${feitas} nova${feitas === 1 ? '' : 's'}</span>
          <span class="chip rep" title="Já estavam no sistema ou na lista">${coleta.puladas} pulada${coleta.puladas === 1 ? '' : 's'}</span>
          ${coleta.falhas ? `<span class="chip err" title="O Maps não abriu a empresa a tempo">${coleta.falhas} não abriu</span>` : ''}
        </div>
        ${coleta.agora ? `<p class="dica">Agora: <b>${esc(coleta.agora)}</b></p>` : ''}
        <p class="dica">Velocidade: <b>${esc(coleta.velNome)}</b>. Não mexa no mapa enquanto coleta.</p>
        <button class="sec perigo" id="parar">Parar</button>`
      : `
        ${temFeed ? `
        <p class="dica">Vai abrir as empresas da busca <b>“${esc(termoBuscado() || 'atual')}”</b>, uma por uma, e juntar aqui. <b>Nada é enviado</b> até você clicar em Enviar.</p>
        <div class="duas">
          <label>Quantas empresas?<input type="number" id="limite" min="1" value="${pref.limite}" ${pref.infinito ? 'disabled' : ''}></label>
          <label>Velocidade
            <select id="velocidade">${Object.entries(VELOCIDADES).map(([k, v]) =>
              `<option value="${k}" ${k === pref.velocidade ? 'selected' : ''}>${v.nome}${k === 'normal' ? ' (padrão)' : ''}</option>`).join('')}</select>
          </label>
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-weight:600;color:#15171c">
          <input type="checkbox" id="infinito" style="width:auto" ${pref.infinito ? 'checked' : ''}> Sem limite: pegar tudo até a lista acabar
        </label>
        <label id="campo-ms" ${pref.velocidade === 'personalizada' ? '' : 'hidden'}>Tempo entre uma empresa e outra (milissegundos)
          <input type="number" id="pausa-ms" min="0" step="50" value="${Number(pref.pausa_ms) || 0}">
          <span class="dica">1000 ms = 1 segundo. Pode ir até 0.</span>
        </label>
        <p class="dica" id="dica-vel">${dicaVelocidade(pref.velocidade)}</p>
        ${continuando ? `
        <p class="dica" style="color:#4338ca">Já olhou <b>${vistosBusca.links.length}</b> empresa${vistosBusca.links.length === 1 ? '' : 's'} dessa busca${vistosBusca.acabou ? ' e a lista do Maps acabou' : ''}. O Continuar pula essas e as que já estão no sistema.</p>
        <button class="prim" id="comecar" ${vistosBusca.acabou ? 'disabled' : ''}>${vistosBusca.acabou ? 'A busca acabou' : `Continuar: mais ${pref.infinito ? 'até acabar' : pref.limite}`}</button>
        <button class="sec" id="recomecar">Recomeçar do início</button>`
        : `<button class="prim" id="comecar">Começar coleta</button>`}
        ${coleta.ultima ? `<p class="dica">Última coleta: <b>${coleta.ultima.novas}</b> nova${coleta.ultima.novas === 1 ? '' : 's'} · <b>${coleta.ultima.puladas}</b> pulada${coleta.ultima.puladas === 1 ? '' : 's'} (já estavam no sistema ou na lista).</p>` : ''}` : `<p class="dica">Para coletar mais, pesquise um nicho no Maps (ex.: “pizzaria em Recife”) e a lista de resultados vai aparecer à esquerda.</p>`}`;

    const novas = fila.filter((x) => x.situacao === 'nova' || x.situacao === 'erro');
    const pesquisas = [...new Set(novas.map((x) => nichoDaPesquisa(x.termo)).filter(Boolean))];
    const ufPadrao = estadoDaColeta();
    const semUF = novas.filter((x) => !x.estado).length;

    $('#conteudo').innerHTML = `
      <div class="corpo">
        ${topo}
        ${fila.length ? `
        <div class="resumo">
          <span class="chip nova">${c.novas} nova${c.novas === 1 ? '' : 's'}</span>
          <span class="chip rep">${c.repetidas} já cadastrada${c.repetidas === 1 ? '' : 's'}</span>
          <span class="chip env">${c.enviadas} enviada${c.enviadas === 1 ? '' : 's'}</span>
          ${c.erros ? `<span class="chip err">${c.erros} com erro</span>` : ''}
        </div>
        ${!coleta.rodando && novas.length ? `
        <div class="corpo" style="padding:12px;border:1px solid #e3e5ea;border-radius:12px;background:#fafbfc">
          <label>Nicho
            <input id="nicho-todas" list="lista-nichos2" maxlength="60" value="${esc(pesquisas.length === 1 ? pesquisas[0] : '')}"
              placeholder="${pesquisas.length > 1 ? 'Vazio: cada uma vai com a sua pesquisa' : 'Escolha ou digite'}">
            <datalist id="lista-nichos2">${nichos.map((n) => `<option value="${esc(n.nome)}"></option>`).join('')}</datalist>
            <span class="dica">${pesquisas.length > 1
              ? `Tem pesquisas diferentes na lista (${pesquisas.map(esc).join(', ')}). Deixe vazio para cada empresa ir com o nicho da sua pesquisa.`
              : 'Vem da sua pesquisa no Maps. Pode trocar.'}</span>
          </label>
          ${semUF ? `<label>Estado das ${semUF} sem endereço no Maps
            <select id="uf-sem"><option value="">Escolha…</option>${UFS.map((u) => `<option ${u === ufPadrao ? 'selected' : ''}>${u}</option>`).join('')}</select>
          </label>` : ''}
          <label>Resultado de todas
            <select id="status-todas"><option value="pensando">Pensando</option><option value="aceitou">Aceitou</option><option value="recusou">Recusou</option></select>
          </label>
          <button class="prim" id="enviar-todas">Enviar as ${novas.length} novas para o ${esc(marca)}</button>
          <p class="dica">As já cadastradas não vão. Se quiser mandar alguma mesmo assim, clique em <b>Revisar</b> nela.</p>
        </div>` : ''}
        <div class="lista">${fila.map(itemHtml).join('')}</div>
        ${!coleta.rodando ? `<button class="sec perigo" id="limpar">Limpar lista</button>` : ''}
        ` : ''}
      </div>`;

    $('#comecar')?.addEventListener('click', comecarColeta);
    $('#recomecar')?.addEventListener('click', () => {
      vistosBusca = { termo: '', links: [], acabou: false };
      guardarVistos();
      desenharColeta();
    });
    $('#infinito')?.addEventListener('change', (ev) => {
      pref.infinito = ev.target.checked;
      $('#limite').disabled = pref.infinito;
      guardarPref();
    });
    $('#velocidade')?.addEventListener('change', (ev) => {
      pref.velocidade = ev.target.value;
      $('#dica-vel').textContent = dicaVelocidade(pref.velocidade);
      $('#campo-ms').hidden = pref.velocidade !== 'personalizada';
      guardarPref();
    });
    $('#pausa-ms')?.addEventListener('input', (ev) => {
      pref.pausa_ms = Math.max(0, Math.round(Number(ev.target.value) || 0));
      guardarPref();
    });
    $('#parar')?.addEventListener('click', () => { coleta.parar = true; $('#parar').textContent = 'Parando…'; });
    $('#enviar-todas')?.addEventListener('click', enviarTodas);
    $('#limpar')?.addEventListener('click', () => {
      if (!confirm('Apagar a lista coletada? (o que já foi enviado continua no sistema)')) return;
      fila = [];
      guardarFila();
      vistosBusca = { termo: '', links: [], acabou: false }; // limpou: a próxima coleta começa do início
      guardarVistos();
      coleta.ultima = null;
      desenharColeta();
    });
    raiz.querySelectorAll('[data-revisar]').forEach((b) => b.addEventListener('click', () => {
      const it = fila.find((x) => x.id === b.dataset.revisar);
      if (it) abrirEmpresa(it);
    }));
    raiz.querySelectorAll('[data-tirar]').forEach((b) => b.addEventListener('click', () => {
      fila = fila.filter((x) => x.id !== b.dataset.tirar);
      guardarFila();
      desenharColeta();
    }));
  }

  function dicaVelocidade(v) {
    return {
      lenta: 'Lenta: mais segura, quase não falha em internet fraca.',
      normal: 'Normal: equilíbrio entre rapidez e segurança.',
      rapida: 'Rápida: termina antes, mas o Google pode estranhar e alguns telefones podem vir vazios.',
      personalizada: `Personalizada: você escolhe a pausa. Cada empresa ainda espera ${CARREGAR_MINIMO} ms para o telefone e o endereço carregarem.`,
    }[v];
  }

  // estado mais comum entre as empresas coletadas (para as que vieram sem endereço)
  function estadoDaColeta() {
    const conta = {};
    for (const x of fila) if (x.estado) conta[x.estado] = (conta[x.estado] || 0) + 1;
    return Object.entries(conta).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  }

  function itemHtml(it) {
    const onde = [it.bairro, [it.cidade, it.estado].filter(Boolean).join(' – ')].filter(Boolean).join(', ');
    const chip = {
      nova: `<span class="chip nova" ${it.apagada ? 'title="Foi apagada do sistema, pode enviar de novo"' : ''}>${it.apagada ? 'Apagada no sistema' : 'Nova'}</span>`,
      repetida: `<span class="chip rep">Já cadastrada${it.repetida_por ? ' por ' + esc(it.repetida_por) : ''}</span>`,
      enviada: '<span class="chip env">Enviada ✓</span>',
      erro: `<span class="chip err" title="${esc(it.erro || '')}">Erro</span>`,
    }[it.situacao] || '';
    return `
      <div class="item ${it.situacao === 'repetida' ? 'rep' : ''} ${it.situacao === 'enviada' ? 'env' : ''}">
        <div class="item-topo"><strong>${esc(it.nome)}</strong>${chip}</div>
        <small>${esc(it.telefone || 'Sem telefone')}${onde ? ' · ' + esc(onde) : ' · sem endereço no Maps'}</small>
        ${it.termo || it.categoria ? `<small>Nicho: <b>${esc(nichoDaPesquisa(it.termo) || '—')}</b>${it.categoria && semAcento(it.categoria) !== semAcento(nichoDaPesquisa(it.termo)) ? ` · no Maps: ${esc(it.categoria)}` : ''}</small>` : ''}
        ${it.situacao === 'erro' && it.erro ? `<small style="color:#b91c1c">${esc(it.erro)}</small>` : ''}
        ${it.situacao !== 'enviada' && !coleta.rodando ? `
        <div class="item-acoes">
          <button class="revisar" data-revisar="${esc(it.id)}">Revisar</button>
          <button data-tirar="${esc(it.id)}">Tirar da lista</button>
        </div>` : ''}
      </div>`;
  }

  // mesma empresa já está na lista coletada?
  const chaveNome = (s) => semAcento(s).replace(/[^a-z0-9]/g, '');
  const jaNaFila = (e) => fila.some((x) => chaveNome(x.nome) === chaveNome(e.nome)
    || (soDigitos(e.telefone).length >= 8 && soDigitos(x.telefone) === soDigitos(e.telefone)));

  async function conferirNoSistema(e) {
    const r = await enviar({ tipo: 'repetidas', empresa: e.nome, telefone: e.telefone });
    if (r.ok && Array.isArray(r.dados) && r.dados.length) return { situacao: 'repetida', repetida_por: r.dados[0].usuario_nome || '' };
    return { situacao: 'nova' };
  }

  // espera a empresa clicada abrir no painel (o título muda para o nome dela)
  // espera a empresa clicada abrir no painel. Aceita o nome igual, parecido, ou o título ter mudado
  // para outra empresa (o Maps às vezes escreve o nome um pouco diferente da lista).
  async function esperarEmpresa(nomeEsperado, extra = 700, tituloAntes = '', tempo = 8000) {
    const alvo = chaveNome(nomeEsperado);
    const antes = chaveNome(tituloAntes);
    const fim = Date.now() + tempo;
    let mudouEm = 0;
    while (Date.now() < fim && !coleta.parar) {
      const t = chaveNome(document.querySelector('h1.DUwDvf')?.textContent || '');
      const parecido = t && (t === alvo || t.startsWith(alvo.slice(0, 12)) || alvo.startsWith(t.slice(0, 12)));
      if (t && t !== antes && !parecido && !mudouEm) mudouEm = Date.now();
      if (parecido || (mudouEm && Date.now() - mudouEm > 1500)) {
        await esperar(extra); // dá tempo do telefone e do endereço aparecerem
        return lerEmpresa();
      }
      await esperar(200);
    }
    return null;
  }

  async function comecarColeta() {
    pref.limite = Math.max(1, Number($('#limite').value) || 20);
    pref.infinito = $('#infinito').checked;
    pref.velocidade = $('#velocidade').value in VELOCIDADES ? $('#velocidade').value : 'normal';
    if ($('#pausa-ms')) pref.pausa_ms = Math.max(0, Math.round(Number($('#pausa-ms').value) || 0));
    guardarPref();
    const limite = pref.infinito ? Infinity : pref.limite;
    const vel = velocidadeAtual();
    const feed = lerFeed();
    if (!feed) return;
    const termo = termoBuscado();
    // busca nova: começa do zero. Mesma busca: continua de onde parou.
    if (semAcento(vistosBusca.termo) !== semAcento(termo)) vistosBusca = { termo, links: [], acabou: false };
    coleta = { rodando: true, parar: false, alvo: limite, termo, inicio: fila.length, puladas: 0, olhadas: 0, falhas: 0, agora: '',
      velNome: vel.nome + (pref.velocidade === 'personalizada' ? ` (${vel.pausa} ms)` : '') };
    desenharColeta();

    const vistos = new Set(vistosBusca.links);
    const marcarVisto = (href) => {
      vistos.add(chaveLink(href));
      vistosBusca.links.push(chaveLink(href));
      guardarVistos();
    };
    let semNovos = 0;
    while (!coleta.parar && fila.length - coleta.inicio < limite) {
      const atual = lerFeed();
      if (!atual) break;
      const proximo = linksDoFeed(atual).find((a) => !vistos.has(chaveLink(a.href)));

      if (!proximo) {
        // acabou o que está carregado: rola a lista para o Maps carregar mais
        atual.scrollTop = atual.scrollHeight;
        await esperar(1800);
        semNovos += 1;
        const fimDaLista = /final da lista|end of the list/i.test(atual.textContent.slice(-400));
        if (fimDaLista || semNovos >= (limite === Infinity ? 6 : 4)) {
          vistosBusca.acabou = true;
          guardarVistos();
          break;
        }
        continue;
      }
      semNovos = 0;
      marcarVisto(proximo.href);
      const nome = proximo.getAttribute('aria-label');
      coleta.olhadas += 1;
      coleta.agora = nome;

      // já está na lista, ou o nome já existe no Prospecta? pula sem nem abrir (mais rápido)
      if (fila.some((x) => chaveNome(x.nome) === chaveNome(nome))) { coleta.puladas += 1; desenharColeta(); continue; }
      const jaNoSistema = await enviar({ tipo: 'repetidas', empresa: nome, telefone: '' });
      if (jaNoSistema.ok && Array.isArray(jaNoSistema.dados) && jaNoSistema.dados.length) { coleta.puladas += 1; desenharColeta(); continue; }

      if (coleta.parar) break;
      const tituloAntes = document.querySelector('h1.DUwDvf')?.textContent || '';
      proximo.scrollIntoView({ block: 'center' });
      desenharColeta();
      proximo.click();
      const e = await esperarEmpresa(nome, vel.carregar, tituloAntes);
      if (coleta.parar) break;
      if (!e) coleta.falhas += 1;
      if (e && !jaNaFila(e)) {
        const conf = await conferirNoSistema(e); // aqui confere também pelo telefone
        if (conf.situacao === 'repetida') coleta.puladas += 1;
        else {
          fila.push({ id: String(Date.now()) + Math.random().toString(36).slice(2, 6), ...e, ...conf, termo: coleta.termo });
          guardarFila();
        }
      } else if (e) coleta.puladas += 1;
      desenharColeta();
      // um respiro entre uma empresa e outra (o Parar funciona no meio da espera)
      for (let t = 0; t < vel.pausa && !coleta.parar; t += 200) await esperar(Math.min(200, vel.pausa - t));
    }

    coleta.ultima = { novas: fila.length - coleta.inicio, puladas: coleta.puladas };
    coleta.agora = '';
    coleta.rodando = false;
    coleta.parar = false;
    desenharColeta();
  }

  async function enviarTodas() {
    const nichoGeral = ($('#nicho-todas')?.value || '').trim();
    const ufSem = $('#uf-sem')?.value || '';
    const status = $('#status-todas')?.value || 'pensando';
    if ($('#uf-sem') && !ufSem) {
      alert('Escolha o estado das empresas que vieram sem endereço do Maps.');
      $('#uf-sem').focus();
      return;
    }
    const botao = $('#enviar-todas');
    const novas = fila.filter((x) => x.situacao === 'nova' || x.situacao === 'erro');
    botao.disabled = true;
    let feitas = 0;
    for (const it of novas) {
      botao.textContent = `Enviando ${++feitas} de ${novas.length}…`;
      const dados = dadosParaEnviar(it, { nicho: nichoGeral || nichoDaPesquisa(it.termo), status });
      if (!dados.estado) dados.estado = ufSem;
      const r = await enviar({ tipo: 'salvar', dados });
      if (r.ok) marcar(it.id, { situacao: 'enviada', apagada: false });
      else if (r.status === 409 && r.dados.repetidas) marcar(it.id, { situacao: 'repetida', repetida_por: r.dados.repetidas[0]?.usuario_nome || '' });
      else if (r.status === 401) return telaLogin(() => abrirColeta(), r.dados.erro || 'Entre de novo para enviar.');
      else marcar(it.id, { situacao: 'erro', erro: r.dados.erro || 'Não foi possível enviar.' });
    }
    desenharColeta();
  }
})();
