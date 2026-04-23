const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const axios = require("axios");

// 初始化 Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// 從環境變數讀取 LINE Channel Access Token
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

/**
 * 逾期案件檢查排程
 * 設定為每小時的第 0 分鐘執行一次 (Cron: "0 * * * *")
 */
exports.checkOverdueTickets = onSchedule("0 * * * *", async (event) => {
  try {
    console.log("開始執行逾期案件檢查排程...");

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
      if (data.isDeleted) return; 
      if (data.notifiedOverdue) return; 

      const receiveTime = new Date(data.receiveTime).getTime();
      const diffHours = (now - receiveTime) / (1000 * 60 * 60);

      // 判斷是否超過設定的逾期時數
      if (diffHours > overdueHours) {
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

    // 4. 發送 LINE 推播
    const batch = db.batch();
    let pushCount = 0;

    for (const ticket of overdueTickets) {
      const targetUser = ticket.assignee || ticket.receiver;
      const lineUserId = userMap[targetUser];

      if (lineUserId) {
        const message = `⚠️ 【案件逾期警示】\n` +
                        `案件號：${ticket.ticketId || ticket.id.slice(0, 8)}\n` +
                        `院所名稱：${ticket.instName}\n` +
                        `當前進度：${ticket.progress}\n\n` +
                        `此案件已超過 ${overdueHours} 小時未結案，請盡速登入系統處理！`;

        try {
          await axios.post('[https://api.line.me/v2/bot/message/push](https://api.line.me/v2/bot/message/push)', {
            to: lineUserId,
            messages: [{ type: 'text', text: message }]
          }, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${LINE_ACCESS_TOKEN}`
            }
          });

          // 發送成功後，標記為已通知
          batch.update(ticket.ref, { 
            notifiedOverdue: true, 
            notifiedAt: new Date().toISOString() 
          });
          pushCount++;

        } catch (lineErr) {
          console.error(`發送 LINE 給 ${targetUser} 失敗:`, lineErr.response?.data || lineErr.message);
        }
      }
    }

    // 5. 提交 Firestore 更新
    if (pushCount > 0) {
      await batch.commit();
      console.log(`成功發送並標記了 ${pushCount} 筆逾期通知。`);
    } else {
      console.log("逾期案件的負責人皆未綁定 LINE UID，略過發送。");
    }

  } catch (error) {
    console.error("執行排程發生嚴重錯誤:", error);
  }
});
