import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LocalSolanaError, object, string } from "../domain/model.ts";
import type { CommandPort, ToolPaths, ToolResolverPort } from "../application/ports.ts";

export class PinnedToolResolver implements ToolResolverPort {
  private readonly repositoryRoot: string;
  private readonly commands: CommandPort;
  public constructor(repositoryRoot: string, commands: CommandPort) { this.repositoryRoot = repositoryRoot; this.commands = commands; }
  public async resolve(): Promise<ToolPaths> {
    const lockPath = join(this.repositoryRoot, "tooling/toolchain.lock.json");
    const lock = object(JSON.parse(await readFile(lockPath, "utf8")), "toolchain lock");
    const tools = object(lock.tools, "toolchain tools"); const agave = object(tools.agave, "Agave pin");
    if (agave.version !== "4.2.1" || agave.splTokenVersion !== "5.6.1") { throw new LocalSolanaError("SOLANA_TOOL_VERSION_PIN", "expected exact Agave 4.2.1 and SPL 5.6.1 pins"); }
    const platform = process.platform === "linux" && process.arch === "x64" ? "linux-x64" : process.platform === "darwin" && process.arch === "arm64" ? "darwin-arm64" : "";
    if (!platform) { throw new LocalSolanaError("SOLANA_TOOL_PLATFORM", "supported platforms are linux-x64 and darwin-arm64"); }
    const artifact = object(object(agave.platforms, "Agave platforms")[platform], "Agave artifact");
    if (artifact.archive !== "tar.bz2" || !string(artifact.url, "Agave URL").startsWith("https://github.com/anza-xyz/agave/releases/download/v4.2.1/") || !/^[a-f0-9]{64}$/u.test(string(artifact.sha256, "archive hash"))) {
      throw new LocalSolanaError("SOLANA_TOOL_ARCHIVE_PIN", "Agave archive pin is not immutable");
    }
    const install = resolve(this.repositoryRoot, ".tools", string(artifact.installDirectory, "install directory"));
    const hashes = object(artifact.expectedFileSha256, "binary hashes");
    const paths: ToolPaths = { solana: join(install, "bin/solana"), keygen: join(install, "bin/solana-keygen"), validator: join(install, "bin/solana-test-validator"), splToken: join(install, "bin/spl-token") };
    for (const [name, path] of Object.entries(paths)) {
      const relative = name === "keygen" ? "bin/solana-keygen" : name === "validator" ? "bin/solana-test-validator" : name === "splToken" ? "bin/spl-token" : "bin/solana";
      const entry = await lstat(path).catch(() => null);
      if (!entry?.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || await realpath(path) !== path) { throw new LocalSolanaError("SOLANA_TOOL_MISSING", `${name} is absent or substituted; run ./dev bootstrap fetch --scope=solana then install --offline --scope=solana`); }
      const actual = createHash("sha256").update(await readFile(path)).digest("hex");
      if (actual !== hashes[relative]) { throw new LocalSolanaError("SOLANA_TOOL_HASH", `${name} binary hash mismatch`); }
    }
    const env = { HOME: "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" };
    for (const [path, expected] of [[paths.solana, /^solana-cli 4\.2\.1 /u], [paths.keygen, /^solana-keygen 4\.2\.1 /u], [paths.validator, /^solana-test-validator 4\.2\.1 /u], [paths.splToken, /^spl-token-cli 5\.6\.1\s*$/u]] as const) {
      const result = await this.commands.run(path, ["--version"], { env, timeoutMs: 10_000 });
      if (result.exitCode !== 0 || !expected.test(result.stdout)) { throw new LocalSolanaError("SOLANA_TOOL_VERSION", `${path.split("/").at(-1)} version mismatch`); }
    }
    return paths;
  }
}
