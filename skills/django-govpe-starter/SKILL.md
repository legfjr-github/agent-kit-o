---
name: "django-govpe-starter"
description: "Guia e templates para iniciar projetos Django corporativos com Jazzmin, Design System do Governo de Pernambuco, dashboards, auditoria e import/export de planilhas."
---

# Guia de Inicialização de Projetos Django - Padrão Governo de Pernambuco (GovPE)

Este guia fornece todo o padrão arquitetural, visual e funcional consolidado para criar rapidamente aplicações web e painéis administrativos corporativos aderentes à identidade visual do **Governo do Estado de Pernambuco** (`pe.gov.br`).

---

## 1. Stack Tecnológica e Dependências

```bash
pip install django django-jazzmin openpyxl python-dateutil
```

### `requirements.txt` recomendado:
```text
Django>=5.0,<6.0
django-jazzmin>=3.0.0
openpyxl>=3.1.0
python-dateutil>=2.9.0
Pillow>=10.0.0
```

---

## 2. Estrutura do Projeto

```text
meu_projeto/
├── core/
│   ├── settings.py
│   ├── urls.py
│   └── wsgi.py
├── app_principal/
│   ├── management/commands/
│   ├── static/app_principal/
│   │   ├── css/custom.css
│   │   ├── js/custom.js
│   │   └── img/logo-pe.png
│   ├── templates/admin/app_principal/
│   │   ├── change_form.html
│   │   ├── exportar_dados.html
│   │   ├── importar_dados.html
│   │   └── relatorio.html
│   ├── admin.py
│   ├── models.py
│   ├── services.py
│   └── views.py
└── manage.py
```

---

## 3. Configuração do `settings.py`

### Ordem de `INSTALLED_APPS` (Obrigatório: `jazzmin` antes de `django.contrib.admin`):
```python
INSTALLED_APPS = [
    'jazzmin',
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'app_principal',
]
```

### Configurações do Jazzmin:
```python
JAZZMIN_SETTINGS = {
    "site_title": "Portal de Gestão - GovPE",
    "site_header": "Governo de Pernambuco",
    "site_brand": "Nome do Sistema",
    "site_logo": "app_principal/img/logo-pe.png",
    "login_logo": "app_principal/img/logo-pe.png",
    "login_logo_dark": None,
    "site_icon": "app_principal/img/logo-pe.png",
    "welcome_sign": "Acesse o painel com suas credenciais institucionais",
    "copyright": "Governo do Estado de Pernambuco",
    "search_model": ["auth.User"],
    "user_avatar": None,
    "topmenu_links": [
        {"name": "Início", "url": "admin:index", "permissions": ["auth.view_user"]},
    ],
    "show_sidebar": True,
    "navigation_expanded": True,
    "hide_apps": [],
    "hide_models": [],
    "custom_css": "app_principal/css/custom.css",
    "custom_js": None,
    "use_google_fonts_cdn": True,
    "show_ui_builder": False,
    "changeform_format": "horizontal_tabs",
}

JAZZMIN_UI_TWEAKS = {
    'navbar_small_text': False,
    'footer_small_text': False,
    'body_small_text': False,
    'brand_small_text': False,
    'brand_colour': False,
    'accent': 'accent-primary',
    'navbar': 'navbar-primary navbar-dark',
    'no_navbar_border': True,
    'navbar_fixed': True,
    'layout_boxed': False,
    'footer_fixed': False,
    'sidebar_fixed': True,
    'sidebar': 'sidebar-dark-primary',
    'sidebar_nav_small_text': False,
    'sidebar_disable_expand': False,
    'sidebar_nav_child_indent': True,
    'theme': 'default',
    'default_theme_mode': 'light',
}
```

---

## 4. Design System GovPE (`custom.css`)

Criar em `static/app_principal/css/custom.css`:

