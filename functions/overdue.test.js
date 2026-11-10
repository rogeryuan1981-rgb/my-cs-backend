const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateWorkingHours, resolveNotificationTarget, wasNotifiedToday } = require("./overdue");

test("working hours exclude weekends and configured holidays", () => {
  const start = Date.parse("2026-11-06T00:00:00.000Z"); // 台灣週五 08:00
  const end = Date.parse("2026-11-10T00:00:00.000Z"); // 台灣週二 08:00
  assert.equal(calculateWorkingHours(start, end, []), 48);
  assert.equal(calculateWorkingHours(start, end, [{ start: "2026-11-09", end: "2026-11-09" }]), 24);
});

test("notification target switches to delegate only inside leave range", () => {
  const users = { 王小明: { leaveStart: "2026-11-10", leaveEnd: "2026-11-12", delegateUser: "李小華" } };
  assert.deepEqual(resolveNotificationTarget({ assignee: "王小明" }, users, "2026-11-10"), {
    targetUser: "李小華",
    originalUser: "王小明",
  });
  assert.deepEqual(resolveNotificationTarget({ assignee: "王小明" }, users, "2026-11-13"), {
    targetUser: "王小明",
    originalUser: null,
  });
});

test("automatic notification is suppressed only when marked on the same Taipei date", () => {
  const record = { notifiedOverdue: true, notifiedAt: "2026-11-10T00:30:00.000Z" };
  assert.equal(wasNotifiedToday(record, "2026-11-10"), true);
  assert.equal(wasNotifiedToday(record, "2026-11-11"), false);
  assert.equal(wasNotifiedToday({ ...record, notifiedOverdue: false }, "2026-11-10"), false);
});
