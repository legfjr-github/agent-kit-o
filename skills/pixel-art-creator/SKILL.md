---
name: "pixel-art-creator"
description: "Create and refine pixel art sprites, retro character designs, color palettes, dithering, and layer workflows."
---

# Pixel Art Creator & Professional Guidelines

## Overview
Esta skill guia a criação, refinamento e polimento de sprites em Pixel Art, baseada nas melhores práticas dos ecossistemas de desenvolvimento indie (estilos SNES, Game Boy, PICO-8, Stardew Valley, Chrono Trigger).

## Princípios Centrais de Design de Personagens (Pixel Art 16-bit / 32x32 a 48x76)

### 1. Proporções Harmônicas (Evitar o aspecto "Roblox / Bloco Rígido")
- **Silhueta e Relação Cabeça-Corpo:**
  - A cabeça deve ter proporção entre 1:3 a 1:4 da altura total em estilos acolhedores/chibi estéticos (como Stardew Valley / Minish Cap).
  - Em sprites de 48x76: cabeça com ~18-20px de altura total (incluindo queixo e cabelo), tronco de ~22px, pernas de ~26px e pés/sapatos de ~8px.
  - A silhueta externa deve ter curvas orgânicas com contorno contínuo de 1 pixel (sem duplicações ortogonais "jaggies").

### 2. Diferenciação de Gênero Orgânica e Atraente
Para diferenciar personagens masculinos e femininos mantendo a estética charmosa e acolhedora:
- **Mandíbula e Queixo:**
  - *Feminino:* Queixo ligeiramente afunilado (V suave) com 3 a 5 pixels no vértice, maçãs do rosto iluminadas e rubor suave nas bochechas.
  - *Masculino:* Mandíbula com base mais reta/firme (5 a 7 pixels), sem blush rosado carregado (usar sombra quente natural da pele), sobrancelhas 1 pixel mais espessas e olhar determinado.
  - *Opção de Barba / Cavanhaque / Sombra de Barba:* Uma das formas mais charmosas e imediatas de distinguir o arquétipo masculino em pixel art sem deformar o rosto é um cavanhaque bem desenhado ou barba por fazer de 2 a 3 pixels.
- **Tórax e Ombros:**
  - *Masculino:* Ombros 2 a 4 pixels mais largos que o quadril, corte reto na linha da clavícula.
  - *Feminino:* Ombros mais suaves, tronco com curva sutil na cintura.

### 3. Teoria de Cores & Shading (Sombreamento Profissional)
- **Hue Shifting (Mudança de Matiz na Sombra/Luz):**
  - Nunca apenas escurecer ou clarear com preto/branco puro.
  - **Luz:** Puxa para tons quentes e amarelados/dourados (aumenta o brilho e saturação média).
  - **Sombras:** Puxa para tons frios (azulados, arroxeados ou marrom avermelhado).
- **Cluster Shading:**
  - Agrupar pixels em blocos contínuos e bem definidos que representam planos de luz e dobras de tecido.
  - Evitar "pixel noise" (pixels isolados sem função de highlight ou antialiasing).
- **Dithering Seletivo (Bayer 2x2 ou Checkerboard):**
  - Usar padrão xadrez (alternância de pixels) apenas em transições de gradientes amplos (como sombras profundas de tecidos ou mantos).
- **Selective Outlining (Sel-out):**
  - O contorno não deve ser preto opaco uniforme.
  - Partes iluminadas recebem contorno com tom escurecido do próprio material (`dk(cor, 0.45)`).
  - Preto profundo (`#1b1020` ou `#0d0714`) apenas no contorno externo de contato com o cenário e dobras profundas.