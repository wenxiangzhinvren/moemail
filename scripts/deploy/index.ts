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

const PROJECT_NAME = process.env.PROJECT_NAME || "moemail";
const DATABASE_NAME = process.env.DATABASE_NAME || "moemail-db";
const KV_NAMESPACE_NAME = process.env.KV_NAMESPACE_NAME || "moemail-kv";
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN;
const KV_NAMESPACE_ID = process.env.KV_NAMESPACE_ID;

/* =========================
   runner
========================= */

const run = (cmd: string) => {
  console.log(`▶ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

/* =========================
   env
========================= */

const validateEnvironment = () => {
  const required = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"];
  const missing = required.filter((k) => !process.env[k]);

  if (missing.length) {
    throw new Error(`Missing env: ${missing.join(", ")}`);
  }
};

/* =========================
   wrangler config
========================= */

const setupConfigFile = (example: string, target: string) => {
  if (existsSync(target)) return;
  if (!existsSync(example)) return;

  const json = JSON.parse(readFileSync(example, "utf-8"));

  if (PROJECT_NAME !== "moemail") {
    const f = target.split("/").at(-1);
    if (f === "wrangler.json") json.name = PROJECT_NAME;
    if (f === "wrangler.email.json") json.name = `${PROJECT_NAME}-email`;
    if (f === "wrangler.cleanup.json") json.name = `${PROJECT_NAME}-cleanup`;
  }

  if (json.d1_databases?.length) {
    json.d1_databases[0].database_name = DATABASE_NAME;
  }

  writeFileSync(target, JSON.stringify(json, null, 2));
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
   DB
========================= */

const updateDatabaseConfig = (id: string) => {
  ["wrangler.json", "wrangler.email.json", "wrangler.cleanup.json"].forEach(
    (file) => {
      if (!existsSync(file)) return;

      const json = JSON.parse(readFileSync(file, "utf-8"));
      if (json.d1_databases?.length) {
        json.d1_databases[0].database_id = id;
      }
      writeFileSync(file, JSON.stringify(json, null, 2));
    }
  );
};

const checkAndCreateDatabase = async () => {
  try {
    const db = await getDatabase();
    updateDatabaseConfig(db.uuid);
  } catch (e) {
    if (e instanceof NotFoundError) {
      const db = await createDatabase();
      updateDatabaseConfig(db.uuid);
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
   Pages deploy (SAFE)
========================= */

const deployPages = () => {
  const dir = existsSync(".vercel/output/static")
    ? ".vercel/output/static"
    : "dist";

  run(
    `pnpm dlx wrangler pages deploy ${dir} --project-name ${PROJECT_NAME}`
  );
};

/* =========================
   Workers
========================= */

const deployEmailWorker = () => {
  try {
    run(`pnpm dlx wrangler deploy --config wrangler.email.json`);
  } catch {}
};

const deployCleanupWorker = () => {
  try {
    run(`pnpm dlx wrangler deploy --config wrangler.cleanup.json`);
  } catch {}
};

/* =========================
   secrets
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

  const env = readFileSync(".env", "utf-8");

  const secrets: Record<string, string> = {};

  env.split("\n").forEach((line) => {
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

  execSync(`rm ${tmp}`);
};

/* =========================
   main
========================= */

const main = async () => {
  console.log("🚀 deploy start");

  validateEnvironment();

  setupWranglerConfigs();

  await checkAndCreateDatabase();
  migrateDatabase();

  await checkAndCreateKVNamespace();

  // ⚠️ 已移除 checkAndCreatePages（避免 undefined crash）

  pushSecrets();

  deployPages();
  deployEmailWorker();
  deployCleanupWorker();

  console.log("🎉 done");
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
