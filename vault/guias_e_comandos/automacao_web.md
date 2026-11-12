---
titulo: Automação web (undetected-chromedriver, mapas de site, passo a passo)
categoria: guias_e_comandos
tags: [automacao, selenium, undetected-chromedriver, govbr, scraping, rpa, python]
atualizado: 2026-11-12
resumo: Como criar automações de navegador que funcionam em sites do governo e similares, e como registrar o passo a passo de cada site em automacoes/sites/ para reaproveitar na próxima automação.
---

# 🕹️ Automação web

## Regra principal: todo site automatizado tem um mapa
Antes de automatizar qualquer coisa num site, abra `automacoes/00_MAPA_DE_SITES.md` e o mapa do site (`automacoes/sites/<dominio>.md`). Ele diz como entrar, por onde navegar, em que aba ou iframe cada coisa fica e o que já deu errado. Ao terminar, **atualize o mapa** com cada passo novo que descobriu, mesmo os que parecem óbvios ("primeiro clicar na aba Documentos, só então a lista aparece"). Modelo: `automacoes/sites/_modelo_site.md`.

O que vai no mapa:
- **Entrada:** URL, tipo de login (formulário próprio, gov.br, certificado), se tem CAPTCHA ou verificação em duas etapas, como saber que a sessão caiu.
- **Telas:** nome da tela, URL ou caminho de cliques até ela, iframes e abas (do site ou do navegador) envolvidos.
- **Fluxos:** passo a passo numerado de cada tarefa já automatizada, com o seletor de cada clique e o que esperar antes do próximo passo.
- **Seletores:** tabela com elemento, seletor preferido, alternativo e onde fica (frame/aba).
- **Armadilhas:** o que falhou e como foi resolvido (popup que aparece só às vezes, botão que só habilita depois de rolar, lista que carrega por AJAX).
- **Projetos que usam o site** e a data da última conferência.

Quando encontrar um projeto com automação que ainda não tem mapa (o `install.py --mapear` cria um esboço por domínio encontrado no código), leia o código e transforme os passos dele em mapa: URLs, ordem dos cliques, `switch_to.frame`, `switch_to.window`, esperas e seletores.

## Navegador: undetected-chromedriver por padrão
Sites do governo (gov.br, SEI, sistemas estaduais) e muitos portais bloqueiam o Selenium comum. Use **sempre** o `undetected-chromedriver` (`uc`), com o Chrome instalado no PC. O instalador do kit deixa `undetected-chromedriver`, `selenium` e `setuptools` instalados no Python.

```python
# pip install undetected-chromedriver selenium setuptools
import re, sys, winreg
from pathlib import Path
import undetected_chromedriver as uc

def versao_chrome() -> int | None:
    """Versão principal do Chrome instalado (o uc precisa dela para baixar o driver certo)."""
    for raiz in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(raiz, r"Software\Google\Chrome\BLBeacon") as k:
                return int(re.match(r"(\d+)", winreg.QueryValueEx(k, "version")[0]).group(1))
        except OSError:
            pass
    return None

def abrir_navegador(perfil: str = "padrao", headless: bool = False) -> uc.Chrome:
    """Chrome com perfil próprio da automação: o login fica salvo entre execuções."""
    pasta = Path.home() / ".automacoes" / "perfis" / perfil
    pasta.mkdir(parents=True, exist_ok=True)
    opts = uc.ChromeOptions()
    opts.add_argument("--lang=pt-BR")
    opts.add_experimental_option("prefs", {"download.default_directory": str(Path.cwd() / "downloads"),
                                           "download.prompt_for_download": False})
    return uc.Chrome(options=opts, user_data_dir=str(pasta), version_main=versao_chrome(), headless=headless)
```
- **Perfil próprio por automação** (`user_data_dir`): a pessoa faz o login uma vez (gov.br, SEI) e as próximas execuções já entram logadas. Nunca use o perfil do Chrome do dia a dia (ele fica travado se o Chrome estiver aberto).
- **Headless** atrapalha em sites com proteção; deixe visível por padrão e só esconda depois de testar.
- Erro "This version of ChromeDriver only supports Chrome version X": o Chrome atualizou; `version_main=versao_chrome()` resolve. Erro de `distutils` no Python 3.12+: falta `setuptools`.
- Feche com `driver.quit()` num `finally`.

