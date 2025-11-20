# SchemaSweep Proof of Concept

Guidance for cloning and running this GraphQL schema usage analyzer on a fresh machine with the GitHub CLI.

## Prerequisites

- [GitHub CLI](https://cli.github.com/) installed and authenticated (`gh auth login`).
- [Bun](https://bun.sh/) installed; the CLI is executed with `bun`.
- Network access to the target GraphQL endpoint.

## Clone the repository

```bash
# Replace <owner> with the GitHub org or username that hosts this repo
gh repo clone <owner>/schema-sweep
cd schema-sweep
```

## Install dependencies

```bash
bun install
```

## Configure SchemaSweep

1. Open `schemasweep.config.ts`.
2. Set `projectRoot` to the absolute path of the project you want to scan on the new machine.
3. Update `graphqlEndpoint` and `graphqlHeaders` (if authentication is required) to reach the target API.
4. Adjust `queryGlobs` so they point at the files that contain GraphQL template literals in that project.

## Run the CLI

```bash
bun src/cli.ts
```

Or via the packaged script:

```bash
bun run run
```

The tool will fetch the schema via introspection, scan the files that match `queryGlobs`, and write `schemasweep-report.json` into `projectRoot`.

## Verify the report

- Confirm that `schemasweep-report.json` exists under the configured `projectRoot`.
- Inspect the `unused` counts in the report to ensure the scan covered the expected queries.

## Troubleshooting

- If the CLI cannot find `schemasweep.config.ts`, ensure you are running commands from the repository root.
- If no files are detected, double-check that `projectRoot` is correct and that the glob patterns match your file structure.
- For GraphQL errors, verify endpoint reachability and authentication headers.
