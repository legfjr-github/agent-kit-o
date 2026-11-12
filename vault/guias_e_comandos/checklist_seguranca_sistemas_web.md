---
titulo: Checklist de segurança e testes de ataque para sistemas web
categoria: guias_e_comandos
tags: [seguranca, testes, xss, autenticacao, auditoria, lgpd, cloudflare, django]
atualizado: 2026-11-06
resumo: Verificações e testes obrigatórios antes de publicar qualquer sistema web com login, formulário público, painel administrativo ou resultado que não pode ser manipulado.
---

# 🛡️ Checklist de segurança e testes de ataque

Padrão aplicado pela regra global `rules/seguranca-por-padrao.md`. Os itens vêm de falhas reais achadas em auditorias: XSS que roubava a sessão do administrador e resultado de sorteio confirmado sem amarração no servidor.

## Quando aplicar
Sempre que o sistema tiver **qualquer** um destes: login ou senha; formulário aberto ao público; painel administrativo; dado pessoal (CPF, matrícula, e-mail, telefone); resultado que não pode ser manipulado (sorteio, pagamento, nota, cálculo, aprovação). Em mudança pequena num sistema que já passou pelo checklist, rodar ao menos os testes da área tocada.

## 1. Leitura do código (antes de testar)
- [ ] Listar **todo** ponto em que dado externo vira HTML: `innerHTML`, `insertAdjacentHTML`, template string em `.html()`, `bindPopup`, `|safe` no Django, `mark_safe`. Cada valor vindo de usuário, URL, banco ou API pública passa por escape. Lembrar dos campos "inofensivos" (página, user-agent, cidade, nome de arquivo).
- [ ] Atributos com JS (`onclick="f('${x}')"`): escape HTML não protege contexto JS. Usar `data-*` + `this.dataset` ou validar o valor (só `[A-Za-z0-9_-]`).
- [ ] Toda consulta SQL com parâmetros (`?`, `%s`, ORM). Nada de concatenar.
- [ ] Toda regra de negócio importante **validada no servidor**, nunca só no navegador: status, quem pode fazer o quê, limites, sequência de etapas.
- [ ] Rotas novas: qual exige login? Conferir que a verificação roda antes de qualquer leitura ou escrita (e com `await`, se for assíncrona).
- [ ] Mensagens de erro não expõem stack, SQL, caminho ou `err.message` interno.
- [ ] Segredos só em secret/variável de ambiente; nunca no código, no front-end ou no histórico do git (`git log -p -S "senha"`). Repositório público? Conferir.

## 2. Autenticação e sessão
- [ ] A senha **nunca** volta ao navegador. Sessão de painel em **cookie `HttpOnly; Secure; SameSite=Strict`** com `Path` restrito à API e sem `Max-Age` (some ao fechar o navegador); validade garantida no servidor (token assinado com HMAC e expiração, ou sessão no banco). Nada de sessão em `localStorage`/`sessionStorage`: código colado no console leria.
- [ ] Sessão em cookie exige **anti-CSRF**: cabeçalho próprio obrigatório (ex.: `X-Painel: 1`) + recusar `Origin`/`Sec-Fetch-Site` de outro site. Django: middleware CSRF ativo.
- [ ] Comparação de senha/token em **tempo constante**.
- [ ] **Limite de tentativas** por IP (ex.: 20 falhas / 15 min) valendo para o login **e** para qualquer rota que aceite senha/token, com bloqueio inclusive da senha certa durante a janela. Sessão válida já emitida passa (senão um atacante na mesma rede derruba o administrador).
- [ ] Aviso "PARE!" no console das páginas com dado sensível (golpe de colar código). Bloquear DevTools/F12 não protege e atrapalha acessibilidade: não fazer.
- [ ] Sessão expira. Trocar a senha/segredo invalida as sessões.
- [ ] Senha forte (≥ 16 caracteres aleatórios) para painéis administrativos.

## 3. Integridade (anti-manipulação)
- [ ] Sorteio/aleatoriedade com `crypto.getRandomValues` / `secrets` (Python), sem viés. Nunca `Math.random` / `random`.
- [ ] O servidor guarda o estado da operação (ex.: candidato sorteado pendente) e só aceita confirmar **o que ele mesmo gerou**. Listas enviadas pelo navegador (ex.: "ignorar estes números") são filtradas contra o que o servidor registrou.
- [ ] Operações críticas em **transação** com condição (`INSERT ... WHERE EXISTS ... AND limite`) e índice único, para corrida e replay não duplicarem resultado.
- [ ] Etapas que travam o processo (encerrar inscrições, fechar período) acontecem **no servidor**.
- [ ] Ações destrutivas bloqueadas quando apagariam prova de resultado (ex.: limpar inscritos depois do sorteio).
- [ ] **Trilha de auditoria** permanente (quem/origem, quando, o quê, antes/depois), que o painel não consegue apagar, com tela de consulta.
- [ ] Unicidade de participante: identificador forte (CPF/matrícula) quando o resultado vale prêmio ou dinheiro; documentar o que fica fraco.
- [ ] Anti-robô (Turnstile/captcha) em formulário público, sem atalhos para token de teste em produção e com carregamento robusto (render explícito + callback).

