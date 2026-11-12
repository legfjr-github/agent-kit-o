---
titulo: Mapa do login gov.br (sso.acesso.gov.br)
categoria: automacoes
tags: [automacao, mapa-de-site, govbr, login]
atualizado: 2026-11-12
resumo: Como tratar o login gov.br numa automação - perfil persistente, a pessoa faz o login e o CAPTCHA, a automação espera a volta ao sistema de origem.
---

# 🗺️ gov.br (sso.acesso.gov.br)

Vários sistemas federais e estaduais mandam para o login único gov.br e depois voltam ao sistema de origem. Regras gerais: [[guias_e_comandos/automacao_web]].

## Entrada
- **Navegador:** `undetected-chromedriver` obrigatório (o Selenium comum costuma ser barrado), com **perfil persistente** próprio (`~/.automacoes/perfis/govbr`), para o login valer por dias.
- **Fluxo visto pela pessoa:** botão "Entrar com gov.br" no sistema de origem → página `sso.acesso.gov.br` → CPF → Continuar → senha → Entrar → às vezes hCaptcha e verificação em duas etapas (aplicativo gov.br) → volta ao sistema de origem.
- **A automação não preenche CPF/senha nem resolve CAPTCHA.** Ela abre a página, avisa a pessoa e espera a URL voltar para o domínio do sistema de origem (`WebDriverWait(driver, 300).until(lambda d: "acesso.gov.br" not in d.current_url)`).
- **Sessão caiu quando:** ao abrir o sistema de origem, a URL vai para `sso.acesso.gov.br`.

## Fluxo padrão
1. `driver.get(<url do sistema de origem>)`.
2. Se a URL contém `sso.acesso.gov.br` (ou aparece o botão "Entrar com gov.br" no sistema: clicar nele), mostrar: "Faça o login gov.br na janela do navegador; continuo sozinho quando voltar ao sistema."
3. Esperar até 5 minutos a URL sair de `acesso.gov.br`; depois esperar um elemento da área logada do sistema de origem (anotar no mapa desse sistema).
4. Seguir o fluxo do sistema de origem.

## Seletores (a conferir na primeira automação real; só para leitura de estado)
| Elemento | Seletor provável | Uso |
|---|---|---|
| Campo CPF | `#accountId` | saber que está na tela de login |
| Campo senha | `#password` | idem |

## Armadilhas
- Headless e perfis temporários aumentam o número de CAPTCHAs; use janela visível e perfil persistente.
- Não use o perfil do Chrome do dia a dia (fica travado com o Chrome aberto).

## Projetos que usam este site
- (preencher)
