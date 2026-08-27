import { rm } from "node:fs/promises";

await Promise.all([
  rm("packages/domain/dist", { force: true, recursive: true }),
  rm("coverage", { force: true, recursive: true }),
]);

