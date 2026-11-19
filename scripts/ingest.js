import fs from "fs";

const WORKER_URL = process.env.WORKER_URL; // e.g. https://aizer-health-kb.your-subdomain.workers.dev
const INGEST_SECRET = process.env.INGEST_SECRET;

if (!WORKER_URL || !INGEST_SECRET) {
  console.error("Missing WORKER_URL or INGEST_SECRET environment variables.");
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync("./data/kb_data.json", "utf8"));

const response = await fetch(`${WORKER_URL}/ingest`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${INGEST_SECRET}`,
  },
  body: JSON.stringify(data),
});

const result = await response.json();
console.log("Ingest Result:", result);