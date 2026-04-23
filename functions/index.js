const { onSchedule } = require("firebase-functions/v2/scheduler");
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
  cur.setHours(0, 0, 0, 0); // 取起始日的凌晨 00:00
  
  let endDay = new Date(endMs);
  endDay.setHours(0, 0, 0, 0); // 取結束日的凌晨 00:00
  
  // 逐日檢查是否為六日，若是則扣除該日涵蓋的毫秒數
  while (cur.getTime() <= endDay.getTime()) {
    let day = cur.getDay();
    if (day === 0 || day === 6) { // 0=星期日, 6=星期六
      let startOfDay = cur.getTime();
      let endOfDay = startOfDay + 24 * 60 * 60 * 1000;
      let overlapStart = Math.max(startOfDay, startMs);
      let overlapEnd = Math.min(endOfDay, endMs);
      if (overlapEnd > overlapStart) {
        weekendMs += (overlapEnd - overlapStart);
      }
    }
    cur.setDate(cur.getDate() + 1); // 推進到下一天
  }
  
  // 回傳扣除六日後的真實工作小時數
  return (totalMs - weekendMs) / (1000 * 60 * 60);
}

/**
 * 每日逾期案件整合檢查排程 (排除六日)
 * 設定為：台灣時間【每週一到週五】早上 09:00 執行一次 (Cron: "0 9 * * 1-5")
 */
exports.checkOverdueTickets = onSchedule({
  schedule: "0 9 * * 1-5",
  timeZone: "Asia/Taipei"
}, async (event) => {
  try {
    console.log("開始執行【每日整合版 (扣除週末)】逾期案件檢查排程...");

    // 1. 取得全域逾期時數設定 (如果沒設定則預設 24 小時)
    const settingsDoc = await db.collection("cs_settings").doc("dropdowns").get();
    const overdueHours = settingsDoc.exists && settingsDoc.data().overdueHours 
      ? settingsDoc.data().overdueHours 
      : 24;

    // 2. 取得所有尚未結案的案件
    const recordsSnapshot = await db.collection("cs_records")
      .where("progress", "!=", "結案")
      .get();

    const now = new Date().getTime();
    const overdueTickets = [];

    recordsSnapshot.forEach((doc) => {
      const data = doc.data();
      
      // 排除邏輯刪除的案件與已通知過的案件
      if (data.isDeleted || data.notifiedOverdue) return; 

      const receiveTime = new Date(data.receiveTime).getTime();
      
      // 使用智慧函式：計算扣除六日後的經過時數
      const workingDiffHours = calculateWorkingHours(receiveTime, now);

      // 判斷是否超過設定的逾期時數
      if (workingDiffHours > overdueHours) {
        overdueTickets.push({ id: doc.id, ref: doc.ref, ...data });
      }
    });

    if (overdueTickets.length === 0) {
      console.log("目前無新增的逾期案件。");
      return;
    }

    // 3. 取得所有使用者的 LINE UID 對照表
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
      return;
    }

    // 4. 將逾期案件「依照負責人」進行分組
    const ticketsByUser = {};
    for (const ticket of overdueTickets) {
      // 若有指定處理人則通知處理人，否則通知建檔人
      const targetUser = ticket.assignee || ticket.receiver;
      if (!ticketsByUser[targetUser]) {
        ticketsByUser[targetUser] = [];
      }
      ticketsByUser[targetUser].push(ticket);
    }

    // 5. 針對每位負責人，發送一則整合後的清單訊息
    const batch = db.batch();
    let userNotifiedCount = 0;
    let totalTicketsMarked = 0;

    for (const [targetUser, tickets] of Object.entries(ticketsByUser)) {
      const lineUserId = userMap[targetUser];

      if (lineUserId) {
        // 組合通知內容
        let message = `⚠️ 【每日逾期案件總覽】\n早安！您目前有 ${tickets.length} 件超過 ${overdueHours} 小時未結案的紀錄：\n\n`;
        
        tickets.forEach((t, index) => {
          message += `${index + 1}. [${t.ticketId || t.id.slice(0,8)}] ${t.instName}\n   進度：${t.progress}\n`;
        });
        
        message += `\n請盡速登入系統處理，謝謝！`;

        try {
          // 呼叫 LINE API 發送整合後的訊息
          await axios.post('https://api.line.me/v2/bot/message/push', {
            to: lineUserId,
            messages: [{ type: 'text', text: message }]
          }, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
            }
          });

          // 發送成功後，將該負責人的所有相關案件標記為已通知
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

    // 6. 提交 Firestore 狀態更新
    if (totalTicketsMarked > 0) {
      await batch.commit();
      console.log(`成功發送給 ${userNotifiedCount} 位同仁，並標記了 ${totalTicketsMarked} 筆逾期案件。`);
    } else {
      console.log("逾期案件的負責人皆未綁定 LINE UID，略過發送。");
    }

  } catch (error) {
    console.error("執行排程發生嚴重錯誤:", error);
  }
});
