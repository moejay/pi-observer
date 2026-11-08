import { copyFile, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const siteAssets = Object.freeze(["index.html", "styles.css", "favicon.svg", ".nojekyll"]);

// Only dist or a dedicated .tmp/site-* directory may be replaced. Never follow
// symlinks: even an apparently local destination could otherwise escape the repo.
async function safeDestination(outputDir) {
  if (typeof outputDir !== "string" || !outputDir.trim())
    throw new Error("Output directory must be a nonempty path.");
  const root = await realpath(projectRoot);
  const target = resolve(root, outputDir);
  const local = relative(root, target);
  const parts = local.split(sep);
  if (
    isAbsolute(local) ||
    local === ".." ||
    local.startsWith(`..${sep}`) ||
    !(
      local === "dist" ||
      (parts.length === 2 && parts[0] === ".tmp" && /^site-[\w-]+$/.test(parts[1]))
    )
  ) {
    throw new Error(
      "Site output must be project dist or .tmp/site-<name>; refusing unsafe destination.",
    );
  }
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Unsafe output path: ${current}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return target;
}

/** Copy only public, explicitly allowlisted assets; no runtime/session files. */
export async function buildSite(outputDir = "dist") {
  const target = await safeDestination(outputDir);
  const source = resolve(projectRoot, "docs");
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory())
    throw new Error("docs must be a real directory.");
  // Verify all inputs before deleting a previous build.
  for (const asset of siteAssets) {
    const info = await lstat(join(source, asset));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid public asset: ${asset}`);
    await readFile(join(source, asset));
  }
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const asset of siteAssets) await copyFile(join(source, asset), join(target, asset));
  return target;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length > 3)
      throw new Error("Usage: node scripts/build-site.mjs [output-directory]");
    const target = await buildSite(process.argv[2]);
    console.log(`Built Pi Observer site: ${relative(projectRoot, target) || "."}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
