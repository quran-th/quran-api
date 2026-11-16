import assert from "node:assert/strict";
import { test } from "node:test";
import { importDatabaseModule, resolveDatabaseDir } from "../lib/database.mjs";
import { footnoteMismatch, markerNumbers } from "../lib/markers.mjs";

const { footnoteId, stripMarkers } = await importDatabaseModule(
  resolveDatabaseDir(),
  "markers.mjs",
);

test("markerNumbers finds every (*n*) marker in order", () => {
  assert.deepEqual(markerNumbers("ก(*1*) ข (*2*) ค(*10*)"), [1, 2, 10]);
  assert.deepEqual(markerNumbers("(คือ) ไม่มีเชิงอรรถ"), []);
});

test("stripMarkers removes markers without leaving stray spaces", () => {
  assert.equal(stripMarkers("อะลิฟ ลาม มีม (*1*)"), "อะลิฟ ลาม มีม");
  assert.equal(stripMarkers("สิ่งเร้นลับ(*1*) และดำรง"), "สิ่งเร้นลับ และดำรง");
  assert.equal(stripMarkers("คำแนะนำ(*1*)ที่มาจาก"), "คำแนะนำที่มาจาก");
  assert.equal(stripMarkers("ถูกกริ้ว (*1*) และมิใช่"), "ถูกกริ้ว และมิใช่");
  assert.equal(stripMarkers("อิบาดะฮฺ (*1*)  และ"), "อิบาดะฮฺ  และ");
  assert.equal(stripMarkers("ก (*1*)\nข"), "ก\nข");
  assert.equal(stripMarkers("(คือ) ทาง"), "(คือ) ทาง");
});

test("footnoteId is derived from the verse reference", () => {
  assert.equal(footnoteId(3, 2, 255, 1), 300_225_501);
  assert.equal(footnoteId(3, 114, 6, 17), 311_400_617);
  assert.equal(footnoteId(4, 1, 1, 1), 400_100_101);
  assert.notEqual(footnoteId(3, 2, 1, 1), footnoteId(3, 2, 1, 2));
  assert.notEqual(footnoteId(3, 2, 1, 1), footnoteId(4, 2, 1, 1));
  assert.throws(() => footnoteId(3, 2, 1, 100), /outside 1..99/);
  assert.throws(() => footnoteId(3, 2, 1, 0), /outside 1..99/);
});

test("footnoteMismatch compares marker and footnote numbers as sets", () => {
  const notes = (...numbers) =>
    numbers.map((number) => ({ number, text: "x" }));
  assert.equal(
    footnoteMismatch({ translation: "ก(*1*) ข(*2*)", footnotes: notes(1, 2) }),
    null,
  );
  assert.equal(
    footnoteMismatch({ translation: "ก(*1*) ข(*1*)", footnotes: notes(1) }),
    null,
  );
  assert.deepEqual(
    footnoteMismatch({ translation: "ก(*1*) ข(*3*)", footnotes: notes(1, 2) }),
    {
      missingFootnotes: [3],
      missingMarkers: [2],
    },
  );
  assert.deepEqual(
    footnoteMismatch({ translation: "ก", footnotes: notes(1) }),
    { missingFootnotes: [], missingMarkers: [1] },
  );
});
