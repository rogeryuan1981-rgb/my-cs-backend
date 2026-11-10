const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");
const { queryRecords, reportRecords, authorize, ROLES } = require("./recordQueries");
const { calculateWorkingHours, getTaipeiDateString, resolveNotificationTarget, wasNotifiedToday } = require("./overdue");

// 初始化 Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// 從環境變數讀取 LINE Channel Access Token
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

/**
 * 核心邏輯：處理逾期案件並發送通知
 */
async function processOverdueTickets(isManual = false) {
  try {
    console.log(`開始執行【每日整合版 (支援假日排除與代理人)】逾期案件檢查排程... (手動觸發: ${isManual})`);

    const settingsDoc = await db.collection("cs_settings").doc("dropdowns").get();
    const overdueHours = settingsDoc.exists && settingsDoc.data().overdueHours 
      ? settingsDoc.data().overdueHours 
      : 24;
    
    const holidays = settingsDoc.exists && settingsDoc.data().holidays ? settingsDoc.data().holidays : [];

    const now = new Date().getTime();
    // 取得台灣時間的「今天日期」(YYYY-MM-DD)
    const todayString = getTaipeiDateString(now);
    
    // 【新增機制】檢查今天是否為國定假日 (若手動觸發則無視放假)
    const isTodayHoliday = holidays.some(h => todayString >= h.start && todayString <= h.end);
    if (isTodayHoliday && !isManual) {
       console.log("今天是設定的國定假日，自動排程暫停發送推播。");
       return { userNotifiedCount: 0, totalTicketsMarked: 0 };
    }

    // 假日先短路，再讀取案件；select 只傳送逾期判斷與通知實際需要的欄位。
    const recordsSnapshot = await db.collection("cs_records")
      .where("progress", "!=", "結案")
      .select("ticketId", "instName", "progress", "assignee", "receiver", "receiveTime", "isDeleted", "notifiedOverdue", "notifiedAt")
      .get();
    console.log(`逾期排程候選案件讀取 ${recordsSnapshot.size} 筆。`);

    const overdueTickets = [];

    recordsSnapshot.forEach((doc) => {
      const data = doc.data();
      
      // 排除邏輯刪除的案件
      if (data.isDeleted) return; 

      // 如果是「自動排程」，才檢查今天是否已經通知過。若是「手動觸發」，則強制無視標記發送！
      if (!isManual && wasNotifiedToday(data, todayString)) return;

      const receiveTime = new Date(data.receiveTime).getTime();
      if (!Number.isFinite(receiveTime)) {
        console.warn(`案件 ${doc.id} 的 receiveTime 無效，已略過。`);
        return;
      }
      // 將設定的假日列表傳入計算
      const workingDiffHours = calculateWorkingHours(receiveTime, now, holidays);

      if (workingDiffHours > overdueHours) {
        overdueTickets.push({ id: doc.id, ref: doc.ref, ...data });
      }
    });

    if (overdueTickets.length === 0) {
      console.log("目前無需要通知的逾期案件。");
      return { userNotifiedCount: 0, totalTicketsMarked: 0 };
    }

    const usersSnapshot = await db.collection("cs_users")
      .select("username", "isDisabled", "leaveStart", "leaveEnd", "delegateUser", "lineUserId")
      .get();
    const usersData = {}; // 存放完整用戶資訊 (包含代理人與 UID)
    usersSnapshot.forEach(doc => {
      const u = doc.data();
      if (u.isDisabled !== true) {
        usersData[u.username] = u;
      }
    });

    if (!LINE_ACCESS_TOKEN) {
      console.error("尚未設定 LINE_ACCESS_TOKEN，無法發送訊息。");
      return { userNotifiedCount: 0, totalTicketsMarked: 0 };
    }

    const ticketsByUser = {};
    for (const ticket of overdueTickets) {
      const { targetUser, originalUser } = resolveNotificationTarget(ticket, usersData, todayString);

      if (!ticketsByUser[targetUser]) {
        ticketsByUser[targetUser] = [];
      }
      // 將代理資訊附加進去
      ticketsByUser[targetUser].push({ ...ticket, originalUser });
    }

    const batch = db.batch();
    let userNotifiedCount = 0;
    let totalTicketsMarked = 0;

    for (const [targetUser, tickets] of Object.entries(ticketsByUser)) {
      // 從用戶資料中取得該負責人的 LINE UID
      const lineUserId = usersData[targetUser]?.lineUserId;

      if (lineUserId) {
        let message = `⚠️ 【每日逾期案件總覽】\n${isManual ? '管理員提醒！' : '早安！'}您目前有 ${tickets.length} 件超過 ${overdueHours} 小時未結案的紀錄：\n\n`;
        
        tickets.forEach((t, index) => {
          const delegateText = t.originalUser ? ` (原負責: ${t.originalUser})` : '';
          message += `${index + 1}. [${t.ticketId || t.id.slice(0,8)}] ${t.instName}${delegateText}\n   進度：${t.progress}\n`;
        });
        
        message += `\n請盡速登入系統處理，謝謝！`;

        try {
          await axios.post('https://api.line.me/v2/bot/message/push', {
            to: lineUserId,
            messages: [{ type: 'text', text: message }]
          }, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
            }
          });

          // 發送成功後，更新最後通知時間為現在
          for (const t of tickets) {
            batch.update(t.ref, { 
              notifiedOverdue: true, 
              notifiedAt: new Date().toISOString() 
            });
            totalTicketsMarked++;
          }
          userNotifiedCount++;

        } catch (lineErr) {
          console.error(`發送整合訊息給 ${targetUser} 失敗:`, lineErr.response?.data || lineErr.message);
        }
      }
    }

    if (totalTicketsMarked > 0) {
      await batch.commit();
      console.log(`成功發送給 ${userNotifiedCount} 位同仁，並標記了 ${totalTicketsMarked} 筆逾期案件。`);
    } else {
      console.log("逾期案件的負責人皆未綁定 LINE UID，略過發送。");
    }

    return { userNotifiedCount, totalTicketsMarked };

  } catch (error) {
    console.error("執行核心排程發生嚴重錯誤:", error);
    throw error;
  }
}

