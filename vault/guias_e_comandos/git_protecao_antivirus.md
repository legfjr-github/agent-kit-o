---
titulo: Git protegido contra arquivos apagados pelo antivírus
categoria: guias_e_comandos
tags: [git, antivirus, bitdefender, hook, sync]
atualizado: 2026-11-12
resumo: Hook pre-commit e reparo (scripts/git_protecao.py) que impedem que um commit registre a exclusão de arquivos removidos ou bloqueados pelo antivírus, e devolvem ao git os que já foram apagados por engano.
---

# 🛡️ Git protegido contra o antivírus

## O problema
Antivírus corporativos às vezes removem arquivos legítimos (`.pyw`, `.mjs`, `.js`) e depois negam recriá-los no mesmo caminho ("acesso negado"). Um `git add -A` (o `git_sync_all.pyw`, o `sync.py` ou um agente) registra a exclusão, o push leva para o GitHub e o arquivo some também nos outros PCs, que deixam de funcionar.

## A proteção (`agent-kit/scripts/git_protecao.py`)
- **Hook pre-commit** em cada repositório: se o commit vai apagar um arquivo **listado no `.protegidos`** do repositório ou cujo caminho **o PC não deixa criar** (bloqueio do antivírus), a exclusão sai do commit, o arquivo continua no git como estava e fica marcado `skip-worktree` (o git não volta a acusar a falta dele na pasta). As outras mudanças seguem normalmente.
- **Reparo:** arquivo do HEAD que falta na pasta e é protegido fica marcado `skip-worktree`; arquivo listado no `.protegidos` que um commit recente (últimos 200) apagou volta ao git a partir do commit anterior, num commit "restaura arquivos protegidos apagados por engano". Se o antivírus deixar, volta também para a pasta.
- **`.protegidos`** (na raiz do repositório, versionado, um caminho ou padrão glob por linha): vale em todos os PCs.

## Onde roda
- `sync.py push` instala o hook e repara antes do `git add -A`.
- `install.py` instala no kit e, com `--mapear`, em todo repositório encontrado no PC. No kit público também.

## Comandos
```powershell
python %USERPROFILE%\agent-kit\scripts\git_protecao.py status <repo>      # hook ativo? o que está protegido ou faltando
python %USERPROFILE%\agent-kit\scripts\git_protecao.py instalar <repo>    # hook + reparo
python %USERPROFILE%\agent-kit\scripts\git_protecao.py reparar <repo>     # só o reparo
```

## Apagar de propósito um arquivo protegido
```powershell
git update-index --no-skip-worktree <arquivo>
$env:GIT_PERMITIR_APAGAR = '1'; git rm --cached <arquivo>; git commit -m "remove <arquivo>"; Remove-Item Env:GIT_PERMITIR_APAGAR
```
O hook acrescenta `!<arquivo>` ao `.protegidos` no mesmo commit; assim o reparo não devolve o arquivo em nenhum PC.

## Quando um arquivo some
1. Não recrie com outro nome para fugir do antivírus; peça à TI a liberação ou confira a quarentena.
2. O git continua com o arquivo (hook/reparo). Em outro PC, `git pull` traz o arquivo normalmente.
3. Acrescente o caminho ao `.protegidos` do repositório e registre no log do cofre.

## Testes (12/11/2026, repositório temporário)
- Antivírus "apaga" `iniciar.pyw` (listado) e a pessoa apaga `normal.txt`; `git add -A` + commit: só `normal.txt` saiu; `iniciar.pyw` continuou no HEAD; `git status` limpo.
- Commit antigo sem hook apagou `app/painel.js` (listado): `reparar` devolveu ao git e à pasta, com commit próprio.
- Remoção de propósito com o procedimento acima: funcionou.
- Detecção de bloqueio: caminho comum livre não é tratado como bloqueado e o teste não deixa arquivo para trás.
