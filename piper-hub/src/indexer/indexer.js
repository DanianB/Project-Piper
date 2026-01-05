// src/indexer/indexer.js
import fs from "fs";
import path from "path";
import { parse as babelParse } from "@babel/parser";
import traverseModule from "@babel/traverse";
const traverse = traverseModule.default || traverseModule;
import { parseDocument } from "htmlparser2";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";
import Fuse from "fuse.js";

function isIgnoredDir(name) {
  return (
    name === "node_modules" ||
    name === ".git" ||
    name === "data" ||
    name === "dist" ||
    name === "build"
  );
}
function isIndexableFile(p) {
  return (
    p.endsWith(".js") ||
    p.endsWith(".mjs") ||
    p.endsWith(".cjs") ||
    p.endsWith(".html") ||
    p.endsWith(".css")
  );
}
function walkFiles(rootAbs) {
  const out = [];
  const stack = [rootAbs];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!isIgnoredDir(e.name)) stack.push(full);
      } else if (e.isFile()) {
        if (isIndexableFile(full)) out.push(full);
      }
    }
  }
  return out;
}
function relPath(rootAbs, abs) {
  return path.relative(rootAbs, abs).replaceAll("\\", "/");
}
function readUtf8(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

// CSS specificity: [ids, classes/attrs/pseudos, tags/pseudo-elements]
function computeSpecificity(selector) {
  let a = 0,
    b = 0,
    c = 0;
  try {
    const ast = selectorParser().astSync(selector);
    ast.walk((node) => {
      if (node.type === "id") a += 1;
      else if (node.type === "class" || node.type === "attribute") b += 1;
      else if (node.type === "pseudo") {
        // treat pseudo-elements as tag-level
        if (node.value?.startsWith("::")) c += 1;
        else b += 1;
      } else if (node.type === "tag") c += 1;
    });
  } catch {}
  return [a, b, c];
}

function extractHtml(file, source) {
  const doc = parseDocument(source, { lowerCaseTags: true });
  const elements = [];

  function visit(node) {
    if (!node) return;
    if (node.type === "tag") {
      const tag = node.name || "";
      const attribs = node.attribs || {};
      const id = attribs.id || null;
      const classes = attribs.class
        ? String(attribs.class).split(/\s+/).filter(Boolean)
        : [];

      let text = null;
      if (tag === "button" && Array.isArray(node.children)) {
        const t = node.children
          .filter((c) => c.type === "text")
          .map((c) => (c.data || "").trim())
          .filter(Boolean)
          .join(" ")
          .trim();
        if (t) text = t;
      }

      elements.push({ file, tag, id, classes, text });
    }
    if (Array.isArray(node.children)) for (const ch of node.children) visit(ch);
  }

  for (const ch of doc.children || []) visit(ch);
  return { elements };
}

function extractCss(file, source) {
  const selectors = [];
  let root;
  try {
    root = postcss.parse(source, { from: undefined });
  } catch {
    return { selectors };
  }

  root.walkRules((rule) => {
    const selText = (rule.selector || "").trim();
    if (!selText) return;

    const props = new Set();
    rule.walkDecls((d) => props.add(d.prop));

    const list = selText
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of list) {
      selectors.push({
        file,
        selector: s,
        specificity: computeSpecificity(s),
        properties: Array.from(props),
      });
    }
  });

  return { selectors };
}