```css
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&display=swap');

:root {
  --pe-blue-royal: #0049a9;
  --pe-blue-dark: #0b224d;
  --pe-blue-gradient: linear-gradient(135deg, #0049a9 0%, #0b224d 100%);
  --pe-green-accent: #0b9d21;
  --pe-green-light: #8ec63f;
  --pe-gold-accent: #f59e0b;
  --pe-bg-canvas: #f4f7fb;
  --pe-surface-card: #ffffff;
  --pe-border-subtle: #e2e8f0;
  --pe-text-title: #0b224d;
  --pe-text-body: #334155;
  --pe-text-muted: #64748b;
}

body {
  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
  background-color: var(--pe-bg-canvas) !important;
  color: var(--pe-text-body) !important;
}

/* Preservação de Ícones FontAwesome */
.fa, .fas, .far, .fal, .fab, .fad, i.fa, i.fas, i.far, [class*=" fa-"], [class^="fa-"] {
  font-family: "Font Awesome 5 Free", "FontAwesome" !important;
  font-style: normal !important;
  line-height: 1 !important;
}

/* Cabeçalho e Sidebar Unificados */
#jazzy-navbar.app-header, #jazzy-navbar.navbar, .app-header.navbar, .navbar,
.main-sidebar, .app-sidebar, #jazzy-sidebar, .main-sidebar .sidebar, .sidebar,
.brand-link, .main-sidebar .brand-link, #jazzy-sidebar .brand-link,
.navbar-brand, #jazzy-navbar .navbar-brand {
  background: var(--pe-blue-gradient) !important;
  background-color: #0049a9 !important;
  border: none !important;
  box-shadow: none !important;
  color: #ffffff !important;
}

.brand-link {
  background: transparent !important;
  border: none !important;
  display: flex !important;
  align-items: center !important;
  padding: 0.85rem 1rem !important;
}

.brand-link .brand-image, .navbar-brand img {
  height: 34px !important;
  width: auto !important;
  background: transparent !important;
  box-shadow: none !important;
}

/* Botão Toggle da Sidebar (Hamburger) */
[data-lte-toggle="sidebar"], [data-widget="pushmenu"] {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  padding: 0.45rem 0.75rem !important;
  color: #ffffff !important;
  border-radius: 6px !important;
  cursor: pointer !important;
}
[data-lte-toggle="sidebar"] i, [data-widget="pushmenu"] i {
  color: #ffffff !important;
  font-size: 1.15rem !important;
}

/* Itens de Navegação Lateral */
.sidebar .nav-link {
  color: rgba(255, 255, 255, 0.85) !important;
  border-radius: 8px !important;
  padding: 0.6rem 0.85rem !important;
  transition: all 0.2s ease-in-out;
}
.sidebar .nav-link:hover {
  background: rgba(255, 255, 255, 0.14) !important;
  color: #ffffff !important;
  transform: translateX(3px);
}
.sidebar .nav-link.active {
  background: rgba(255, 255, 255, 0.22) !important;
  color: #ffffff !important;
  font-weight: 700 !important;
  border-left: 3.5px solid var(--pe-green-light) !important;
}
.sidebar .nav-link.active i {
  color: var(--pe-green-light) !important;
}

/* Cards & Superfícies */
.card {
  background: var(--pe-surface-card) !important;
  border: 1px solid var(--pe-border-subtle) !important;
  border-radius: 12px !important;
  box-shadow: 0 4px 16px rgba(11, 34, 77, 0.05) !important;
  overflow: hidden;
}
.card-header {
  background: #f8fafc !important;
  border-bottom: 1px solid var(--pe-border-subtle) !important;
  font-weight: 700 !important;
  color: var(--pe-text-title) !important;
}

/* Botões */
.btn {
  border-radius: 8px !important;
  font-weight: 600 !important;
  padding: 0.5rem 1.15rem !important;
}
.btn-primary {
  background: linear-gradient(135deg, #0049a9 0%, #003882 100%) !important;
  border: none !important;
  color: #ffffff !important;
  box-shadow: 0 2px 6px rgba(0, 73, 169, 0.25) !important;
}
.btn-primary:hover {
  background: linear-gradient(135deg, #003882 0%, #0b224d 100%) !important;
  transform: translateY(-1px);
}
.btn-success {
  background: linear-gradient(135deg, #0b9d21 0%, #077918 100%) !important;
  border: none !important;
  color: #ffffff !important;
}

/* Badges Pílula */
.badge {
  border-radius: 50px !important;
  font-weight: 600 !important;
  padding: 0.35rem 0.85rem !important;
}
.badge-success { background: #e6f9ed !important; color: #0b9d21 !important; border: 1px solid #b7ebd0 !important; }
.badge-danger { background: #fdf2f2 !important; color: #d9363e !important; border: 1px solid #f8d7da !important; }
.badge-primary { background: #e6f3ff !important; color: #0049a9 !important; border: 1px solid #b8d6f5 !important; }
.badge-warning { background: #fffbeb !important; color: #b45309 !important; border: 1px solid #fde68a !important; }

/* Login Page */
.login-page {
  background: radial-gradient(ellipse at 50% 0%, #e3effa 0%, #f4f7fb 100%) !important;
}
.login-page .card {
  border-radius: 16px !important;
  box-shadow: 0 16px 40px -10px rgba(11, 34, 77, 0.15) !important;
  position: relative;
}
.login-page .card::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0; height: 4px;
  background: linear-gradient(90deg, #0049a9 0%, #8ec63f 50%, #f59e0b 100%);
  border-top-left-radius: 16px;
  border-top-right-radius: 16px;
}
```

---

## 5. JavaScript Auxiliar (`custom.js`)

Criar em `static/app_principal/js/custom.js`:

```javascript
document.addEventListener('DOMContentLoaded', function() {
  // Toggle robusto da barra lateral
  var toggleBtns = document.querySelectorAll('[data-lte-toggle="sidebar"], [data-widget="pushmenu"]');
  toggleBtns.forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      var body = document.body;
      if (body.classList.contains('sidebar-collapse')) {
        body.classList.remove('sidebar-collapse');
        body.classList.add('sidebar-open');
      } else {
        body.classList.add('sidebar-collapse');
        body.classList.remove('sidebar-open');
      }
    });
  });
});
```

