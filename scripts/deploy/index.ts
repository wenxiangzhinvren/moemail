import { NotFoundError } from "cloudflare";
import "dotenv/config";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createDatabase,
  createKVNamespace,
  getDatabase,
  getKVNamespaceList,
  createPages,
} from "./cloudflare";

/* =========================
   ENV
========================= */

const PROJECT_NAME = process.env.PROJECT_NAME || "moemail";
const DATABASE_NAME = process.env.DATABASE_NAME || "moemail-db";
const KV_NAMESPACE_NAME = process.env.KV_NAMESPACE_NAME || "moemail-kv";
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN;

/* =========================
   RUNNER
========================= */

const run = (cmd: string) => {
  console.log(`▶ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

const must = (v: unknown, msg: string): string => {
  if (typeof v !== "string" || !v) {
    throw new Error(msg);
  }
  return v;
};

/* =========================
   BUILD（关键修复点）
========================= */

const build = () => {
  console.log("🏗 build start");
  run("pnpm run build");

  const dist = resolve("dist");

  if (!existsSync(dist)) {
    throw new Error("❌ build failed: dist not found");
  }
};

/* =========================
   WRANGLER CONFIG
========================= */

const setupWrangler = () => {
  const files = [
    ["wrangler.example.json", "wrangler.json"],
    ["wrangler.email.example.json", "wrangler.email.json"],
    ["wrangler.cleanup.example.json", "wrangler.cleanup.json"],
  ];

  for (const [a, b] of files) {
    if (!existsSync(b)) {
      if (existsSync(a)) {
        writeFileSync(b, readFileSync(a, "utf-8"));
      }
    }
  }
};

/* =========================
   DATABASE
========================= */

const updateDB = (id: string) => {
  ["wrangler.json", "wrangler.email.json", "wrangler.cleanup.json"].forEach(
    (f) => {
      if (!existsSync(f)) return;
      const json = JSON.parse(readFileSync(f, "utf-8"));
      if (json.d1_databases?.length) {
        json.d1_databases[0].database_id = id;
      }
      writeFileSync(f, JSON.stringify(json, null, 2));
    }
  );
};

const dbSetup = async () => {
  console.log("🔍 DB check...");

  try {
    const db = await getDatabase();
    const id = must(db?.uuid, "db uuid missing");
    updateDB(id);
  } catch (e) {
    if (e instanceof NotFoundError) {
      const db = await createDatabase();
      const id = must(db?.uuid, "db create failed");
      updateDB(id);
    } else throw e;
  }
};

const migrate = () => run("pnpm run db:migrate-remote");

/* =========================
   KV
========================= */

const kvSetup = async () => {
  console.log("🔍 KV check...");

  const list = await getKVNamespaceList();
  const found = list.find((x) => x.title === KV_NAMESPACE_NAME);

  if (found?.id) {
    updateKV(found.id);
  } else {
    const ns = await createKVNamespace();
    updateKV(ns.id);
  }
};

const updateKV = (id: string) => {
  const file = "wrangler.json";
  if (!existsSync(file)) return;

  const json = JSON.parse(readFileSync(file, "utf-8"));
  if (json.kv_namespaces?.length) {
    json.kv_namespaces[0].id = id;
  }
  writeFileSync(file, JSON.stringify(json, null, 2));
};

/* =========================
   DEPLOY
========================= */

const deployPages = () => {
  if (!existsSync("dist")) {
    throw new Error("❌ dist missing (build required)");
  }

  run(
    `pnpm dlx wrangler pages deploy dist --project-name ${PROJECT_NAME}`
  );
};

const deployWorkerSafe = (cmd: string, name: string) => {
  try {
    run(cmd);
  } catch (e) {
    console.warn(`⚠️ ${name} failed but ignored`);
  }
};

/* =========================
   MAIN
========================= */

const main = async () => {
  try {
    console.log("🚀 deploy start");

    setupWrangler();

    await dbSetup();
    migrate();

    await kvSetup();

    build(); // ✅ 最关键

    deployPages();

    deployWorkerSafe(
      "pnpm dlx wrangler deploy --config wrangler.email.json",
      "email worker"
    );

    deployWorkerSafe(
      "pnpm dlx wrangler deploy --config wrangler.cleanup.json",
      "cleanup worker"
    );

    console.log("🎉 deploy success");
  } catch (e) {
    console.error("❌ deploy failed:", e);
    process.exit(1);
  }
};

main();
