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
   utils
========================= */

const run = (cmd: string) => {
  console.log(`▶ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

const validateEnvironment = () => {
  const required = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"];
  const missing = required.filter((k) => !process.env[k]);

  if (missing.length) {
    throw new Error(`Missing env: ${missing.join(", ")}`);
  }
};

/* =========================
   config files
========================= */

const setupConfigFile = (examplePath: string, targetPath: string) => {
  if (existsSync(targetPath)) {
    console.log(`✨ ${targetPath} exists`);
    return;
  }

  if (!existsSync(examplePath)) {
    console.log(`⚠️ missing ${examplePath}`);
    return;
  }

  const json = JSON.parse(readFileSync(examplePath, "utf-8"));

  if (PROJECT_NAME !== "moemail") {
    const name = targetPath.split("/").at(-1);

    if (name === "wrangler.json") json.name = PROJECT_NAME;
    if (name === "wrangler.email.json") json.name = `${PROJECT_NAME}-email`;
    if (name === "wrangler.cleanup.json") json.name = `${PROJECT_NAME}-cleanup`;
  }

  if (json.d1_databases?.length) {
    json.d1_databases[0].database_name = DATABASE_NAME;
  }

  writeFileSync(targetPath, JSON.stringify(json, null, 2));
  console.log(`✅ setup ${targetPath}`);
};

const setupWranglerConfigs = () => {
  console.log("🔧 setup wrangler configs");

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
   database
========================= */

const updateDatabaseConfig = (id: string) => {
  console.log(`📝 DB ID: ${id}`);

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
    console.log("✅ DB exists");
  } catch (e) {
    if (e instanceof NotFoundError) {
      const db = await createDatabase();
      updateDatabaseConfig(db.uuid);
      console.log("✅ DB created");
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
   Pages (🔥 FIXED WRANGLER V4)
========================= */

const deployPages = () => {
  console.log("🚧 Deploy Pages (v4)");

  const dir = existsSync(".vercel/output/static")
    ? ".vercel/output/static"
    : "dist";

  // ❌ no --branch anymore
  run(`wrangler pages deploy ${dir} --project-name ${PROJECT_NAME}`);
};

/* =========================
   Workers
========================= */

const deployEmailWorker = () => {
  try {
    run(`wrangler deploy --config wrangler.email.json`);
  } catch {}
};

const deployCleanupWorker = () => {
  try {
    run(`wrangler deploy --config wrangler.cleanup.json`);
  } catch {}
};

/* =========================
   env
========================= */

const setupEnvFile = () => {
  const env = resolve(".env");
  const example = resolve(".env.example");

  if (existsSync(env)) return;

  if (!existsSync(example)) {
    throw new Error(".env.example missing");
  }

  writeFileSync(env, readFileSync(example, "utf-8"));
};

const updateEnvVar = (k: string, v: string) => {
  process.env[k] = v;

  const file = resolve(".env");
  let content = readFileSync(file, "utf-8");

  const r = new RegExp(`^${k}\\s*=\\s*".*?"`, "m");

  if (r.test(content)) {
    content = content.replace(r, `${k} = "${v}"`);
  } else {
    content += `\n${k} = "${v}"`;
  }

  writeFileSync(file, content);
};

/* =========================
   Pages + secrets
========================= */

const checkAndCreatePages = async () => {
  try {
    const pages = await getPages();

    if (!CUSTOM_DOMAIN && pages.subdomain) {
      updateEnvVar(
        "CUSTOM_DOMAIN",
        `https://${pages.subdomain}`
      );
    }
  } catch (e) {
    if (e instanceof NotFoundError) {
      const pages = await createPages();

      if (!CUSTOM_DOMAIN && pages.subdomain) {
        updateEnvVar(
          "CUSTOM_DOMAIN",
          `https://${pages.subdomain}`
        );
      }
    } else {
      throw e;
    }
  }
};

/* =========================
   secrets
========================= */

const pushSecrets = () => {
  if (!existsSync(".env")) setupEnvFile();

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

  run(`wrangler pages secret bulk ${tmp}`);

  execSync(`rm ${tmp}`);
};

/* =========================
   main
========================= */

const main = async () => {
  console.log("🚀 deploy start");

  validateEnvironment();

  setupEnvFile();
  setupWranglerConfigs();

  await checkAndCreateDatabase();
  migrateDatabase();

  await checkAndCreateKVNamespace();
  await checkAndCreatePages();

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
