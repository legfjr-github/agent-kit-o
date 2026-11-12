# 🛡️ Regra Global: Segurança e Testes de Ataque por Padrão

1. **Quando vale:** todo sistema ou alteração com login, formulário público, painel administrativo, dado pessoal (CPF, matrícula, e-mail, telefone) ou resultado que não pode ser manipulado (sorteio, pagamento, cálculo, aprovação).
2. **Checklist obrigatório:** antes de entregar, siga `{{VAULT_PATH}}\guias_e_comandos\checklist_seguranca_sistemas_web.md` (escape de todo dado externo exibido, validação no servidor, sessão sem expor senha, limite de tentativas, aleatoriedade criptográfica, transações contra corrida, trilha de auditoria, CSP/SRI/HSTS, CORS fechado, hash de IP com segredo).
3. **Testes de ataque:** rode localmente os testes da seção 6 do checklist que se aplicam ao que foi feito, sem esperar o usuário pedir. Em mudança pequena, ao menos os testes da área tocada.
4. **Relato:** informe ao usuário o que foi testado, o resultado e os riscos que continuam (com o motivo), e registre no log diário do cofre.
5. **Produção:** depois do deploy, repita contra produção os testes que não gravam dados reais. Não crie inscrição, pagamento ou registro real só para testar.
