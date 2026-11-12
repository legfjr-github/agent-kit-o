---
titulo: Executáveis Windows com Nuitka (só o necessário)
categoria: guias_e_comandos
tags: [python, nuitka, executavel, pyqt6, windows, distribuicao]
atualizado: 2026-11-12
resumo: Como gerar .exe de programas Python com o Nuitka incluindo apenas o que o programa usa, com e sem interface PyQt6.
---

# 📦 Executáveis com Nuitka

O Nuitka traduz o Python para C e compila. O executável roda sem Python instalado. A regra deste guia: **o pacote leva só o que o programa usa**. Tudo a mais aumenta o tamanho, o tempo de compilação e os alarmes falsos de antivírus.

## 1. Ambiente limpo (o passo que mais reduz tamanho)
O Nuitka segue os `import`. Um venv com bibliotecas sobrando arrasta essas bibliotecas para o pacote.
```powershell
py -3.13 -m venv .venv-build
.\.venv-build\Scripts\python -m pip install -U pip
.\.venv-build\Scripts\python -m pip install -r requirements.txt nuitka ordered-set zstandard
```
- `requirements.txt` só com o que o programa importa em produção (nada de pytest, black, jupyter).
- Use uma versão de Python que o Nuitka da sua versão suporte (veja `python -m nuitka --version`).
- Compilador: na primeira vez o Nuitka oferece baixar o MinGW64; `--assume-yes-for-downloads` aceita sem perguntar. Com Visual Studio Build Tools instalado, ele usa o MSVC.

## 2. Comando base (programa de linha de comando)
```powershell
.\.venv-build\Scripts\python -m nuitka app.py `
  --standalone `
  --output-dir=build `
  --remove-output `
  --assume-yes-for-downloads `
  --python-flag=no_docstrings `
  --python-flag=-O `
  --noinclude-pytest-mode=nofollow `
  --noinclude-setuptools-mode=nofollow `
  --noinclude-unittest-mode=nofollow
```
| Opção | Por quê |
|---|---|
| `--standalone` | pasta `build\app.dist` com o `.exe` e as dependências; abre rápido e dá menos alarme de antivírus que o `--onefile` |
| `--onefile` (em vez de standalone) | um único `.exe`; ele se extrai numa pasta temporária a cada execução. Use só quando um arquivo único for exigência |
| `--remove-output` | apaga os arquivos C intermediários |
| `--python-flag=no_docstrings`, `-O` | tira docstrings e `assert` do pacote |
| `--noinclude-*-mode=nofollow` | não arrasta pytest, setuptools e unittest quando alguma biblioteca os importa sem precisar |
| `--nofollow-import-to=<pacote>` | exclui um pacote que o programa não usa em produção (ex.: `--nofollow-import-to=matplotlib`). Teste depois: se o programa precisar dele, quebra |

## 3. Programa com interface PyQt6
Acrescente:
```powershell
  --enable-plugin=pyqt6 `
  --windows-console-mode=disable `
  --windows-icon-from-ico=recursos\icone.ico `
  --include-data-dir=recursos=recursos `
  --noinclude-qt-translations
```
- `--enable-plugin=pyqt6`: obrigatório; inclui os plugins do Qt que o programa usa (plataforma, estilos, formatos de imagem). Não use PySide6 e PyQt6 no mesmo programa.
- `--include-qt-plugins=...` só se faltar algo em tempo de execução (ex.: `sqldrivers` para QtSql, `multimedia`). Acrescente um de cada vez.
- `--windows-console-mode=disable`: sem janela preta. Durante o desenvolvimento use `attach` para ver os erros.
- `--include-data-dir` / `--include-data-files`: só as pastas que o programa lê (ícones, QSS, modelos). No código, ache os arquivos a partir de `Path(__file__).parent`, nunca do diretório atual.
- `--noinclude-qt-translations`: tira as traduções do Qt quando a interface já está em português.

## 4. Metadados do executável (aparecem em Propriedades > Detalhes)
```powershell
  --company-name="Minha Equipe" --product-name="Meu Programa" `
  --file-version=1.2.0.0 --product-version=1.2.0.0 `
  --file-description="Meu Programa" --copyright="(c) 2026 Minha Equipe"
```

## 5. Opções dentro do código (dispensa decorar o comando)
No topo do `app.py`:
```python
# nuitka-project: --standalone
# nuitka-project: --enable-plugin=pyqt6
# nuitka-project: --windows-console-mode=disable
# nuitka-project: --windows-icon-from-ico={MAIN_DIRECTORY}/recursos/icone.ico
# nuitka-project: --include-data-dir={MAIN_DIRECTORY}/recursos=recursos
# nuitka-project: --output-dir=build
```
Depois basta `python -m nuitka app.py`.

## 6. Conferir antes de entregar
1. Rodar `build\app.dist\app.exe` numa máquina (ou VM, ou Windows Sandbox) **sem Python**.
2. Abrir todas as telas e funções que leem arquivos, banco ou rede.
3. Ver o tamanho da pasta: o que for grande e inesperado em `app.dist` é candidato a `--nofollow-import-to`.
4. Antivírus: prefira `--standalone`; assine o executável com certificado de assinatura de código quando for distribuir; se um antivírus acusar, envie o arquivo para análise de falso positivo do fabricante.
5. Distribuir: zip da pasta `app.dist` ou um instalador (Inno Setup) que copia a pasta e cria o atalho.

## 7. Problemas comuns
| Sintoma | Causa provável | Solução |
|---|---|---|
| `ModuleNotFoundError` só no .exe | import dinâmico (`importlib`, plugin) | `--include-module=pacote.modulo` ou `--include-package=pacote` |
| Arquivo de dados não encontrado | caminho relativo ao diretório atual | caminho a partir de `Path(__file__).parent` + `--include-data-dir` |
| Janela abre e fecha | erro na inicialização escondido pelo console desligado | compilar com `--windows-console-mode=attach` e ler o erro |
| Compilação muito lenta | venv com bibliotecas grandes sem uso | venv limpo, `--nofollow-import-to` |
| Pacote enorme com PyQt6 | QtWebEngine ou Qt3D arrastados | não importar o que não usa; conferir `app.dist` |

Ver também [[arquitetura_e_padroes/pyqt6_design_desktop]].
