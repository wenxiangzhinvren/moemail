import { NotFoundError } from "cloudflare";
import "dotenv/config";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createDatabase,
  createKVNamespace,
  createPages,
  getDatabase,
  getKVNamespaceList,
  getPages,
} from "./cloudflare";

/* =========================
   ENV
========================= */

const PROJECT_NAME = process.env.PROJECT_NAME || "moemail";
const DATABASE_NAME = process.env.DATABASE_NAME || "moemail-db";
const KV_NAMESPACE_NAME = process.env.KV_NAMESPACE_NAME || "moemail-kv";
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN;
const KV_NAMESPACE_ID = process.env.KV_NAMESPACE_ID;

/* =========================
   SAFE RUNNER
========================= */

const run = (cmd: string) => {
  console.log(`▶ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

/* =========================
   SAFE VALUE CHECK
========================= */

const mustString = (val: unknown, name: string): string => {
  if (typeof val !== "string" || !val) {
    throw new Error(`❌ Invalid ${name}: ${val}`);
  }
  return val;
};

/* =========================
   WRANGLER CONFIG
========================= */

const setupConfigFile = (examplePath: string, targetPath: string) => {
  if (existsSync(targetPath)) return;
  if (!existsSync(examplePath)) return;

  const json = JSON.parse(readFileSync(examplePath, "utf-8"));

  if (PROJECT_NAME !== "moemail") {
    const file = targetPath.split("/").at(-1);

    if (file === "wrangler.json") json.name = PROJECT_NAME;
    if (file === "wrangler.email.json") json.name = `${PROJECT_NAME}-email`;
    if (file === "wrangler.cleanup.json") json.name = `${PROJECT_NAME}-cleanup`;
  }

  if (json.d1_databases?.length) {
    json.d1_databases[0].database_name = DATABASE_NAME;
  }

  writeFileSync(targetPath, JSON.stringify(json, null, 2));
};

const setupWranglerConfigs = () => {
  const list = [
    ["wrangler.example.json", "wrangler.json"],
    ["wrangler.email.example.json", "wrangler.email.json"],
    ["wrangler.cleanup.example.json", "wrangler.cleanup.json"],
  ];

  for (const [a, b] of list) {
    setupConfigFile(resolve(a), resolve(b));
  }
};

/* =========================
   DATABASE
========================= */

const updateDatabaseConfig = (dbId: string) => {
  ["wrangler.json", "wrangler.email.json", "wrangler.cleanup.json"].forEach(
    (file) => {
      if (!existsSync(file)) return;

      const json = JSON.parse(readFileSync(file, "utf-8"));

      if (json.d1_databases?.length) {
        json.d1_databases[0].database_id = dbId;
      }

      writeFileSync(file, JSON.stringify(json, null, 2));
    }
  );
};

const checkAndCreateDatabase = async () => {
  console.log("🔍 Checking database...");

  try {
    const db = await getDatabase();
    const id = mustString(db?.uuid, "database uuid");

    updateDatabaseConfig(id);
    console.log("✅ Database exists:", id);
  } catch (e) {
    if (e instanceof NotFoundError) {
      console.log("⚠️ Database not found, creating...");

      const db = await createDatabase();
      const id = mustString(db?.uuid, "created database uuid");

      updateDatabaseConfig(id);
      console.log("✅ Database created:", id);
    } else {
      throw e;
    }
  }
};

const migrateDatabase = () => {
  run("pnpm run db:migrate-remote");
};

/* =========================
   KV
========================= */

const updateKVConfig = (id: string) => {
  const file = resolve("wrangler.json");
  if (!existsSync(file)) return;

  const json = JSON.parse(readFileSync(file, "utf-8"));

  if (json.kv_namespaces?.length) {
    json.kv_namespaces[0].id = id;
  }

  writeFileSync(file, JSON.stringify(json, null, 2));
};

const checkAndCreateKVNamespace = async () => {
  console.log("🔍 Checking KV namespace...");

  if (KV_NAMESPACE_ID) {
    updateKVConfig(KV_NAMESPACE_ID);
    return;
  }

  const list = await getKVNamespaceList();
  const found = list.find((x) => x.title === KV_NAMESPACE_NAME);

  if (found?.id) {
    updateKVConfig(found.id);
  } else {
    const ns = await createKVNamespace();
    updateKVConfig(ns.id);
  }
};

/* =========================
   PAGES
========================= */

const deployPages = () => {
  const dist = resolve("dist");

  if (!existsSync(dist)) {
    throw new Error("❌ dist not found. Did you forget `pnpm run build`?");
  }

  run(
    `pnpm dlx wrangler pages deploy dist --project-name ${PROJECT_NAME}`
  );
};

/* =========================
   WORKERS
========================= */

const deployEmailWorker = () => {
  try {
    run(`pnpm dlx wrangler deploy --config wrangler.email.json`);
  } catch (e) {
    console.warn("⚠️ Email worker deploy failed (ignored)");
  }
};

const deployCleanupWorker = () => {
  try {
    run(`pnpm dlx wrangler deploy --config wrangler.cleanup.json`);
  } catch (e) {
    console.warn("⚠️ Cleanup worker deploy failed (ignored)");
  }
};

/* =========================
   SECRETS
========================= */

const pushSecrets = () => {
  if (!existsSync(".env")) return;

  const runtime = [
    "AUTH_GITHUB_ID",
    "AUTH_GITHUB_SECRET",
    "AUTH_GOOGLE_ID",
    "AUTH_GOOGLE_SECRET",
    "AUTH_SECRET",
  ];

  const content = readFileSync(".env", "utf-8");

  const secrets: Record<string, string> = {};

  content.split("\n").forEach((line) => {
    const [k, v] = line.split("=");
    if (!k || !v) return;

    const key = k.trim();
    const value = v.replace(/["']/g, "").trim();

    if (runtime.includes(key) && value) {
      secrets[key] = value;
    }
  });

  const tmp = resolve(".env.runtime.json");
  writeFileSync(tmp, JSON.stringify(secrets, null, 2));

  run(`pnpm dlx wrangler pages secret bulk ${tmp}`);

  execSync(`rm -f ${tmp}`);
};

/* =========================
   MAIN
========================= */

const main = async () => {
  try {
    console.log("🚀 deploy start");

    setupWranglerConfigs();

    await checkAndCreateDatabase();
    migrateDatabase();

    await checkAndCreateKVNamespace();

    pushSecrets();

    deployPages();
    deployEmailWorker();
    deployCleanupWorker();

    console.log("🎉 deploy success");
  } catch (e) {
    console.error("❌ deploy failed:", e);
    process.exit(1);
  }
};

main();
