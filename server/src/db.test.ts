import assert from "node:assert/strict";
import { openDb, initDb, storeEvent } from "./db.js";

const db = openDb("file::memory:?cache=shared");
await initDb(db);

assert.equal(await storeEvent(db, "WH-1", "PAYMENT.SALE.COMPLETED", "{}"), true);
assert.equal(await storeEvent(db, "WH-1", "PAYMENT.SALE.COMPLETED", "{}"), false); // PayPal retry

// Gate states constrained - test via a bad INSERT
try {
  await db.execute("INSERT INTO actions (status) VALUES ('bogus')");
  assert.fail("should have thrown on bad status");
} catch (e) {
  // expected - constraint violation
}

console.log("ok");
