---
titulo: Interfaces desktop com PyQt6 (estrutura e design)
categoria: arquitetura_e_padroes
tags: [python, pyqt6, desktop, design-system, qss, ux]
atualizado: 2026-11-12
resumo: Padrão para criar programas desktop em PyQt6 com aparência consistente, tema por tokens, interface que não trava e empacotamento com Nuitka.
---

# 🖥️ Interfaces desktop com PyQt6

## Estrutura do projeto
```
meu_programa/
  app.py               # cria QApplication, aplica o tema, abre a janela principal
  core/                # regras de negócio, sem nenhum import de PyQt6 (testável com pytest)
  ui/
    janela_principal.py
    componentes.py     # botões, cartões, campos com estilo padrão
    tema.py            # tokens de cor/espaço e geração do QSS
  recursos/            # ícones .svg, .ico, fontes
  tests/
```
Regra: a interface chama o `core`; o `core` nunca conhece a interface. Isso permite testar as regras sem abrir janela.

## Tema por tokens
Defina as cores e espaçamentos num lugar só e gere o QSS a partir deles. Trocar o tema (claro/escuro, cor da marca) vira mudar um dicionário.
```python
# ui/tema.py
CLARO = {"fundo": "#F6F7F9", "superficie": "#FFFFFF", "texto": "#1D2330", "texto_suave": "#5F6B7D",
         "borda": "#DFE3EA", "primaria": "#2B59C3", "primaria_texto": "#FFFFFF", "perigo": "#B3261E", "ok": "#1F7A4A"}
ESCURO = {"fundo": "#12151B", "superficie": "#1B2029", "texto": "#E6E9EF", "texto_suave": "#9AA5B5",
          "borda": "#2C3340", "primaria": "#7AA2FF", "primaria_texto": "#0D1220", "perigo": "#FF7B72", "ok": "#5CC98D"}
ESPACO = {"xs": 4, "s": 8, "m": 12, "l": 16, "xl": 24}
RAIO = 8

def qss(t: dict) -> str:
    return f"""
    QWidget {{ background: {t['fundo']}; color: {t['texto']}; font-size: 10pt; }}
    QFrame#cartao {{ background: {t['superficie']}; border: 1px solid {t['borda']}; border-radius: {RAIO}px; }}
    QPushButton {{ padding: 6px 14px; border-radius: 6px; border: 1px solid {t['borda']}; background: {t['superficie']}; }}
    QPushButton[variante="primaria"] {{ background: {t['primaria']}; color: {t['primaria_texto']}; border-color: {t['primaria']}; }}
    QPushButton[variante="perigo"] {{ color: {t['perigo']}; border-color: {t['perigo']}; }}
    QPushButton:disabled {{ color: {t['texto_suave']}; }}
    QLineEdit, QComboBox, QTextEdit {{ padding: 6px; border: 1px solid {t['borda']}; border-radius: 6px; background: {t['superficie']}; }}
    QLabel[papel="dica"] {{ color: {t['texto_suave']}; }}
    """
```
Variações de componente por propriedade, não por classe nova:
```python
botao = QPushButton("Salvar"); botao.setProperty("variante", "primaria")
```
Siga o tema do sistema quando possível: `QApplication.styleHints().colorScheme()` (Qt 6.5+) diz se o Windows está em modo escuro.

## Layout
- Sempre layouts (`QVBoxLayout`, `QHBoxLayout`, `QGridLayout`, `QFormLayout`); nada de `setGeometry` ou tamanho fixo. A janela tem de funcionar de 1024x600 até tela cheia.
- Margens e espaçamento vindos de `ESPACO`, iguais em todas as telas.
- Formulários com `QFormLayout`: rótulo à esquerda, campo à direita, mensagem de erro logo abaixo do campo.
- Uma ação principal por tela, com `variante="primaria"`; ações destrutivas com `variante="perigo"` e confirmação.

## Não travar a interface
Toda operação que pode passar de ~200 ms (rede, arquivo grande, banco, cálculo) roda fora da thread da interface.
```python
from PyQt6.QtCore import QObject, QRunnable, QThreadPool, pyqtSignal

class Sinais(QObject):
    progresso = pyqtSignal(int)
    terminou = pyqtSignal(object)
    falhou = pyqtSignal(str)

class Tarefa(QRunnable):
    def __init__(self, funcao, *args):
        super().__init__(); self.funcao, self.args, self.sinais = funcao, args, Sinais()
    def run(self):
        try:
            self.sinais.terminou.emit(self.funcao(*self.args, progresso=self.sinais.progresso.emit))
        except Exception as e:
            self.sinais.falhou.emit(str(e))

tarefa = Tarefa(core.importar_planilha, caminho)
tarefa.sinais.terminou.connect(self.mostrar_resultado)
tarefa.sinais.falhou.connect(self.mostrar_erro)
QThreadPool.globalInstance().start(tarefa)
```
- Nunca mexa em widget de dentro da tarefa: só emita sinais.
- Mostre progresso (`QProgressBar`) e ofereça Cancelar em tarefa longa.
- Desabilite o botão que disparou a tarefa até ela terminar (evita clique duplo).

## Acabamento
- Ícones em SVG (ficam nítidos em qualquer escala; o Qt 6 já trata alto DPI).
- Atalhos de teclado nas ações principais (`QAction` com `setShortcut`), ordem de Tab coerente, `setAccessibleName` em botões só com ícone, dicas (`setToolTip`).
- Preferências com `QSettings("MinhaEquipe", "MeuPrograma")` (tamanho da janela, última pasta usada).
- Erros: mensagem para a pessoa ("Não consegui abrir a planilha: o arquivo está aberto no Excel") e detalhe técnico no log (`logging` para arquivo em `%LOCALAPPDATA%\MeuPrograma`).
- Textos da interface em português, sem jargão; números e datas no formato brasileiro (`QLocale(QLocale.Language.Portuguese, QLocale.Country.Brazil)`).

## Testes
- Regras do `core` com pytest comum ([[guias_e_comandos/padroes_de_testes]]).
- Interface com `pytest-qt` (`qtbot.mouseClick`, `qtbot.waitSignal`) só para o fluxo principal.

## Empacotar
[[guias_e_comandos/executaveis_nuitka]] (seção PyQt6).
