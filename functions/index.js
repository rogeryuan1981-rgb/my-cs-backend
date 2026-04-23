const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");

// 初始化 Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// 從環境變數讀取 LINE Channel Access Token
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

/**
 * 輔助函式：計算兩個時間戳之間的「工作時數」（扣除星期六、日）
 */
function calculateWorkingHours(startMs, endMs) {
  if (endMs <= startMs) return 0;
  let totalMs = endMs - startMs;
  let weekendMs = 0;
  
  let cur = new Date(startMs);
  cur.setHours(0, 0, 0, 0); 
  
  let endDay = new Date(endMs);
  endDay.setHours(0, 0, 0, 0); 
  
  while (cur.getTime() <= endDay.getTime()) {
    let day = cur.getDay();
    if (day === 0 || day === 6) { 
      let startOfDay = cur.getTime();
      let endOfDay = startOfDay + 24 * 60 * 60 * 1000;
      let overlapStart = Math.max(startOfDay, startMs);
      let overlapEnd = Math.min(endOfDay, endMs);
      if (overlapEnd > overlapStart) {
        weekendMs += (overlapEnd - overlapStart);
      }
    }
    cur.setDate(cur.getDate() + 1); 
  }
  
  return (totalMs - weekendMs) / (1000 * 60 * 60);
}

/**
 * 核心邏輯：處理逾期案件並發送通知
 */
async function processOverdueTickets(isManual = false) {
  try {
    console.log(`開始執行【每日整合版 (每日重複提醒)】逾期案件檢查排程... (手動觸發: ${isManual})`);

    const settingsDoc = await db.collection("cs_settings").doc("dropdowns").get();
    const overdueHours = settingsDoc.exists && settingsDoc.data().overdueHours 
      ? settingsDoc.data().overdueHours 
      : 24;

    const recordsSnapshot = await db.collection("cs_records")
      .where("progress", "!=", "結案")
      .get();

    const now = new Date().getTime();
    // 取得台灣時間的「今天日期」(YYYY-MM-DD)
    const todayString = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    
    const overdueTickets = [];

    recordsSnapshot.forEach((doc) => {
      const data = doc.data();
      
      // 排除邏輯刪除的案件
      if (data.isDeleted) return; 

      // 【關鍵修改】檢查今天是否已經通知過，避免同一天內手動狂按重複發送
      if (data.notifiedOverdue && data.notifiedAt) {
        const notifiedDateMs = new Date(data.notifiedAt).getTime();
        const notifiedDateString = new Date(notifiedDateMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
        
        // 如果最後通知的日期就是「今天」，則跳過（代表明天就會放行）
        if (notifiedDateString === todayString) {
          return; 
        }
      }

      const receiveTime = new Date(data.receiveTime).getTime();
      const workingDiffHours = calculateWorkingHours(receiveTime, now);

      if (workingDiffHours > overdueHours) {
        overdueTickets.push({ id: doc.id, ref: doc.ref, ...data });
      }
    });

    if (overdueTickets.length === 0) {
      console.log("目前無需要通知的逾期案件。");
      return { userNotifiedCount: 0, totalTicketsMarked: 0 };
    }

    const usersSnapshot = await db.collection("cs_users").get();
    const userMap = {};
    usersSnapshot.forEach(doc => {
      const u = doc.data();
      if (u.lineUserId) {
        userMap[u.username] = u.lineUserId; 
      }
    });

    if (!LINE_ACCESS_TOKEN) {
      console.error("尚未設定 LINE_ACCESS_TOKEN，無法發送訊息。");
      return { userNotifiedCount: 0, totalTicketsMarked: 0 };
    }

    const ticketsByUser = {};
    for (const ticket of overdueTickets) {
      const targetUser = ticket.assignee || ticket.receiver;
      if (!ticketsByUser[targetUser]) {
        ticketsByUser[targetUser] = [];
      }
      ticketsByUser[targetUser].push(ticket);
    }

    const batch = db.batch();
    let userNotifiedCount = 0;
    let totalTicketsMarked = 0;

    for (const [targetUser, tickets] of Object.entries(ticketsByUser)) {
      const lineUserId = userMap[targetUser];

      if (lineUserId) {
        let message = `⚠️ 【每日逾期案件總覽】\n早安！您目前有 ${tickets.length} 件超過 ${overdueHours} 小時未結案的紀錄：\n\n`;
        
        tickets.forEach((t, index) => {
          message += `${index + 1}. [${t.ticketId || t.id.slice(0,8)}] ${t.instName}\n   進度：${t.progress}\n`;
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
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '必須登入才能執行此操作');
  }
  
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
