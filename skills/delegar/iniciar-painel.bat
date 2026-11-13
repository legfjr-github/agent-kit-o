@echo off
setlocal
rem Abre o painel do orquestrador (delegar) em http://127.0.0.1:8790 fora de qualquer sessao de agente.
rem Use com dois cliques, pelo atalho da area de trabalho ou pela pasta Inicializar.
rem --sem-navegador: so sobe o painel. Log: %USERPROFILE%\.delegar\startup.log e server.log
set "DADOS=%USERPROFILE%\.delegar"
set "LOG=%DADOS%\startup.log"
if not exist "%DADOS%" mkdir "%DADOS%"
set "NODE="
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE set "NODE=%%N"
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE (
  echo [%date% %time%] node.exe nao encontrado no PATH>> "%LOG%"
  echo Node.js nao encontrado. Instale o Node.js e tente de novo.
  pause
  exit /b 1
)
set "DELEGAR_LANCADOR=1"
echo [%date% %time%] iniciando com "%NODE%">> "%LOG%"
"%NODE%" "%~dp0app\cli.mjs" iniciar >> "%LOG%" 2>&1
if errorlevel 1 (
  echo O painel nao subiu. Veja "%LOG%" e "%DADOS%\server.log".
  pause
  exit /b 1
)
if /i not "%~1"=="--sem-navegador" start "" http://127.0.0.1:8790
exit /b 0
