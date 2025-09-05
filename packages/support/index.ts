import { FuzzedDataProvider as DataProvider } from "./FuzzedDataProvider";

export class FuzzedDataProvider extends DataProvider {
    constructor(data: Uint8Array) {
        super(Buffer.from(data));
    }
}
