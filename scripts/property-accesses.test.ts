import { expect, test } from "bun:test";
import { countObjectPropertyAccesses } from "./property-accesses";

test("no accesses", () => {
    const count = countObjectPropertyAccesses("x");
    expect(count).toBe(0);
});
