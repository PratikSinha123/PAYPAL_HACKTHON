import assert from "node:assert/strict";
import { openDb, storeEvent } from "./db.js";

const db = openDb(":memory:");
assert.equal(storeEvent(db, "WH-1", "PAYMENT.SALE.COMPLETED", "{}"), true);
assert.equal(storeEvent(db, "WH-1", "PAYMENT.SALE.COMPLETED", "{}"), false); // PayPal retry
assert.throws(() => db.prepare("INSERT INTO actions (status) VALUES ('bogus')").run()); // gate states constrained
console.log("ok");