function extractJs(file, source) {
  const exports = [];
  const routes = [];
  const imports = [];

  let ast;
  try {
    ast = babelParse(source, {
      sourceType: "module",
      plugins: [
        "jsx",
        "classProperties",
        "dynamicImport",
        "importMeta",
        "topLevelAwait",
      ],
      errorRecovery: true,
    });
  } catch {
    return { exports, routes, imports };
  }

  traverse(ast, {
    ImportDeclaration(p) {
      imports.push({
        file,
        source: p.node.source?.value || "",
        loc: p.node.loc || null,
      });
    },
    ExportNamedDeclaration(p) {
      const d = p.node.declaration;
      if (d?.type === "FunctionDeclaration" && d.id?.name) {
        exports.push({
          file,
          name: d.id.name,
          kind: "function",
          loc: p.node.loc || null,
        });
      } else if (d?.type === "VariableDeclaration") {
        for (const decl of d.declarations || []) {
          if (decl.id?.type === "Identifier") {
            exports.push({
              file,
              name: decl.id.name,
              kind: "variable",
              loc: p.node.loc || null,
            });
          }
        }
      }
    },
    ExportDefaultDeclaration(p) {
      exports.push({
        file,
        name: "default",
        kind: "default",
        loc: p.node.loc || null,
      });
    },
    CallExpression(p) {
      // Express routes: app.post("/x"...), r.get("/y"...)
      const callee = p.node.callee;
      if (
        callee?.type === "MemberExpression" &&
        callee.object?.type === "Identifier" &&
        callee.property?.type === "Identifier"
      ) {
        const obj = callee.object.name;
        const method = callee.property.name;
        if (["get", "post", "put", "delete", "patch"].includes(method)) {
          const arg0 = p.node.arguments?.[0];
          if (
            arg0?.type === "StringLiteral" &&
            typeof arg0.value === "string" &&
            arg0.value.startsWith("/")
          ) {
            routes.push({
              file,
              object: obj,
              method: method.toUpperCase(),
              path: arg0.value,
              loc: p.node.loc || null,
            });
          }
        }
      }
    },
  });

  return { exports, routes, imports };
}

export function buildCodebaseIndex({ rootDir, outFile = "data/index.json" }) {
  if (!rootDir) throw new Error("buildCodebaseIndex: rootDir is required");
  const rootAbs = path.resolve(rootDir);
  const filesAbs = walkFiles(rootAbs);

  const idx = {
    version: 1,
    generatedAt: new Date().toISOString(),
    root: rootAbs,
    html: { elements: [] },
    css: { selectors: [] },
    js: { exports: [], routes: [], imports: [] },
  };

  for (const abs of filesAbs) {
    const rel = relPath(rootAbs, abs);
    const src = readUtf8(abs);
    if (src == null) continue;

    if (rel.endsWith(".html")) {
      const h = extractHtml(rel, src);
      idx.html.elements.push(...h.elements);
    } else if (rel.endsWith(".css")) {
      const c = extractCss(rel, src);
      idx.css.selectors.push(...c.selectors);
    } else if (
      rel.endsWith(".js") ||
      rel.endsWith(".mjs") ||
      rel.endsWith(".cjs")
    ) {
      const j = extractJs(rel, src);
      idx.js.exports.push(...j.exports);
      idx.js.routes.push(...j.routes);
      idx.js.imports.push(...j.imports);
    }
  }

  const outAbs = path.resolve(rootAbs, outFile);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(idx, null, 2), "utf8");

  return {
    ok: true,
    outFile: outAbs,
    counts: {
      htmlElements: idx.html.elements.length,
      cssSelectors: idx.css.selectors.length,
      jsExports: idx.js.exports.length,
      jsRoutes: idx.js.routes.length,
      jsImports: idx.js.imports.length,
    },
  };
}

export function loadIndex(rootDir, file = "data/index.json") {
  const p = path.resolve(path.resolve(rootDir), file);
  const t = readUtf8(p);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export function makeIndexQuery(index) {
  const fuseButtons = new Fuse(
    (index?.html?.elements || []).filter((e) => e.tag === "button"),
    { keys: ["text", "id", "classes"], threshold: 0.35 }
  );

  const fuseSelectors = new Fuse(index?.css?.selectors || [], {
    keys: ["selector", "properties"],
    threshold: 0.35,
  });

  return {
    findButtonLike(q, limit = 5) {
      return fuseButtons
        .search(q)
        .slice(0, limit)
        .map((r) => r.item);
    },
    selectorsForClass(className) {
      const needle = "." + className;
      return (index?.css?.selectors || []).filter((s) =>
        s.selector.includes(needle)
      );
    },
    selectorsForId(id) {
      const needle = "#" + id;
      return (index?.css?.selectors || []).filter((s) =>
        s.selector.includes(needle)
      );
    },
    findSelectorsLike(q, limit = 10) {
      return fuseSelectors
        .search(q)
        .slice(0, limit)
        .map((r) => r.item);
    },
  };
}
