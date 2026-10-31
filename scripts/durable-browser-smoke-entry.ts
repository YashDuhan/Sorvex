import * as durable from "@sorvex/durable";
import * as environment from "@sorvex/durable/env";
import * as jsonl from "@sorvex/durable/storage/jsonl";
import * as sqlite from "@sorvex/durable/storage/sqlite";

// Keep runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
