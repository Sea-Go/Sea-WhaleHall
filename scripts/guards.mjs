#!/usr/bin/env node
// G6 巨型文件 ratchet + C45 唯一正名守护（WhaleHall 版，Node/Bun 通用）。
//
// G6：src/tests 下 ts/tsx 上限 800 行，size_allowlist.json 建档只减不增
//（未登记超限 / 超记录值 / 幽灵条目三种红）。
// C45：src/tests/native 目录名不得以 v[2-9] 后缀结尾，naming_allowlist.json
// 豁免需三要素 {path, reason, converge_event}；wire 格式类型名（SemanticEventV2 等）
// 与运行时标识（timeline-v2.sqlite3 等）不在目录扫描范围。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const LIMIT = 800;
const SCAN_DIRS = ["src", "tests"];
const SKIP = new Set(["node_modules", "dist", "build", "generated", "coverage", "target"]);

const errors = [];

// --- G6 ratchet ---
const sizeAllow = JSON.parse(readFileSync(join(ROOT, "size_allowlist.json"), "utf8"));
const sizeFiles = sizeAllow.files ?? {};
const seen = new Set();
const all = [];
function walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP.has(name)) walk(p);
    } else if (/\.(ts|tsx)$/.test(name)) {
      all.push(p);
    }
  }
}
for (const d of SCAN_DIRS) walk(join(ROOT, d));

for (const p of all) {
  const rel = relative(ROOT, p).split(sep).join("/");
  const lines = readFileSync(p, "utf8").split("\n").length;
  if (rel in sizeFiles) {
    seen.add(rel);
    if (lines > sizeFiles[rel]) {
      errors.push(`[只增不减] ${rel} ${lines} > 记录 ${sizeFiles[rel]}（G6）`);
    }
  } else if (lines > LIMIT) {
    errors.push(`[新增超限] ${rel} ${lines} > ${LIMIT} 且未登记（G6）`);
  }
}
for (const rel of Object.keys(sizeFiles)) {
  if (!seen.has(rel)) errors.push(`[白名单过期] ${rel} 已不存在（G6）`);
}

// --- C45 naming ---
const namingAllow = JSON.parse(readFileSync(join(ROOT, "naming_allowlist.json"), "utf8"));
const namingAllowed = new Set((namingAllow.entries ?? []).map((e) => e.path));
const suffixRe = /v[2-9][0-9]*$/;
for (const base of ["src", "tests", "native"]) {
  if (!existsSync(join(ROOT, base))) continue;
  const stack = [join(ROOT, base)];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (!statSync(p).isDirectory() || SKIP.has(name) || name === ".git") continue;
      const rel = relative(ROOT, p).split(sep).join("/");
      if (suffixRe.test(name) && !namingAllowed.has(rel)) {
        errors.push(`[代次后缀] 目录 ${rel} 违反 C45 唯一正名（豁免需登记 naming_allowlist.json）`);
      }
      stack.push(p);
    }
  }
}
for (const e of namingAllow.entries ?? []) {
  if (!e.path || !e.reason || !e.converge_event) {
    errors.push(`[豁免缺字段] ${e.path ?? "?"} 需含 path/reason/converge_event 三要素（C45）`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`guards ok: ${all.length} ts files, ${Object.keys(sizeFiles).length} grandfathered`);