## 4. Navegador e transporte
- [ ] Cabeçalhos: `Content-Security-Policy` por página (no mínimo `connect-src 'self'`, `img-src` restrito, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri`), `X-Frame-Options: DENY`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`. Cloudflare Workers/Pages: arquivo `_headers`; Django: `SecurityMiddleware` + `django-csp`.
- [ ] Scripts/estilos de CDN com versão fixa e **SRI** (`integrity="sha384-..."` + `crossorigin`). Hash: `curl -sL URL | openssl dgst -sha384 -binary | openssl base64 -A`.
- [ ] CORS fechado se front e API estão no mesmo domínio (sem `Access-Control-Allow-Origin: *`).
- [ ] Painel administrativo com `Cache-Control: no-store`.

## 5. LGPD
- [ ] IP nunca em claro; hash com **HMAC e segredo** (SHA-256 com sal fixo no código é reversível para IPv4).
- [ ] Dado pessoal só nas rotas administrativas; resposta pública traz o mínimo.
- [ ] Campos sensíveis não aparecem em telão, log ou histórico público sem necessidade.

## 6. Testes de ataque obrigatórios (rodar local antes do deploy)
Subir o sistema local (ex.: `npx wrangler dev`, `python manage.py runserver`) com credenciais de teste e executar por `curl`/navegador. Registrar cada resultado no log diário.

| # | Ataque | Esperado |
|---|---|---|
| 1 | Rota administrativa sem credencial | 401/403 |
| 2 | Sessão forjada / adulterada / expirada | 401 |
| 3 | Login errado N vezes seguidas | bloqueio (429) após o limite, inclusive com senha certa |
| 4 | Login certo | resposta não contém a senha |
| 5 | Payload `<img src=x onerror=alert(1)>` em **cada** campo público (formulário, telemetria, parâmetros de URL) | recusado ou exibido como texto no painel; `window.__xss` indefinido |
| 6 | Payload gravado direto no banco (simula dado antigo) e tela do painel aberta | exibido como texto |
| 7 | JSON com tipos errados (`{}` no lugar de string, array no lugar de objeto, campo gigante) | 400/404 limpo, sem 500 |
| 8 | Ação crítica com dado escolhido a dedo (ex.: confirmar ganhador sem sortear, outro número, replay) | recusada |
| 9 | 5 requisições simultâneas da mesma ação crítica | só uma tem efeito |
| 10 | Etapa fora de ordem (ex.: inscrição durante o sorteio, apagar dados depois do resultado) | recusada |
| 11 | Duplicidade (mesma pessoa com dados levemente diferentes, outro navegador) | barrada ou limitação documentada |
| 12 | Anti-robô: sem token e com token falso | recusado |
| 13 | `OPTIONS` com `Origin: https://evil.com` | sem `Access-Control-Allow-Origin` |
| 14 | `curl -I` nas páginas | cabeçalhos do item 4 presentes |
| 15 | Navegador com CSP ativa: console sem erros, CDNs com SRI carregando | sem bloqueio indevido |
| 16 | Migração em banco antigo (tabelas/colunas novas criadas sozinhas) | sem erro |
| 17 | Trilha de auditoria após o fluxo completo | todos os eventos presentes |
| 18 | Login: `Set-Cookie` com `HttpOnly; Secure; SameSite=Strict`; no navegador `document.cookie` sem a sessão | sessão invisível ao JavaScript |
| 19 | CSRF: chamada com o cookie mas sem o cabeçalho próprio, com `Origin` de outro site ou `Sec-Fetch-Site: cross-site` | 403 |
| 20 | "Código colado no console" (no painel logado): procurar a sessão em cookie/storage e enviar para outro domínio | nada encontrado; envio bloqueado pela CSP |
| 21 | Logout e depois chamada à API | 401 |

Depois do deploy: repetir 1, 2, 5, 12, 13 e 14 contra produção e checar se a falha corrigida já foi explorada (ex.: contar registros com `<`/`>` no banco).

## 7. Cuidados ao testar
- Não criar dado real em produção para testar (usar payload que falha antes de gravar).
- Processos locais (`workerd`, `runserver`) que sobram ao parar o terminal seguem escutando a porta e respondem no lugar do novo; conferir com `netstat -ano | findstr :PORTA` e encerrar pelo PID.
- No PowerShell 5.1: `npm.cmd`/`npx.cmd`, sem `&&`.
