import { resolve } from "node:path";

export function collectHtmlBundleAssetPaths(html: string, assetDirectory: string) {
  const assetPaths = new Map<string, string>();
  for (const match of html.matchAll(/(?:href|src)="(?:\.\/|\/)([a-zA-Z0-9._-]+)"/gu)) {
    const assetName = match[1];
    if (assetName !== undefined)
      assetPaths.set(`/${assetName}`, resolve(assetDirectory, assetName));
  }
  return assetPaths;
}
