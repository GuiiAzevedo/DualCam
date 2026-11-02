# DualCam

Câmera para Android (PWA) que grava **horizontal** e o **recorte vertical 9:16** ao mesmo tempo.

- Modos: **H + V**, **só H** ou **só V**; ao terminar, escolha quais vídeos salvar
- Arraste o retângulo 9:16 no preview (ou use o ajuste) para reenquadrar, inclusive durante a gravação
- Resolução até 4K, 24/30/60 fps, taxa de bits automática (máxima) ou fixa, escolha da lente
- Foco, brilho/exposição (EV), ISO, obturador, balanço de branco, zoom e lanterna (aparecem conforme o aparelho suportar)
- Áudio estéreo 48 kHz, com opção de áudio cru
- Grava em disco durante a captura (não enche a memória) e mantém a tela ligada

## Publicar no GitHub (uma vez)

1. Crie um repositório (ex.: `dualcam`) e envie estes arquivos na raiz.
2. No repositório: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, pasta `/ (root)`.
3. Aguarde ~1 minuto. O link será `https://SEU-USUARIO.github.io/dualcam/`.

## Instalar no celular

1. Abra o link no **Chrome do Android**.
2. Toque em **Instalar app** (ou menu ⋮ → **Instalar app / Adicionar à tela inicial**).
3. Abra pelo ícone, permita câmera e microfone.

## Observações

- Os vídeos vão para **Downloads** (ou use **Compartilhar** para mandar para Fotos/Drive).
- Se o vídeo travar ou perder quadros em 4K com H + V, use 1080p ou grave só um formato.
- Para atualizar: envie os arquivos novos ao GitHub; o app atualiza na próxima abertura (se precisar, aumente `CACHE` em `sw.js`).