---

## 6. Padrões de Implementação

### A. Auditoria Automática nos Modelos:
```python
class MeuModelo(models.Model):
    # ... campos ...
    criado_em = models.DateTimeField('Criado em', default=timezone.now)
    criado_por = models.ForeignKey(
        settings.AUTH_USER_MODEL, on_delete=models.SET_NULL,
        verbose_name='Cadastrado por', null=True, blank=True,
    )
```
No `ModelAdmin`:
```python
def save_model(self, request, obj, form, change):
    if not obj.pk and not obj.criado_por:
        obj.criado_por = request.user
    super().save_model(request, obj, form, change)
```

### B. Dashboard / Relatório com Gráficos Chart.js:
- Criar view agregada no `admin.py` herdando de `self.admin_site.admin_view`.
- Utilizar `Chart.js` via CDN no template `relatorio.html` com KPIs de variação percentual, gráfico de linhas temporal e gráfico donut de categorias.

### C. Importação / Exportação com Excel e CSV:
- Leitura compatível com `.xlsx` e `.csv` (delimitadores `,` e `;`, codificação `utf-8-sig`).
- Exportação XLSX estilizada com cabeçalho azul GovPE (`#0049A9`), grades e formatação monetária `R$ #,##0.00`.
- Exportação CSV com `utf-8-sig` e delimitador `;`.

### D. Auditoria de Lotes e Controle Rigoroso de Duplicidades por Competência:
- **Checksum SHA-256:** Cálculo criptográfico do arquivo na entrada para garantia de não-adulteração e imutabilidade.
- **Normalização de Referências/Competências:** Suporte a formatos numéricos (`04/2026`, `2026-04`) e textuais (`abr/2026`, `abril/2026`, `abr/26`), convertendo para o formato canônico `MM/AAAA`.
- **Retroativos Legítimos:** Permite pagamentos idênticos na mesma folha se pertencerem a competências/meses distintos (ex: `abr/2026`, `mai/2026`, `jun/2026`).
- **Negação Total de Arquivo:** Ao detectar duplicidades na mesma competência sem autorização prévia, o arquivo é **negado integralmente** (`status_conciliacao = 'arquivo_negado'`, 0 registros gravados), espelhando o erro linha a linha em `ItemLoteAuditoria`.
- **Opção Excepcional de Auditoria (`forcar_duplicados`):** Checkbox na interface permitindo a um auditor autorizado forçar a carga de duplicidades registradas sob parecer formal.
- **Painel Analítico de Batimento (4 Abas):**
  1. *Sumário Executivo e KPIs Financeiros* (Valor Entrada vs Valor Persistido).
  2. *Batimento Consolidado por Beneficiário / Pessoa* (Discriminando rubricas e totais individuais).
  3. *Batimento por Rubrica Oficial* (Volume financeiro e % da folha).
  4. *Espelho Linha a Linha De-Para* (Rastreabilidade completa de cada linha da planilha original).

### E. Cadastro Manual Ágil, Autocomplete, Último Dia Útil e Auditoria SHA-256:
- **Autenticação e Rastreabilidade do Operador:** Todo lançamento manual registra obrigatoriamente `criado_por` (usuário logado) e `criado_em`, permitindo ao gestor identificar com precisão o responsável por cada registro individual.
- **Assinatura Criptográfica SHA-256 no Cadastro Manual:** Geração automática do hash de integridade único `hash_integridade` no salvamento (com base na matrícula, código da rubrica, valor monetário, competência/referência, data de previsão e usuário autenticado).
- **Lote Manual Automático por Competência:** Cadastros manuais não requerem seleção de arquivos; o sistema cria/vincula automaticamente um lote consolidado no formato `Cadastro manual no mês {mês_abrev}/{ano}` com código `LOTE-MANUAL-YYYYMM`.
- **Previsão de Pagamento Inteligente (Último Dia Útil):** Pré-carregamento automático com o último dia útil do mês atual (segunda a sexta, recuando sábados e domingos para a sexta anterior) com botões rápidos de navegação `◀ Mês Anterior`, `🔘 Mês Atual` e `▶ Mês Seguinte`.
- **Sincronização Bidirecional da Competência:** O campo de referência `MM/AAAA` se atualiza automaticamente em sincronia com a data de previsão selecionada.
- **Bloqueio e Validação em Tempo Real de Duplicidades:** Checagem dinâmica via AJAX antes da submissão; caso haja duplicidade para a mesma pessoa + rubrica + competência, exige autorização expressa em checkbox de responsabilidade funcional para prosseguir (`forcar_duplicado=True`).
- **Autocomplete com Busca Dinâmica:** Pesquisa instantânea por nome, CPF (com ou sem máscara) e matrícula (SGP e SADRH) com modal para cadastro rápido de novo vínculo sem desviar do fluxo de digitação contínua (`Ctrl+Enter` para "Salvar e Lançar Outro").