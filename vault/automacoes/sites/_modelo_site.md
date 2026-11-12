---
titulo: Mapa do site <dominio>
categoria: automacoes
tags: [automacao, mapa-de-site]
atualizado: AAAA-MM-DD
resumo: Como entrar e navegar em <dominio> numa automação; fluxos já automatizados, seletores e armadilhas.
---

# 🗺️ <dominio>

> Copie este arquivo para `automacoes/sites/<dominio>.md` e acrescente uma linha em [[automacoes/00_MAPA_DE_SITES]]. Atualize sempre que uma automação descobrir um passo, seletor ou armadilha nova.

## Entrada
- **URL inicial:** `https://...`
- **Login:** formulário próprio / gov.br / certificado. Campos: usuário `#...`, senha `#...`, botão `#...`.
- **CAPTCHA / duas etapas:** sim/não (feito pela pessoa; a automação espera `<elemento da área logada>`).
- **Sessão caiu quando:** a URL volta para `.../login` ou aparece `<campo>`.
- **Perfil do navegador:** `~/.automacoes/perfis/<nome>` (login salvo).

## Telas
| Tela | Como chegar | Onde ficam as coisas (aba, iframe, janela) | Esperar antes de agir |
|---|---|---|---|
| Início | após login | `default_content` | `#menu` visível |

## Fluxos automatizados
### Nome do fluxo (projeto: `caminho/do/projeto`, função `metodo()`)
1. Ir para `<tela>`.
2. Clicar na aba **X** e esperar `<elemento>` (a lista só aparece depois disso).
3. Entrar no iframe `<id>`; clicar em `<seletor>`.
4. Nova janela abre: trocar com `switch_to.window`; esperar `<elemento>`.
5. ... resultado esperado: `<o que confirma que deu certo>`.

## Seletores
| Elemento | Seletor preferido | Alternativo | Onde |
|---|---|---|---|
| Botão salvar | `#btnSalvar` | `//button[normalize-space()='Salvar']` | iframe `ifrX` |

## Armadilhas
- AAAA-MM-DD: sintoma → causa → solução.

## Projetos que usam este site
- `C:\...\projeto` ([[projetos/...]]), última conferência AAAA-MM-DD.
