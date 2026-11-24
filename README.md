# Aizer Health — Call Center Operations & Jewel

## One-Command Run (GitHub Codespaces or Local)

```bash
npm start
```

- Opens on `http://localhost:8000` (port `8000` is auto-forwarded in `.devcontainer/devcontainer.json` with `npm install` run automatically on Codespace creation).
- Uses `@huggingface/transformers` + `onnxruntime-node` on CPU (no Python required).

## Production HTTPS Setup (End-to-End TLS)

1. Bind Node locally and trust the reverse proxy:
   ```bash
   HOST=127.0.0.1 TRUST_PROXY=true WORKER_API_KEY=<secret> npm start
   ```
2. Put **Caddy** (using the included `Caddyfile`) or **Cloudflare Tunnel** (`cloudflared tunnel --url http://127.0.0.1:8000`) in front of it for automatic TLS 1.3 + HSTS.
