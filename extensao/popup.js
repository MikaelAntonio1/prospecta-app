const $ = (s) => document.querySelector(s);
const enviar = (msg) => chrome.runtime.sendMessage(msg);

function mostrar(id) {
  for (const t of ['#carregando', '#form-login', '#logado']) $(t).hidden = t !== id;
}
function mostrarUsuario(u) {
  $('#nome').textContent = u?.nome || '';
  $('#login').textContent = u?.login ? '@' + u.login : '';
  $('#inicial').textContent = (u?.nome || '?').trim().charAt(0).toUpperCase();
  mostrar('#logado');
}

async function iniciar() {
  const e = await enviar({ tipo: 'estado' });
  $('#marca').textContent = e.marca;
  document.querySelectorAll('.nome-marca').forEach((s) => (s.textContent = e.marca));
  if (!e.logado) return mostrar('#form-login');
  mostrarUsuario(e.usuario);
  // confere em segundo plano se o login ainda vale (senha trocada, acesso desativado)
  const r = await enviar({ tipo: 'conferir' });
  if (r.status === 401) {
    mostrar('#form-login');
    $('#erro-login').textContent = r.dados.erro || 'Entre de novo.';
    $('#erro-login').hidden = false;
  } else if (r.ok) mostrarUsuario(r.dados);
}

$('#form-login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  $('#erro-login').hidden = true;
  $('#btn-entrar').disabled = true;
  const espera = setTimeout(() => ($('#aguarde').hidden = false), 2500);
  const r = await enviar({ tipo: 'login', login: f.login.value.trim(), senha: f.senha.value });
  clearTimeout(espera);
  $('#aguarde').hidden = true;
  $('#btn-entrar').disabled = false;
  if (!r.ok) {
    $('#erro-login').textContent = r.dados.erro || 'Não foi possível entrar.';
    $('#erro-login').hidden = false;
    return;
  }
  f.reset();
  mostrarUsuario(r.dados.usuario);
});

$('#btn-sair').addEventListener('click', async () => { await enviar({ tipo: 'sair' }); mostrar('#form-login'); });
$('#btn-abrir').addEventListener('click', () => enviar({ tipo: 'abrir' }));

iniciar();
