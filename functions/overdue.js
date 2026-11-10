function getTaipeiDateString(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  return new Date(milliseconds + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** 計算兩個時間戳之間的工作時數（扣除週六、週日及設定假日）。 */
function calculateWorkingHours(startMs, endMs, holidays = []) {
  if (endMs <= startMs) return 0;
  const totalMs = endMs - startMs;
  let nonWorkingMs = 0;
  const currentDay = new Date(startMs + 8 * 60 * 60 * 1000);
  currentDay.setUTCHours(0, 0, 0, 0);
  const endDay = new Date(endMs + 8 * 60 * 60 * 1000);
  endDay.setUTCHours(0, 0, 0, 0);

  while (currentDay.getTime() <= endDay.getTime()) {
    const dayOfWeek = currentDay.getUTCDay();
    const dateString = currentDay.toISOString().slice(0, 10);
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const isHoliday = holidays.some((holiday) => dateString >= holiday.start && dateString <= holiday.end);
    if (isWeekend || isHoliday) {
      const startOfDayMs = currentDay.getTime() - 8 * 60 * 60 * 1000;
      const endOfDayMs = startOfDayMs + 24 * 60 * 60 * 1000;
      const overlapStart = Math.max(startOfDayMs, startMs);
      const overlapEnd = Math.min(endOfDayMs, endMs);
      if (overlapEnd > overlapStart) nonWorkingMs += overlapEnd - overlapStart;
    }
    currentDay.setUTCDate(currentDay.getUTCDate() + 1);
  }
  return (totalMs - nonWorkingMs) / (1000 * 60 * 60);
}

function wasNotifiedToday(record, todayString) {
  if (!record.notifiedOverdue || !record.notifiedAt) return false;
  const timestamp = new Date(record.notifiedAt).getTime();
  return Number.isFinite(timestamp) && getTaipeiDateString(timestamp) === todayString;
}

function resolveNotificationTarget(ticket, usersByName, todayString) {
  const originalUser = ticket.assignee || ticket.receiver;
  const profile = usersByName[originalUser];
  const isDelegated = Boolean(
    profile?.leaveStart
    && profile?.leaveEnd
    && profile?.delegateUser
    && todayString >= profile.leaveStart
    && todayString <= profile.leaveEnd
  );
  return {
    targetUser: isDelegated ? profile.delegateUser : originalUser,
    originalUser: isDelegated ? originalUser : null,
  };
}

module.exports = { calculateWorkingHours, getTaipeiDateString, resolveNotificationTarget, wasNotifiedToday };
