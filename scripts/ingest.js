import fs from "fs";
import path from "path";

const WORKER_URL = process.env.WORKER_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;

if (!WORKER_URL || !INGEST_SECRET) {
  console.error("Missing WORKER_URL or INGEST_SECRET environment variables.");
  process.exit(1);
}

const DATA_DIR = "./data";
const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json") && f !== "kb_data.json");
const targetFiles = files.length > 0 ? files : ["kb_data.json"];

let allChunks = [];
for (const file of targetFiles) {
  const fullPath = path.join(DATA_DIR, file);
  const items = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  allChunks = allChunks.concat(items);
  console.log(`Loaded ${items.length} chunks from ${file}`);
}

console.log(`Total chunks to ingest: ${allChunks.length}`);

const BATCH_SIZE = 15;
for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
  const batch = allChunks.slice(i, i + BATCH_SIZE);
  const isAppend = i > 0;
  const endpoint = `${WORKER_URL}/ingest?append=${isAppend}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${INGEST_SECRET}`,
    },
    body: JSON.stringify(batch),
  });

  const rawText = await response.text();
  if (!response.ok) {
    console.error(`Batch ${i / BATCH_SIZE + 1} failed (${response.status}):`, rawText.slice(0, 300));
    process.exit(1);
  }

  console.log(`Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allChunks.length / BATCH_SIZE)}:`, JSON.parse(rawText));
}

console.log("All 93 chunks ingested successfully!");