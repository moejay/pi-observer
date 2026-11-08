import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// A URL import keeps the dependency-free .mjs builder outside the TS project.
const { buildSite } = (await import(pathToFileURL(join(root, "scripts/build-site.mjs")).href)) as {
  buildSite: (outputDir?: string) => Promise<string>;
};
const assets = [".nojekyll", "favicon.svg", "index.html", "styles.css"];

async function fixture() {
  const tmp = join(root, ".tmp");
  await mkdir(tmp, { recursive: true });
  return mkdtemp(join(tmp, "site-test-"));
}

function attributes(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\b${name}="([^"]*)"`, "g"))].map((match) => match[1]);
}

test("site build contains only public allowlisted assets and replaces stale output", async () => {
  const output = await fixture();
  try {
    await writeFile(join(output, "private-session.json"), "must not be published");
    assert.equal(await buildSite(output), output);
    assert.deepEqual((await readdir(output)).sort(), assets);
    for (const asset of assets) {
      assert.equal(
        await readFile(join(output, asset), "utf8"),
        await readFile(join(root, "docs", asset), "utf8"),
      );
    }
    await buildSite(relative(root, output));
    assert.deepEqual((await readdir(output)).sort(), assets);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("built page has valid relative links, anchors, metadata, and no external dependencies", async () => {
  const output = await fixture();
  try {
    await buildSite(output);
    const html = await readFile(join(output, "index.html"), "utf8");
    const css = await readFile(join(output, "styles.css"), "utf8");
    const ids = attributes(html, "id");
    assert.equal(new Set(ids).size, ids.length, "duplicate HTML ids");
    assert.match(html, /<html lang="en">/);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
    assert.match(html, /<title>Pi Observer/);
    assert.match(html, /name="description"\s+content="[^"]+"/);
    assert.match(html, /rel="canonical"\s+href="https:\/\/moejay\.github\.io\/pi-observer\/"/);
    assert.match(html, /property="og:url"\s+content="https:\/\/moejay\.github\.io\/pi-observer\/"/);
    assert.match(html, /pi install git:github\.com\/moejay\/pi-observer@v1\.0\.0/);
    assert.match(html, /\/assess settings/);
    assert.match(html, /Save/);
    assert.match(html, /Cancel/);
    assert.match(html, /session-local/);
    assert.match(html, /Illustrative report/);
    assert.match(html, /no automatic secret redaction/);
    assert.match(html, /soft cap/);
    assert.doesNotMatch(
      html,
      /pi-assess|Pi Assess|example\.(?:com|org)|YOUR_USERNAME|TODO|lorem ipsum|npm install pi-observer/i,
    );
    assert.doesNotMatch(html, /<script\b|<iframe\b|<form\b|on(?:click|load|error)=/i);
    assert.doesNotMatch(
      css,
      /@import|https?:|url\(/i,
      "CSS must not load external fonts or assets",
    );
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /focus-visible/);
    assert.match(css, /prefers-color-scheme:\s*dark/);
    for (const link of [...attributes(html, "href"), ...attributes(html, "src")]) {
      if (link.startsWith("https://")) {
        const url = new URL(link);
        assert.ok(
          (url.hostname === "github.com" &&
            /^\/moejay\/pi-observer(?:\/|$|#)/.test(url.pathname + url.hash)) ||
            (url.hostname === "moejay.github.io" && url.pathname === "/pi-observer/"),
          `unexpected external destination: ${link}`,
        );
        continue;
      }
      assert.ok(!/^(?:\/|[a-z]+:|\/\/)/i.test(link), `not a portable relative link: ${link}`);
      const [file, anchor] = link.split("#");
      const path = resolve(output, file || "index.html");
      assert.equal(dirname(path), output, `link leaves public asset directory: ${link}`);
      assert.ok(
        assets.includes(file.replace(/^\.\//, "") || "index.html"),
        `unlisted link: ${link}`,
      );
      await readFile(path);
      if (anchor) assert.ok(ids.includes(decodeURIComponent(anchor)), `missing anchor: ${link}`);
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("builder rejects dangerous destinations and symlinked output paths without deleting data", async () => {
  const fixtureDir = await fixture();
  const sentinel = join(fixtureDir, "keep.txt");
  const link = `${fixtureDir}-link`;
  try {
    await writeFile(sentinel, "keep");
    for (const unsafe of [
      root,
      ".",
      "..",
      "/",
      "/tmp/pi-observer-site",
      "docs",
      "src",
      "test",
      ".tmp",
      "dist/nested",
      "",
      "../dist",
    ]) {
      await assert.rejects(buildSite(unsafe), /output|unsafe|directory/i, unsafe);
    }
    await symlink(fixtureDir, link, "dir");
    await assert.rejects(buildSite(link), /unsafe/i);
    assert.equal(await readFile(sentinel, "utf8"), "keep");
  } finally {
    await rm(link, { force: true });
    await rm(fixtureDir, { recursive: true, force: true });
  }
});
