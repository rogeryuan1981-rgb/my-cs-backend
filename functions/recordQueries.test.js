const test = require("node:test");
const assert = require("node:assert/strict");
const { matchesRecord, normalizeRequest, compareRecords } = require("./recordQueries");

test("history filters keep the original keyword, progress and date semantics", () => {
  const filters = normalizeRequest({
    scope: "history",
    search: "癌症",
    progress: "未結案",
    startDate: "2026-11-01",
    endDate: "2026-11-30",
  });
  const record = {
    id: "a",
    receiveTime: "2026-11-10T09:00",
    category: "篩檢",
    progress: "待處理",
    isDeleted: false,
  };
  assert.equal(matchesRecord(record, filters, { 篩檢: "癌症防治" }), true);
  assert.equal(matchesRecord({ ...record, progress: "結案" }, filters, { 篩檢: "癌症防治" }), false);
  assert.equal(matchesRecord({ ...record, isDeleted: true }, filters, { 篩檢: "癌症防治" }), false);
});

test("close-date filtering supports explicit closeTime", () => {
  const filters = normalizeRequest({
    closeDateEnabled: true,
    closeStartDate: "2026-11-05",
    closeEndDate: "2026-11-10",
  });
  assert.equal(matchesRecord({ id: "a", progress: "結案", closeTime: "2026-11-08T12:00" }, filters), true);
  assert.equal(matchesRecord({ id: "b", progress: "結案", closeTime: "2026-11-11T12:00" }, filters), false);
});

test("sorting is stable by document id when values are equal", () => {
  const records = [
    { id: "b", receiveTime: "2026-11-10T09:00" },
    { id: "a", receiveTime: "2026-11-10T09:00" },
  ];
  records.sort((a, b) => compareRecords(a, b, "receiveTime", "asc"));
  assert.deepEqual(records.map((record) => record.id), ["a", "b"]);
});
