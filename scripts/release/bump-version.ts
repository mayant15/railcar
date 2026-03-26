import assert from "node:assert";

function getVersion() {
    const version = process.argv[2];
    assert(version !== undefined);
    assert(
        version.match(/^\d+\.\d+\.\d+$/),
        `invalid version number format ${version}`,
    );
    return version;
}

async function bumpJsonVersion(path: string, version: string) {
    console.log("bumping version in", path);

    const file = Bun.file(path);
    const pkg = await file.json();
    pkg.version = version;
    if (pkg.optionalDependencies) {
        const keys = Object.keys(pkg.optionalDependencies);
        for (const key of keys) {
            if (key.startsWith("@railcar/")) {
                pkg.optionalDependencies[key] = version;
            }
        }
    }
    if (pkg.dependencies) {
        const keys = Object.keys(pkg.dependencies);
        for (const key of keys) {
            if (key.startsWith("@railcar/")) {
                pkg.dependencies[key] = version;
            }
        }
    }
    file.write(JSON.stringify(pkg, null, 4));
}

async function main() {
    const version = getVersion();

    for await (const buf of process.stdin) {
        const files = buf
            .toString()
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

        for (const path of files) {
            assert(path.endsWith(".json"));
            await bumpJsonVersion(path, version);
        }
    }
}

await main();
