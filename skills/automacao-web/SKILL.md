---
name: automacao-web
description: Cria e mantém automações de navegador (Selenium com undetected-chromedriver) para sites do governo (gov.br, SEI e similares) e outros portais, sempre lendo e atualizando o mapa do site no cofre (automacoes/sites/<dominio>.md) com o passo a passo, abas, iframes, janelas, seletores e armadilhas. Use quando o pedido for automatizar algo num site, robô, RPA, preencher formulário web, baixar relatórios de portal, raspar dados de uma página, ou quando o projeto aberto já tiver automação (selenium, undetected_chromedriver, playwright).
---

# Automação web

Guia completo: `{{VAULT_PATH}}\guias_e_comandos\automacao_web.md`. Índice dos sites: `{{VAULT_PATH}}\automacoes\00_MAPA_DE_SITES.md`.

## Antes de escrever código
1. Abra o índice de sites e o mapa do site (`automacoes/sites/<dominio>.md`). Siga os fluxos e seletores que já estão lá.
2. Sem mapa: copie `automacoes/sites/_modelo_site.md`, preencha a entrada (URL, tipo de login, como saber que a sessão caiu) e acrescente a linha no índice.
3. Projeto que já automatiza o site sem mapa: leia o código e transcreva para o mapa os passos (URLs, cliques, `switch_to.frame`, `switch_to.window`, esperas, seletores) antes de mudar qualquer coisa.

## Ao escrever
- **Sempre `undetected-chromedriver`** com `version_main` igual à versão do Chrome instalado e **perfil próprio persistente** (`~/.automacoes/perfis/<nome>`); código base no guia. Se faltar no PC: `python -m pip install -U undetected-chromedriver selenium setuptools`.
- Login, CAPTCHA e segundo fator ficam com a pessoa: a automação abre a página, avisa e espera a área logada. Nunca tente resolver ou contornar CAPTCHA.
- Credenciais só de variável de ambiente, `.env` fora do git ou `keyring`.
- Esperas explícitas do elemento certo, não `sleep` fixo. Abas de página: clicar e esperar o conteúdo da aba antes do próximo passo.
- Um método por fluxo, com o mesmo nome do fluxo no mapa. Na falha, screenshot e HTML em `logs/` com o passo.
- Ação irreversível (enviar, assinar, excluir, protocolar): confirmar com a pessoa na primeira execução; testar com um item antes do lote.

## Ao terminar (obrigatório)
- Atualize o mapa do site: cada passo novo, inclusive os "óbvios" (ex.: "trocar para a aba Documentos antes de clicar no item"), seletores na tabela, armadilhas com data, projeto que usa o site e data da conferência.
- Atualize o índice de sites, a nota do projeto e o log diário.
