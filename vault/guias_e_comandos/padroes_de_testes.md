---
titulo: Padrões de testes (o que testar, como escrever, como rodar)
categoria: guias_e_comandos
tags: [testes, pytest, unittest, django, node, playwright, qualidade]
atualizado: 2026-11-12
resumo: Regras para gerar e manter testes automatizados em qualquer projeto, inclusive quando quem escreve é um agente de IA.
---

# 🧪 Padrões de testes

## Regras gerais
1. **Todo bug corrigido ganha um teste** que falha antes da correção e passa depois. O agente mostra as duas execuções.
2. **Um comportamento por teste.** Se o nome precisa de "e", são dois testes.
3. **Nome diz a situação e o resultado:** `test_saida_com_lote_vencido_ignora_o_lote`, não `test_saida_2`.
4. **Estrutura Arrange / Act / Assert**, separadas por uma linha em branco.
5. **Determinístico:** sem rede, sem relógio real, sem aleatoriedade solta. Fixe a data (`freezegun`, `time-machine`, injeção de `hoje`), a semente e use servidores falsos.
6. **Não teste a implementação, teste o contrato:** entrada e saída públicas, efeitos visíveis (banco, arquivo, resposta HTTP). Não faça mock da própria função que está testando.
7. **Dados de teste nunca são dados reais.** CPF, e-mail e nomes gerados (CPF válido de teste: gere pelo algoritmo, não copie de pessoa real). Senhas e tokens de teste ficam em arquivo de exemplo (`.env.example`), nunca os reais.
8. **Teste rápido roda sempre.** A suíte de unidade deve rodar em segundos; testes lentos (navegador, integração) ficam marcados e rodam antes do deploy.
9. **Rodar antes de dizer que terminou.** Agente que escreve teste e não roda não terminou.

## O que testar primeiro
| Prioridade | O quê | Exemplos |
|---|---|---|
| 1 | Regras de negócio e cálculos | valores, prazos, limites, arredondamento (`Decimal` para dinheiro) |
| 2 | Permissões | quem pode ver/alterar o quê; rota sem login devolve 401/403 |
| 3 | Validação de entrada no servidor | campo vazio, tipo errado, tamanho máximo, JSON malformado devolve 400 sem 500 |
| 4 | Fluxos completos | cadastro → aprovação → relatório |
| 5 | Integrações | APIs externas com servidor falso; banco real em contêiner quando der |
| 6 | Interface | o caminho principal no navegador (Playwright) |

## Casos de borda que quase sempre faltam
- Vazio, um item, muitos itens; primeiro e último do intervalo; limite exato (`<` vs `<=`).
- Texto com acento, emoji, espaços nas pontas, maiúsculas/minúsculas.
- Datas: 29/02, virada de ano, fuso horário, horário de verão, "hoje" igual à data limite.
- Números: zero, negativo, muito grande, separador decimal brasileiro.
- Concorrência: duas requisições iguais ao mesmo tempo (só uma deve ter efeito).
- Ordem das operações: etapa fora de ordem deve ser recusada.

## Segurança
Sistemas com login, formulário público, painel ou dado pessoal seguem também a seção 6 do [[guias_e_comandos/checklist_seguranca_sistemas_web]] (testes de ataque). Transforme em teste automatizado o que der: rota sem credencial, payload XSS em cada campo, JSON com tipos errados, CSRF, limite de tentativas.

## Comandos por tecnologia
```bash
# Python (pytest)
python -m pytest -q                      # tudo
python -m pytest -q -k "estoque and not lento"
python -m pytest --cov=app --cov-report=term-missing

# Python (unittest, sem dependências)
python -m unittest -v

# Django
python manage.py test --parallel         # usa TestCase e self.client

# Node (sem dependências, Node 20+)
node --test

# Navegador
npx playwright test
```

Estrutura sugerida: `tests/` espelhando o código (`app/estoque.py` → `tests/test_estoque.py`), `tests/conftest.py` com as fábricas de dados, testes lentos marcados (`@pytest.mark.lento`).

## Cobertura
Meta prática: 90% ou mais nas regras de negócio e permissões; o resto, o que fizer sentido. Cobertura alta com asserção fraca não vale nada: cada teste precisa conferir o resultado, não só executar o código.

## Integração contínua (GitHub Actions)
```yaml
name: testes
on: [push, pull_request]
jobs:
  testes:
    runs-on: windows-latest   # ou ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.13" }
      - run: pip install -r requirements.txt pytest
      - run: python -m pytest -q
```

## Pedido para um agente gerar testes
"Escreva testes para `<módulo>` seguindo [[guias_e_comandos/padroes_de_testes]]: liste antes os comportamentos e casos de borda que vai cobrir, escreva um teste por comportamento, rode a suíte, mostre a saída e diga o que ficou sem teste e por quê."
