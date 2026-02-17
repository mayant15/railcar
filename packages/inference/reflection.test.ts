// SPDX-License-Identifier: AGPL-3.0-or-later

import { test, expect } from "bun:test";

import type { Schema } from "./schema.js";
import { loadSchemaFromObject } from "./reflection.js";
import { Guess } from "./common.js";

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

    expect("missing" in endpoints).toBeFalse();
    expect("missing" in schema).toBeFalse();

    expect(Object.keys(endpoints).length).toBe(Object.keys(schema).length);
});

test("should not include functions not in schema", async () => {
    const {schema, endpoints} = await loadSchemaFromObject("./test/lib.js", {})

    expect(schema["totallyLegit"]).toBeUndefined();
    expect(endpoints["totallyLegit"]).toBeUndefined();
})

test("should include functions not in schema if option set", async () => {
    const {schema, endpoints} = await loadSchemaFromObject("./test/lib.js", {}, { skipEndpointsNotInSchema: false })
    expect(schema["totallyLegit"]).toEqual({
        args: [],
        ret: Guess.any(),
        callconv: "Free",
    })
    expect(endpoints["totallyLegit"]).toBeFunction();
})
