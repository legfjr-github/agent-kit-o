# Usar a TecAPI pelo Selenium (alternativa ao Playwright MCP)

Mesma biblioteca (`tec_api.js`), injetada com `execute_async_script`. Perfil persistente para guardar o login: `~/.automacoes/perfis/tecconcursos` (o login é feito pela pessoa na primeira vez). Base do driver: guia `automacao_web` do cofre.

```python
import json, time
from pathlib import Path
import undetected_chromedriver as uc  # pip install undetected-chromedriver selenium setuptools

JS = (Path(__file__).parent / "tec_api.js").read_text(encoding="utf-8")

def abrir():
    pasta = Path.home() / ".automacoes" / "perfis" / "tecconcursos"
    pasta.mkdir(parents=True, exist_ok=True)
    d = uc.Chrome(user_data_dir=str(pasta))  # passe version_main=<versão do Chrome> se o driver reclamar
    d.get("https://www.tecconcursos.com.br/questoes/pastas")
    while not d.execute_script("return !!document.querySelector('nav#header-menu.logado, #secao-principal.logado')"):
        input("Faça o login no TEC e tecle Enter aqui...")
        d.get("https://www.tecconcursos.com.br/questoes/pastas")
    return d

def tec(d, expressao, *args):
    """Roda `await <expressao>` com a TecAPI carregada. Ex.: tec(d, "TecAPI.contar(arguments[0], arguments[1])", "OBJETIVA", filtros)"""
    script = JS + """
    ;const done = arguments[arguments.length - 1];
    (async () => %s)().then(r => done({ok: r}), e => done({erro: String(e && (e.message || e.status) || e)}));
    """ % expressao
    r = d.execute_async_script(script, *args)
    if "erro" in r:
        raise RuntimeError(r["erro"])
    return r["ok"]

# Exemplo: contar um plano, gerar os cadernos e extrair questões
if __name__ == "__main__":
    d = abrir()
    d.set_script_timeout(120)
    plano = json.loads(Path("plano.json").read_text(encoding="utf-8"))
    contagem = tec(d, "TecAPI.contarPlano(arguments[0])", plano)
    pasta = tec(d, "TecAPI.garantirPasta(arguments[0])", plano["pasta"])
    for c in contagem:
        d.get("https://www.tecconcursos.com.br" + c["url"])
        for _ in range(30):
            if tec(d, "TecAPI.estadoGerador()").get("pronto"):
                break
            time.sleep(1)
        tec(d, "TecAPI.prepararGerador(arguments[0], arguments[1], true)", c["nome"], pasta["id"])
        for _ in range(30):
            time.sleep(1)
            if "/questoes/cadernos/" in d.current_url:
                break
        print(c["nome"], d.current_url)
    # Extração: em Selenium pode ser síncrona (aumente o script_timeout) ou usar iniciarExtracao + statusExtracao.
    d.get("https://www.tecconcursos.com.br/questoes/pastas")
    ids = tec(d, "TecAPI.idsQuestoes('DISCURSIVA', arguments[0])", contagem[-1]["filtros"])[:10]
    dados = [tec(d, "TecAPI.extrairQuestao(arguments[0], {forum: 3})", i) for i in ids]
    Path("questoes.json").write_text(json.dumps(dados, ensure_ascii=False, indent=2), encoding="utf-8")
    md = tec(d, "TecAPI.paraMarkdown(arguments[0], 'Discursivas')", dados)
    Path("questoes.md").write_text(md, encoding="utf-8")
    d.quit()
```

Notas:
- No Selenium o arquivo é gravado pelo Python; não precisa do download da página (`baixar`).
- `execute_async_script` injeta a biblioteca inteira a cada chamada; é simples e evita perder o `window.TecAPI` depois de navegar.
- Login, CAPTCHA e segundo fator ficam com a pessoa.
