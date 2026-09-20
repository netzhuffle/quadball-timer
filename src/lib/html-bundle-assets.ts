import { basename, resolve } from "node:path";

export function collectHtmlBundleAssetPaths(
  html: string,
  assetDirectory: string,
  files: Bun.HTMLBundle["files"] = [],
) {
  const assetPaths = new Map<string, string>();
  for (const match of html.matchAll(/(?:href|src)="(?:\.\/|\/)([a-zA-Z0-9._-]+)"/gu)) {
    const assetName = match[1];
    if (assetName !== undefined)
      assetPaths.set(`/${assetName}`, resolve(assetDirectory, assetName));
  }
  // HTML only names initial assets. Bun's browser manifest also owns dynamic
  // route chunks and their shared dependencies, including compiled $bunfs files.
  for (const file of files) {
    const assetName = basename(file.path);
    if (file.loader === "html" || assetName.endsWith(".map")) continue;
    if (!/^[a-zA-Z0-9._-]+$/u.test(assetName)) continue;
    assetPaths.set(`/${assetName}`, resolve(assetDirectory, assetName));
  }
  return assetPaths;
}
