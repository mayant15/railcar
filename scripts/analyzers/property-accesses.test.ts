import { expect, test } from "bun:test";
import { countObjectPropertyAccesses } from "./property-accesses";

test("no accesses", async () => {
    const count = await countObjectPropertyAccesses("x");
    expect(count).toBe(0);
});
