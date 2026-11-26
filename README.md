# Aizer Health — Call Center Operations & Jewel

A lightweight, **100% free** call-center knowledge base, Decision Tree, interactive screenshot walkthroughs, and browser-based AI assistant.

- **Portable Local Runtime**: Runs on Windows without admin rights via `portable-start.bat` (and removes cleanly with one click via `portable-uninstall.bat`).
- **Client-Side AI (Free)**: NLI + QA ONNX models (`~236 MB`) download once from Hugging Face into the user's browser and stay cached persistently on their PC.
- **Cloudflare Free Tier**: Static frontend + Pages Functions (`functions/[[path]].js`) + Cloudflare Worker (`src/worker.js`) with D1, Vectorize, and Workers AI (`@cf/baai/bge-small-en-v1.5`).
- **Google (Gmail) Login (Free)**: Uses Google Identity Services (no credit card or paid auth service required).

---

## Step 1: Run Locally (Non-Admin Portable Setup)

1. Double-click **`portable-start.bat`**.
   - Automatically downloads portable Node.js (`v24.22.3` win-x64) into `.portable/node/` and installs dependencies into `node_modules/`.
   - Starts the server on `http://localhost:8000`.
2. To remove everything installed by `portable-start.bat` in one click, double-click **`portable-uninstall.bat`**.

---

## Step 2: Set Up Free Gmail / Google Login (Google Cloud Console)

Google Sign-In is **free** and does **not** require enabling billing or adding a credit card.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and sign in with your Google account.
2. Create a new project (e.g., `Aizer Health KB`).
3. In the left menu, go to **APIs & Services → OAuth consent screen** (or **Google Auth Platform → Overview**):
   - Choose **External** → **Create**.
   - Fill in **App name** (`Aizer Health`), **User support email**, and **Developer contact email**, then save.
   - *(Optional)* Under **Audience / Test users**, if the app is in Testing mode, add the Gmail addresses of your team, or click **Publish App** so any allowed Gmail can sign in.
4. Go to **APIs & Services → Credentials → + Create Credentials → OAuth client ID**:
   - **Application type**: `Web application`
   - **Name**: `Aizer Web`
   - **Authorized JavaScript origins**:
     - `http://localhost:8000`
     - `https://aizerkb.pages.dev` *(add your Cloudflare Pages URL too)*
   - Click **Create** and copy your **Client ID** (`xxxxxxxx.apps.googleusercontent.com`).

---

## Step 3: Configure `.env`

Create or edit `.env` in the project root:

```env
PORT=8000
HOST=127.0.0.1

# Cloudflare Worker backend (for KB & Search)
CF_WORKER_URL=https://aizer-health-kb.aizer-im-kb.workers.dev
WORKER_API_KEY=

# Admin panel & Step Sim Editor passkey
ADMIN_SECRET=choose-a-strong-admin-passkey

# Google (Gmail) Sign-In
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
# Optional: restrict login to specific Gmail addresses (comma-separated). Leave empty to allow any verified Google account.
ALLOWED_EMAILS=
# Optional: secret for signing session cookies (defaults to ADMIN_SECRET if omitted)
SESSION_SECRET=choose-a-random-long-secret
```

Restart the server (`portable-start.bat`) and open `http://localhost:8000` to test signing in with Gmail.

---

## Step 4: Download & Test Browser AI Models (Once per PC)

Nothing downloads automatically when opening the site.

1. Open the **Admin** tab and unlock it with your `ADMIN_SECRET`.
2. In the **Browser AI Models (Hugging Face)** card, click **Download & Test AI Models**.
3. Wait for the progress bar (`~236 MB` total: `Xenova/nli-deberta-v3-small` + `Xenova/distilbert-base-cased-distilled-squad`) to finish and run its automatic NLI + QA self-test.
4. The models are stored in persistent browser cache (`navigator.storage.persist()` + Service Worker), so they stay cached on the PC even if Hugging Face or the server goes offline.

*(Optional diagnostics page: `http://localhost:8000/hf-demo.html` pings Hugging Face to check model sizes and browser WebGPU/WASM support without downloading weights.)*

---

## Step 5: Build Interactive Walkthroughs ("How to Get")

1. Open **Decision Tree** and click any **`?`** button (e.g., **Patient Age**).
2. Click **Build Interactive Sim** (or **Edit Sim**).
3. Upload screenshots via **`+ Add Photo(s)`** or paste directly with **`Ctrl+V`**.
4. Click and drag on each screenshot to mark the target button area (use the mouse wheel to zoom in/out; right-click or `Alt+drag` to pan).
5. Click **Save Sim** (requires `ADMIN_SECRET` if configured).

---

## Step 6: Deploy to Cloudflare Pages (Free)

1. Double-click **`portable-pages-deploy.bat`**.
   - If not logged in, sign in via browser OAuth (`wrangler login`) or paste a Cloudflare API Token.
   - Enter your Pages project name (e.g., `aizerkb`).
2. In **Cloudflare Dashboard → Workers & Pages → `aizerkb` → Settings → Variables and Secrets**, add the same environment variables for both **Production** and **Preview**:
   - `CF_WORKER_URL`
   - `WORKER_API_KEY` *(if your Worker uses one)*
   - `ADMIN_SECRET`
   - `GOOGLE_CLIENT_ID`
   - `ALLOWED_EMAILS` *(optional)*
   - `SESSION_SECRET` *(recommended)*
3. Re-run **`portable-pages-deploy.bat`** once after saving the variables so Cloudflare Pages Functions pick them up.
4. Make sure your `https://<your-project>.pages.dev` URL is added to **Authorized JavaScript origins** in Google Cloud Console (Step 2).
