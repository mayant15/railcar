// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "bun:test";

import type { Schema } from "./schema.js";
import { loadSchemaFromObject } from "./reflection.js";

test("remove unexported endpoints", async () => {
    const schemaJson: Schema = {
        missing: {
            args: [],
            callconv: "Free",
            ret: { isAny: true, kind: {} },
        },
    };
    const { schema, endpoints } = await loadSchemaFromObject(
        "./test/lib.js",
        schemaJson,
    );

    expect("totallyLegit" in endpoints).toBeTrue();
    expect("totallyLegit" in schema).toBeTrue();

    expect("missing" in endpoints).toBeFalse();
    expect("missing" in schema).toBeFalse();

    expect(Object.keys(endpoints).length).toBe(Object.keys(schema).length);
});
