// schemasweep.config.ts
export interface SchemaSweepConfig {
  projectRoot: string;
  graphqlEndpoint: string;
  graphqlHeaders?: Record<string, string>;
  queryGlobs: string[];
}

const config: SchemaSweepConfig = {
  // Root of the project you want to scan
  projectRoot: "/external",

  // GraphQL endpoint
  graphqlEndpoint:
    process.env.GRAPHQL_ENDPOINT || "http://localhost:3000/graphql",

  // Add auth headers if needed
  graphqlHeaders: {
    // Authorization: "Bearer XXX"
  },

  // Where your query *strings* live
  queryGlobs: ["**/*.{ts,js,tsx,jsx,svelte,astro}"],
};

export default config;
