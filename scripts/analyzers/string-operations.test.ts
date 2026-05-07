// Generated with Amp
import { expect, test } from "bun:test";
import { countStringOperations } from "./string-operations";

test("no operations", async () => {
    expect(await countStringOperations("const x = 1;")).toBe(0);
});

test("plain string literal counts", async () => {
    expect(await countStringOperations(`const x = "hello";`)).toBe(1);
});

test("plain template literal (no interpolation) counts", async () => {
    expect(await countStringOperations("const x = `hello`;")).toBe(1);
});

test("template literal with interpolation counts as one", async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source code under test
    expect(await countStringOperations("const x = `hi ${name}`;")).toBe(1);
});

test("string method call: toUpperCase", async () => {
    expect(await countStringOperations(`s.toUpperCase();`)).toBe(1);
});

test("string method call: split + trim chained", async () => {
    // split, ",", trim => 3
    expect(
        await countStringOperations(`s.split(",").map(x => x.trim());`),
    ).toBe(3);
});

test("optional chaining method call counts", async () => {
    // replace, "a", "b" => 3
    expect(await countStringOperations(`s?.replace("a", "b");`)).toBe(3);
});

test("computed member call with string literal counts", async () => {
    // computed call (toUpperCase) + the "toUpperCase" string literal => 2
    expect(await countStringOperations(`s["toUpperCase"]();`)).toBe(2);
});

test("computed member call with non-string-method literal does not count as call but literal still counts", async () => {
    // "push" is just a string literal, not a string method => 1
    expect(await countStringOperations(`s["push"]();`)).toBe(1);
});

test("computed member call with non-literal does not count", async () => {
    expect(await countStringOperations(`s[method]();`)).toBe(0);
});

test("concatenation with string literal counts", async () => {
    // binary + and "b" string literal => 2
    expect(await countStringOperations(`const x = a + "b";`)).toBe(2);
});

test("concatenation with template literal counts", async () => {
    // binary + and `b` template literal => 2
    expect(await countStringOperations("const x = a + `b`;")).toBe(2);
});

test("numeric addition does not count", async () => {
    expect(await countStringOperations(`const x = 1 + 2;`)).toBe(0);
});

test("non-string method call does not count (e.g. push)", async () => {
    expect(await countStringOperations(`arr.push(1);`)).toBe(0);
});

test("ambiguous array/string methods do not count", async () => {
    // indexOf, includes, slice, concat, lastIndexOf, at, toString
    // are also Array.prototype methods, so they should not be counted.
    expect(await countStringOperations(`x.indexOf("a");`)).toBe(1); // just the "a" literal
    expect(await countStringOperations(`x.includes("a");`)).toBe(1);
    expect(await countStringOperations(`x.lastIndexOf("a");`)).toBe(1);
    expect(await countStringOperations(`x.slice(0, 1);`)).toBe(0);
    expect(await countStringOperations(`x.concat(y);`)).toBe(0);
    expect(await countStringOperations(`x.at(0);`)).toBe(0);
    expect(await countStringOperations(`x.toString();`)).toBe(0);
});

test("mixed sample", async () => {
    const code = `
        const a = "hello";
        const b = a.toUpperCase();
        const c = a + " world";
        const d = \`val=\${a}\`;
        const e = a.split(",").map(s => s.trim());
    `;
    // "hello"           => 1
    // toUpperCase       => 1
    // +, " world"       => 2
    // template literal  => 1
    // split, ",", trim  => 3
    // total             => 8
    expect(await countStringOperations(code)).toBe(8);
});
