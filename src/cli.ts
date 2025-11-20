#!/usr/bin/env bun
// src/cli.ts

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { globby } from "globby";
import {
  buildClientSchema,
  getIntrospectionQuery,
  GraphQLSchema,
  IntrospectionQuery,
  isObjectType,
  visit,
  TypeInfo,
  visitWithTypeInfo,
  parse,
} from "graphql";
import type { SchemaSweepConfig } from "../schemasweep.config";

// ---------- Types ----------

type FieldUsageLocation = {
  filePath: string;
  line: number;
};

type UsageMap = {
  [typeName: string]: {
    [fieldName: string]: FieldUsageLocation[];
  };
};

type Report = {
  generatedAt: string;
  graphqlEndpoint: string;
  types: {
    [typeName: string]: {
      fields: string[];
      fieldUsages: {
        [fieldName: string]: {
          used: boolean;
          locations: FieldUsageLocation[];
        };
      };
    };
  };
};

// ---------- Config loading ----------

async function loadConfig(): Promise<SchemaSweepConfig> {
  const cwd = process.cwd();
  const configPath = path.resolve(cwd, "schemasweep.config.ts");

  if (!fs.existsSync(configPath)) {
    console.error("Could not find schemasweep.config.ts in", cwd);
    process.exit(1);
  }

  const moduleUrl = pathToFileURL(configPath).href;
  const mod = await import(moduleUrl);
  const config = (mod.default || mod) as SchemaSweepConfig;
  const normalizedProjectRoot = resolveProjectRoot(
    path.dirname(configPath),
    config.projectRoot
  );

  return {
    ...config,
    projectRoot: normalizedProjectRoot,
  };
}

function resolveProjectRoot(configDir: string, projectRoot: string): string {
  if (path.isAbsolute(projectRoot)) {
    if (fs.existsSync(projectRoot)) {
      return projectRoot;
    }

    const segments = projectRoot.split("/").filter(Boolean);
    if (segments.length === 1) {
      return path.resolve(configDir, projectRoot.slice(1));
    }

    const localFallback = path.resolve(configDir, projectRoot.slice(1));
    if (fs.existsSync(localFallback)) {
      return localFallback;
    }

    // Unknown absolute path – leave as-is so the caller can fix it.
    return projectRoot;
  }

  return path.resolve(configDir, projectRoot);
}

// ---------- GraphQL schema introspection ----------

async function fetchSchema(
  endpoint: string,
  headers: Record<string, string> = {}
): Promise<GraphQLSchema> {
  const introspectionQuery = getIntrospectionQuery();

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify({ query: introspectionQuery }),
  });

  if (!res.ok) {
    throw new Error(
      `Failed introspection ${res.status} ${
        res.statusText
      }: ${await res.text()}`
    );
  }

  const json = (await res.json()) as {
    data?: IntrospectionQuery;
    errors?: any;
  };

  if (!json.data) {
    console.error("Introspection errors:", json.errors);
    throw new Error("No data returned from introspection query");
  }

  return buildClientSchema(json.data);
}

// ---------- File scanning & GraphQL string plucking ----------

// Naive: find *all* backtick strings and keep ones containing `query ` / `mutation ` / `fragment `
function pluckGraphqlStrings(
  code: string
): { source: string; index: number }[] {
  const results: { source: string; index: number }[] = [];
  const regex = /`([\s\S]*?)`/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(code))) {
    const content = match[1];
    const idx = match.index ?? 0;
    const trimmed = content.trim();

    if (
      trimmed.includes("query ") ||
      trimmed.includes("mutation ") ||
      trimmed.includes("fragment ")
    ) {
      results.push({ source: trimmed, index: idx });
    }
  }

  return results;
}

