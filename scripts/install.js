#!/usr/bin/env node
/**
 * dsh-deepseek-billing 一键安装器。
 *
 * 用法（在 dsh-deepseek-billing 目录内）：
 *   node scripts/install.js --from . --force
 *
 * 做两件事：
 *   1. 把插件复制到 $DSH_HOME/profiles/node_modules/dsh-deepseek-billing；
 *   2. 在 $DSH_HOME/profiles/web/cordis.patch.yml 追加加载条目（已存在则跳过）。
 *
 * $DSH_HOME 未设置时按 DSH 默认的 ~/.dsh 处理。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const force = args.includes("--force");
const fromIndex = args.indexOf("--from");
const sourceDir = resolve(
  fromIndex !== -1 && args[fromIndex + 1]
    ? args[fromIndex + 1]
    : fileURLToPath(new URL("../", import.meta.url))
);
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const targetDir = join(dshHome, "profiles", "node_modules", "dsh-deepseek-billing");
const patchPath = join(dshHome, "profiles", "web", "cordis.patch.yml");

// 源目录必须是一个合法的 dsh-deepseek-billing 包，防止拿错目录乱装。
try {
  const pkg = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8"));
  if (pkg.name !== "dsh-deepseek-billing") throw new Error(`package.json name 是 "${pkg.name}"`);
} catch (error) {
  console.error(`[dsh-deepseek-billing] 源目录不像 dsh-deepseek-billing 插件（${sourceDir}）：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// 目标目录已存在时：--force 才覆盖，且只肯删"看起来就是 dsh-deepseek-billing"的目录。
if (existsSync(targetDir)) {
  if (!force) {
    console.error(`[dsh-deepseek-billing] 已安装：${targetDir}\n[dsh-deepseek-billing] 重新安装请加 --force`);
    process.exit(1);
  }
  let existingName = "";
  try {
    existingName = JSON.parse(readFileSync(join(targetDir, "package.json"), "utf8")).name ?? "";
  } catch {}
  if (existingName !== "dsh-deepseek-billing") {
    console.error(`[dsh-deepseek-billing] 目标已存在且不像 dsh-deepseek-billing（name=${existingName || "未知"}），拒绝覆盖：${targetDir}`);
    process.exit(1);
  }
  rmSync(targetDir, { recursive: true, force: true });
}

mkdirSync(join(dshHome, "profiles", "node_modules"), { recursive: true });
cpSync(sourceDir, targetDir, {
  recursive: true,
  filter: (src) => {
    const base = src.split(/[\\/]/).pop() ?? "";
    if (base === ".git" || base === "node_modules") return false;
    if (base.endsWith(".bak") || base.includes(".bak-old") || base.endsWith(".bak-live")) return false;
    if (base.endsWith(".tmp")) return false;
    return true;
  }
});
console.log(`[dsh-deepseek-billing] 已复制到 ${targetDir}`);

// cordis.patch.yml：已有 dsh-deepseek-billing 条目则跳过，否则在文件末尾追加一个顶层块。
mkdirSync(join(dshHome, "profiles", "web"), { recursive: true });
let patch = "";
if (existsSync(patchPath)) patch = readFileSync(patchPath, "utf8");
if (patch.includes("dsh-deepseek-billing")) {
  console.log("[dsh-deepseek-billing] cordis.patch.yml 已有加载条目，跳过");
} else {
  if (patch.length > 0 && !patch.endsWith("\n")) patch += "\n";
  writeFileSync(patchPath, `${patch}\n- insert:\n    - id: dsh-deepseek-billing\n      name: dsh-deepseek-billing\n`, "utf8");
  console.log(`[dsh-deepseek-billing] 已在 ${patchPath} 追加加载条目`);
}

console.log("[dsh-deepseek-billing] 安装完成。重启 DSH Web（dsh web）并刷新页面即可生效。");
