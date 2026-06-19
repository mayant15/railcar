export function test(x) {
    console.log("---- test ----")
    if (typeof x === "object") {
        if (x === null) {
            console.log("null")
        } else if (x.prop !== 0) {
            console.log(typeof x, "x.prop =", x.prop)
        } else {
            console.log(typeof x, "keys", Object.keys(x))
        }
    } else if (typeof x === "string") {
        console.log("string")
    } else {
        console.log("unknown", typeof x)
    }
}
