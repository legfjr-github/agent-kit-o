---
name: sistemas-com-ia
description: Padrões para criar sistemas com integração de IA, pela API paga (Claude, Gemini) ou pelas CLIs locais já logadas (Claude Code, Antigravity/agy, opencode), com camada de provedores, saída estruturada, streaming, cota, custos, testes e segurança contra injeção de prompt. Use quando o pedido for criar ou mudar um sistema, painel, script ou automação que chama um modelo de IA ("integrar com IA", "usar o Claude/Gemini no sistema", "analisar com IA", "gerar com LLM", "chatbot", "resumir automaticamente").
---

# Sistemas com integração de IA

Guia completo, com código: `{{VAULT_PATH}}\guias_e_comandos\sistemas_com_ia.md`. Leia antes de escrever código e siga as decisões de lá. Resumo do que não pode faltar:

1. **Escolha o caminho** e diga ao usuário qual e por quê: API (servidor, vários usuários, produção) ou CLI local (ferramenta no PC de quem usa, sem chave, usa a assinatura ou os modelos gratuitos do opencode).
2. **Camada de provedores** com a mesma interface (`run(prompt, modelo) -> texto, uso, tempo`), prompts em arquivos, registro de cada execução (modelo, tokens, custo, status, id), timeout e cancelamento.
3. **API Claude:** SDK oficial (`anthropic` / `@anthropic-ai/sdk`), modelo padrão `claude-opus-5-5` (volume: `claude-sonnet-5-5`; simples: `claude-haiku-5-5`), chave em variável de ambiente, `messages.parse` para JSON validado, streaming para respostas longas, `output_config.effort` para custo, checar `stop_reason` (`refusal`, `max_tokens`), cache de prompt na parte fixa. Para recursos avançados, use também a skill `claude-api` se existir.
4. **CLI local:** pasta neutra, prompt pelo stdin, `.exe` real no Windows, sem ferramentas quando só precisa de texto, saída JSON linha a linha, detecção de cota e troca de provedor. Comandos exatos na seção 4 do guia.
5. **Segurança:** texto de usuário/documento é dado, nunca instrução; o modelo não ganha permissão que o usuário não tem; saída exibida escapada; dado pessoal mínimo; checklist de segurança do cofre com os testes extras de IA.
6. **Testes:** provedor falso nos testes de unidade; um teste real marcado como lento; conjunto de casos reais para comparar prompt e modelo.
7. **Fechamento:** nota do projeto no cofre dizendo provedor, modelos, onde ficam os prompts e o custo estimado; índice e log diário.

Trabalho grande (muitos arquivos, vários lotes): planeje e execute com a skill `delegar`.