/**
 * 每日逾期案件整合檢查排程 (排除六日)
 * 設定為：台灣時間【每週一到週五】早上 09:00 執行一次 (Cron: "0 9 * * 1-5")
 */
exports.checkOverdueTickets = onSchedule({
  schedule: "0 9 * * 1-5",
  timeZone: "Asia/Taipei"
}, async (event) => {
  await processOverdueTickets(false);
});

/**
 * 供前端網頁「強制觸發」的手動執行函式
 */
exports.manualTriggerOverdue = onCall({
  cors: true
}, async (request) => {
  const profile = await authorize(db, request);
  if (profile.role !== ROLES.ADMIN) throw new HttpsError('permission-denied', '只有後台管理者可以手動發送逾期通知');
  
  try {
    const result = await processOverdueTickets(true);
    return { 
      success: true, 
      notifiedCount: result.userNotifiedCount, 
      markedCount: result.totalTicketsMarked 
    };
  } catch (error) {
    console.error("手動觸發發生錯誤:", error);
    throw new HttpsError('internal', '執行強制觸發時發生錯誤');
  }
});

/**
 * 清單用：預設條件走索引與 startAfter 游標；相容性搜尋只在使用者輸入搜尋、
 * 結案日篩選或非預設排序時按需執行。
 */
exports.queryRecords = onCall({ cors: true }, async (request) => {
  const result = await queryRecords(db, request);
  console.log("queryRecords", { strategy: result.strategy, returned: result.records.length, totalCount: result.totalCount });
  return result;
});

/** 統計與匯出用：只有開啟報表或按下匯出時才讀取完整指定範圍。 */
exports.reportRecords = onCall({ cors: true, timeoutSeconds: 120, memory: "512MiB" }, async (request) => {
  const result = await reportRecords(db, request);
  console.log("reportRecords", { strategy: result.strategy, returned: result.records.length, hasMore: Boolean(result.reportCursor) });
  return result;
});