## Login, CAPTCHA e verificação em duas etapas
- Credenciais vêm de variável de ambiente, `.env` fora do git ou do cofre de senhas do Windows (`keyring`); nunca no código, no log ou no mapa.
- **CAPTCHA, hCaptcha, reCAPTCHA e o segundo fator são feitos pela pessoa.** A automação abre a tela, avisa ("Faça o login e tecle Enter aqui") e espera a URL ou um elemento da área logada. Não tente resolver ou contornar CAPTCHA.
- Com perfil persistente, a pessoa só refaz o login quando a sessão expira. Detecte isso (voltou para a URL de login, apareceu o campo de senha) e peça de novo, em vez de falhar.

## Esperas e passos (o que mais quebra automação)
- Nada de `time.sleep` fixo como regra. Use `WebDriverWait(driver, 20).until(EC.element_to_be_clickable(...))`, `visibility_of_element_located`, `url_contains`, `number_of_windows_to_be`.
- **Abas do site** (tabs de uma página): clique na aba e **espere o conteúdo dela aparecer** antes de procurar o item. Registre no mapa: "aba X → esperar Y → clicar Z".
- **Iframes:** `driver.switch_to.frame(...)` antes de procurar; `switch_to.default_content()` para voltar. Se o frame varia, use uma busca recursiva por frames (exemplo no mapa do SEI) e anote no mapa em que frame cada coisa fica.
- **Janelas e abas do navegador:** guarde `driver.current_window_handle`, espere `number_of_windows_to_be(n+1)`, troque com `switch_to.window`, e volte para a original no fim.
- **Alertas do navegador:** `WebDriverWait(...).until(EC.alert_is_present()).accept()`.
- **Listas por AJAX e paginação:** espere a tabela mudar (contagem de linhas, texto do rodapé) depois de cada clique de página.
- **Elemento coberto ou fora da tela:** `driver.execute_script("arguments[0].scrollIntoView({block:'center'})", el)` e, se ainda falhar, clique por JS; anote no mapa.
- **Seletores:** prefira `id`, `name`, `data-*`, texto visível estável (`//a[normalize-space()='Incluir Documento']`). Evite XPath absoluto (`/html/body/div[3]/...`) e classes geradas.

## Estrutura de um projeto de automação
```
minha_automacao/
  navegador.py      # abrir_navegador(), esperas e helpers (frames, janelas)
  sites/sei.py      # uma classe por site, um método por fluxo do mapa: login(), abrir_processo(), incluir_documento()
  tarefas/          # o que o usuário quer (lê planilha, chama os fluxos)
  logs/             # log por execução + screenshot e HTML na falha
  .env.example      # nomes das variáveis, sem valores
```
- Um método por fluxo, com o mesmo nome do fluxo no mapa do site.
- **Na falha:** salve `driver.save_screenshot()` e `driver.page_source` em `logs/` com data e o passo que falhou; isso vira a próxima linha de "Armadilhas" no mapa.
- Processamento em lote: registre o que já foi feito (planilha ou JSON) para retomar de onde parou; uma falha num item não derruba o lote.
- Confirmação antes de ações irreversíveis (assinar, excluir, enviar, protocolar) na primeira execução de um fluxo novo.

## Segurança e cuidado com o site
- Automatize só o que a pessoa tem permissão de fazer com a própria conta. Nada de raspagem em massa nem ritmo maior que o de uma pessoa (pausas curtas entre itens).
- Dados pessoais lidos do site seguem o [[guias_e_comandos/checklist_seguranca_sistemas_web]] (LGPD): guarde o mínimo, fora do git.
- Teste primeiro com um item; depois com poucos; só então com o lote.

## Pedido para um agente criar uma automação
"Automatize <tarefa> no site <url> seguindo [[guias_e_comandos/automacao_web]]: leia o mapa do site (crie a partir do modelo se não existir), use undetected-chromedriver com perfil próprio, deixe login e CAPTCHA comigo, teste com um item e atualize o mapa com cada passo, seletor e armadilha que encontrar."
