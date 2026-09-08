import { rm } from "node:fs/promises";

await Promise.all([
  rm("packages/domain/dist", { force: true, recursive: true }),
  rm("packages/contexts/supply/dist", { force: true, recursive: true }),
  rm("packages/contexts/supply/.local/tests", { force: true, recursive: true }),
  rm(".local/genesis", { force: true, recursive: true }),
  rm("coverage", { force: true, recursive: true }),
]);
