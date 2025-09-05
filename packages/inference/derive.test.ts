import { test, expect } from "bun:test";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveFromDeclFile } from "./derive";
import { Guess } from "./common";
// import tsSchemas from "./typescript";

// const PROJECTS = ["example", "pako", "js-yaml", "fast-xml-parser"] as const;
//
// for (const project of PROJECTS) {
//     test(project, () => {
//         const actual = deriveFromDeclFile(
//             `../../benchmarks/projects/${project}/index.d.ts`,
//         );
//         const expected = tsSchemas[project];
//         expect(actual).toEqual(expected);
//     });
// }
//
// test("protobuf-js", () => {
//     const actual = deriveFromDeclFile(
//         `../../benchmarks/projects/protobuf-js/index.d.ts`,
//     );
// });
//
// test("sharp", () => {
//     const actual = deriveFromDeclFile(
//         `../../benchmarks/projects/sharp/index.d.ts`,
//     );
// });

test("extends class", async () => {
    const code = `
export class Base {
    constructor();
    base(x: number): void;
}

export class Derived extends Base {
    constructor();
    derived(): void;
}
`;
    const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
    Bun.write(tmpFile, code);
    const actual = deriveFromDeclFile(tmpFile);

    expect(actual["Base"]).not.toBeNil();
    expect(actual["Base.base"]).not.toBeNil();
    expect(actual["Derived"]).not.toBeNil();
    expect(actual["Derived.base"]).not.toBeNil();
    expect(actual["Derived.derived"]).not.toBeNil();

    expect(actual["Base.base"].args[0]).toEqual({
        isAny: false,
        kind: {
            Class: 1.0,
        },
        classType: {
            Base: 1.0,
        },
    });

    expect(actual["Base.base"].args[1]).toEqual(Guess.number());

    expect(actual["Derived.base"].args[0]).toEqual({
        isAny: false,
        kind: {
            Class: 1.0,
        },
        classType: {
            Derived: 1.0,
        },
    });

    expect(actual["Derived.base"].args[1]).toEqual(Guess.number());
});

test("unwrap promise", async () => {
    const code = `
export function sleep(ms: number): Promise<boolean>;
`;
    const tmpFile = join(tmpdir(), "railcar-derive-test.ts");
    Bun.write(tmpFile, code);
    const actual = deriveFromDeclFile(tmpFile);

    expect(actual["sleep"]).not.toBeNil();
    expect(actual["sleep"].args[0]).toEqual(Guess.number());
    expect(actual["sleep"].ret).toEqual(Guess.boolean());
});