function indexToLine(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

// ---------- Usage recording ----------

function buildTypeFieldMap(schema: GraphQLSchema): {
  [typeName: string]: { fields: string[] };
} {
  const typeMap = schema.getTypeMap();
  const result: { [typeName: string]: { fields: string[] } } = {};

  for (const [name, type] of Object.entries(typeMap)) {
    // Skip introspection types etc.
    if (name.startsWith("__")) continue;
    if (!isObjectType(type)) continue;

    const fields = Object.keys(type.getFields());
    result[name] = { fields };
  }

  return result;
}

async function buildUsageMap(
  schema: GraphQLSchema,
  files: string[]
): Promise<UsageMap> {
  const usageMap: UsageMap = {};
  const typeInfo = new TypeInfo(schema);

  for (const filePath of files) {
    const code = await fs.promises.readFile(filePath, "utf8");
    const snippets = pluckGraphqlStrings(code);

    if (snippets.length === 0) continue;

    for (const { source, index } of snippets) {
      let ast;
      try {
        ast = parse(source);
      } catch (err) {
        console.warn(`Failed to parse GraphQL in ${filePath}:`, err);
        continue;
      }

      const startLine = indexToLine(code, index);

      visit(
        ast,
        visitWithTypeInfo(typeInfo, {
          Field(node) {
            const fieldName = node.name.value;
            const parentType = typeInfo.getParentType();
            const parentName = parentType?.name;
            if (!parentName) return;

            if (!usageMap[parentName]) {
              usageMap[parentName] = {};
            }
            if (!usageMap[parentName][fieldName]) {
              usageMap[parentName][fieldName] = [];
            }

            const loc: FieldUsageLocation = {
              filePath,
              line: startLine, // rough – good enough for v0.1
            };

            usageMap[parentName][fieldName].push(loc);
          },
        })
      );
    }
  }

  return usageMap;
}

// ---------- Report building & writing ----------

async function writeReport(
  config: SchemaSweepConfig,
  schema: GraphQLSchema,
  usageMap: UsageMap
) {
  const typeFieldMap = buildTypeFieldMap(schema);

  const report: Report = {
    generatedAt: new Date().toISOString(),
    graphqlEndpoint: config.graphqlEndpoint,
    types: {},
  };

  for (const [typeName, { fields }] of Object.entries(typeFieldMap)) {
    const fieldUsages: Report["types"][string]["fieldUsages"] = {};

    for (const fieldName of fields) {
      const locations = usageMap[typeName]?.[fieldName] ?? [];
      fieldUsages[fieldName] = {
        used: locations.length > 0,
        locations,
      };
    }

    report.types[typeName] = {
      fields,
      fieldUsages,
    };
  }

  const outputRoot = process.cwd();
  const reportsDir = path.join(outputRoot, "reports");
  await fs.promises.mkdir(reportsDir, { recursive: true });

  const outputPath = path.join(reportsDir, "schemasweep-report.json");
  await fs.promises.writeFile(outputPath, JSON.stringify(report, null, 2), {
    encoding: "utf8",
  });

  // Small console summary
  let unusedCount = 0;
  for (const type of Object.values(report.types)) {
    for (const field of Object.values(type.fieldUsages)) {
      if (!field.used) unusedCount++;
    }
  }

  console.log(`✅ Report written to ${outputPath}`);
  console.log(`🔎 Total types: ${Object.keys(report.types).length}`);
  console.log(`🧹 Unused fields (all types): ${unusedCount}`);
}

// ---------- Main ----------

async function main() {
  console.log("🧹 SchemaSweep v0.1 – scanning…");

  const config = await loadConfig();

  console.log("📡 Fetching GraphQL schema from", config.graphqlEndpoint);
  const schema = await fetchSchema(
    config.graphqlEndpoint,
    config.graphqlHeaders ?? {}
  );

  const { projectRoot, queryGlobs } = config;
  const globPatterns = queryGlobs.map((g) => path.join(projectRoot, g));

  console.log("📁 Scanning files:");
  globPatterns.forEach((p) => console.log("  -", p));

  const files = await globby(globPatterns);
  console.log(`📄 Found ${files.length} files to inspect`);

  const usageMap = await buildUsageMap(schema, files);

  await writeReport(config, schema, usageMap);

  console.log("✨ Done.");
}

main().catch((err) => {
  console.error("❌ Unexpected error:", err);
  process.exit(1);
});
