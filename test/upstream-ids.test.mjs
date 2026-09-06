import test from "node:test";
import assert from "node:assert/strict";
import { createUpstream } from "../lib/upstream.mjs";
import { OwnerPortal } from "../lib/portal.mjs";

function upstreamReturning(source) {
  return createUpstream({
    readOnly: true,
    fetchImpl: async () => new Response(source),
  });
}

test("unquoted unsafe estate integers retain every digit", async () => {
  const upstream = upstreamReturning(`{
    "code": 1200,
    "data": {
      "projectId": 1234567890123456789,
      "userId": 2234567890123456789,
      "negative": -9007199254740992,
      "boundary": 9007199254740991,
      "negativeBoundary": -9007199254740991,
      "nested": [9007199254740992, {"id": 1234567890123456790}]
    }
  }`);
  assert.deepEqual(await upstream("bookings"), {
    projectId: "1234567890123456789",
    userId: "2234567890123456789",
    negative: "-9007199254740992",
    boundary: 9007199254740991,
    negativeBoundary: -9007199254740991,
    nested: ["9007199254740992", { id: "1234567890123456790" }],
  });
});

test("quoted content, escapes, decimals and exponents retain normal JSON behavior", async () => {
  const source = String.raw`{
    "code": 1200,
    "data": {
      "text": "1234567890123456789 and \"id\":9007199254740992",
      "slash": "\\9007199254740992\/",
      "unicode": "\u0031\u0032\u0033",
      "1234567890123456789": "unchanged key",
      "quotedId": "1234567890123456789",
      "numbers": [0, -0, 1.25, -1.25, 1e3, 1E+20, 2.5e-2, 9007199254740992.0],
      "flags": [true, false, null],
      "empty": [{}, []],
      "__proto__": {"safe": true}
    }
  }`;
  const data = await upstreamReturning(source)("bookings");
  assert.deepEqual(data, JSON.parse(source).data);
  assert.equal(Object.hasOwn(data, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(data), Object.prototype);
});

test("malformed JSON is rejected without repairing unsafe numeric keys", async () => {
  for (const data of [
    "{1234567890123456789: 1}",
    '{"id": 01234567890123456789}',
    '{"id": 1234567890123456789,}',
    "[1234567890123456789,]",
    "[1234567890123456789 2]",
    '{"id": 1234567890123456789.}',
    '{"id": 1234567890123456789e}',
    '{"id": +1234567890123456789}',
    String.raw`{"id": "bad\q escape"}`,
    String.raw`{"id": "bad\u12 escape"}`,
    '{"id": "unterminated}',
    '{"id": "line\nbreak"}',
    '{"id":\u00a01234567890123456789}',
  ]) {
    await assert.rejects(
      upstreamReturning(`{"code":1200,"data":${data}}`)("bookings"),
      (error) => error.code === "UPSTREAM_RESPONSE",
      data,
    );
  }
});

test("exact project ownership keeps pending bookings and rejects rounded ID collisions", async () => {
  const projectId = "1234567890123456789";
  const foreignProjectId = "1234567890123456790";
  // These IDs collide as Numbers; ownership must compare their exact strings.
  assert.equal(Number(projectId), Number(foreignProjectId));
  const raw = `{"code":1200,"data":[
    {"id":"owned-booking","projectId":${projectId},"userId":2234567890123456789,
     "facilityId":"tennis","startTime":"2026.09.11 19:00","endTime":"2026.09.11 20:00"},
    {"id":"foreign-project-booking","projectId":${foreignProjectId}},
    {"id":"foreign-unit-booking","projectId":${projectId},"unitId":3234567890123456790}
  ]}`;
  const upstream = upstreamReturning(raw);
  const portal = new OwnerPortal({ upstream, readOnly: true });
  const session = {
    token: "synthetic-test-token",
    user: { id: "2234567890123456789" },
    unit: { unitId: "3234567890123456789", projectId, userType: 0 },
    quotes: new Map(),
  };
  const bookings = await portal.bookings(session, "unpaid");
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].id, "owned-booking");
  assert.equal(bookings[0].startTime, "2026-09-11 19:00");
  assert.equal(bookings[0].tab, "unpaid");
  const records = await upstream("bookings");
  assert.equal(records[0].userId, session.user.id);
  assert.equal(records[0].projectId, session.unit.projectId);
  assert.notEqual(records[1].projectId, session.unit.projectId);
});
