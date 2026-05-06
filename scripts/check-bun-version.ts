type PackageJson = {
  packageManager?: unknown;
  devDependencies?: Record<string, string>;
};

const packageJson = (await Bun.file(
  new URL("../package.json", import.meta.url),
).json()) as PackageJson;

const packageManager = packageJson.packageManager;

if (typeof packageManager !== "string" || !packageManager.startsWith("bun@")) {
  throw new Error('package.json must pin Bun with "packageManager": "bun@x.y.z".');
}

const expectedBunVersion = packageManager.slice("bun@".length);
const actualBunVersion = Bun.version;

if (actualBunVersion !== expectedBunVersion) {
  throw new Error(
    `Bun version mismatch: packageManager pins ${expectedBunVersion}, but current runtime is ${actualBunVersion}.`,
  );
}

const bunTypesVersion = packageJson.devDependencies?.["@types/bun"];
if (bunTypesVersion !== expectedBunVersion) {
  throw new Error(
    `@types/bun must exactly match packageManager Bun version ${expectedBunVersion}; found ${bunTypesVersion ?? "missing"}.`,
  );
}

console.log(`Bun runtime and @types/bun are pinned to ${expectedBunVersion}.`);
