// Faz todas as conversas com o servidor do Prospecta.
// A página do Maps e a janelinha da extensão mandam mensagens para cá.
importScripts('config.js');

async function chamar(caminho, { metodo = 'GET', corpo } = {}) {
  const { token } = await chrome.storage.local.get('token');
  let r;
  try {
    r = await fetch(PROSPECTA.url + caminho, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
  } catch {
    return { ok: false, status: 0, dados: { erro: 'Não consegui falar com o ' + PROSPECTA.marca + '. Verifique a internet e tente de novo.' } };
  }
  let dados = null;
  try { dados = await r.json(); } catch { /* resposta sem JSON */ }
  // login vencido, senha trocada ou acesso desativado: esquece a chave
  if (r.status === 401) await chrome.storage.local.remove(['token', 'usuario']);
  return { ok: r.ok, status: r.status, dados: dados || {} };
}

async function tratar(msg) {
  switch (msg.tipo) {
    case 'estado': {
      const { token, usuario } = await chrome.storage.local.get(['token', 'usuario']);
      return { logado: Boolean(token), usuario: usuario || null, url: PROSPECTA.url, marca: PROSPECTA.marca };
    }
    case 'login': {
      const r = await chamar('/api/extensao/login', { metodo: 'POST', corpo: { login: msg.login, senha: msg.senha } });
      if (r.ok) await chrome.storage.local.set({ token: r.dados.token, usuario: r.dados.usuario });
      return r;
    }
    case 'sair':
      await chrome.storage.local.remove(['token', 'usuario']);
      return { ok: true };
    case 'conferir': { // confere se a chave ainda vale (senha trocada, acesso desativado...)
      const r = await chamar('/api/me');
      if (r.ok) await chrome.storage.local.set({ usuario: r.dados });
      return r;
    }
    case 'nichos':
      return chamar('/api/nichos');
    case 'repetidas': { // a empresa já está no sistema?
      const q = new URLSearchParams({ empresa: msg.empresa || '', telefone: msg.telefone || '' });
      return chamar('/api/prospeccoes/repetidas?' + q);
    }
    case 'salvar':
      return chamar('/api/prospeccoes', { metodo: 'POST', corpo: msg.dados });
    case 'abrir':
      await chrome.tabs.create({ url: PROSPECTA.url + (msg.caminho || '/') });
      return { ok: true };
    default:
      return { ok: false, dados: { erro: 'Mensagem desconhecida.' } };
  }
}

chrome.runtime.onMessage.addListener((msg, _remetente, responder) => {
  tratar(msg).then(responder, (e) => responder({ ok: false, status: 0, dados: { erro: String(e.message || e) } }));
  return true; // vai responder depois (assíncrono)
});
