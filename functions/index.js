const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const axios = require("axios");

// 初始化 Firebase
admin.initializeApp();
const db = admin.firestore();

// 從環境變數讀取 LINE Token
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

/**
 * 目前為【每 1 分鐘】測試模式。
 * 測試成功後，請將下方 "* * * * *" 改回 "0 * * * *" (每小時整點)，
 * 然後再到 GitHub 存檔 (Commit) 一次即可恢復正常運作！
 */
exports.checkOverdueTickets = onSchedule("* * * * *", async (event) => {
  try {
    console.log("=== 🚀 開始執行逾期案件檢查 ===");

    // 1. 抓取設定檔
    const settingsSnap = await db.collectionGroup("cs_settings").get();
    let overdueHours = 24;
    settingsSnap.forEach(doc => {
      if (doc.id === 'dropdowns' && doc.data().overdueHours) {
        overdueHours = doc.data().overdueHours;
      }
    });

    // 2. 抓取所有紀錄並過濾
    const recordsSnap = await db.collectionGroup("cs_records").get();
    const now = new Date().getTime();
    const overdueTickets = [];

    recordsSnap.forEach((doc) => {
      const data = doc.data();
      if (data.progress === "結案" || data.isDeleted || data.notifiedOverdue) return;
      
      const receiveTime = new Date(data.receiveTime).getTime();
      const diffHours = (now - receiveTime) / (1000 * 60 * 60);
      
      if (diffHours > overdueHours) {
        overdueTickets.push({ id: doc.id, ref: doc.ref, ...data });
      }
    });

    if (overdueTickets.length === 0) {
      console.log("✅ 目前無符合條件的逾期案件，提早結束。");
      return;
    }

    // 3. 取得所有用戶並建立 UID 對照表
    const usersSnap = await db.collectionGroup("cs_users").get();
    const userMap = {};
    usersSnap.forEach(doc => {
      const u = doc.data();
      if (u.lineUserId) userMap[u.username] = u.lineUserId;
    });

    if (!LINE_ACCESS_TOKEN) {
      console.error("❌ 沒有抓到 LINE_ACCESS_TOKEN");
      return;
    }

    // 4. 開始發送推播
    const batch = db.batch();
    let pushCount = 0;

    for (const ticket of overdueTickets) {
      const targetUser = ticket.assignee || ticket.receiver;
      const lineUserId = userMap[targetUser];

      if (lineUserId) {
        const message = `⚠️ 【案件逾期測試】\n` +
                        `案件號：${ticket.ticketId || ticket.id.slice(0, 8)}\n` +
                        `院所：${ticket.instName}\n` +
                        `當前進度：${ticket.progress}\n\n` +
                        `案件已超過 ${overdueHours} 小時未結案，請盡速處理！`;
        try {
          // 💡 修正點：確保網址為純文字，無 Markdown 格式
          await axios.post('https://api.line.me/v2/bot/message/push', {
            to: lineUserId,
            messages: [{ type: 'text', text: message }]
          }, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` }
          });
          
          batch.update(ticket.ref, { notifiedOverdue: true, notifiedAt: new Date().toISOString() });
          pushCount++;
        } catch (err) {
          console.error(`❌ [案件 ${ticket.ticketId}] 發送失敗:`, err.response?.data || err.message);
        }
      }
    }

    if (pushCount > 0) {
      await batch.commit();
      console.log(`🎉 批次標記完成，本次共成功發送 ${pushCount} 筆推播！`);
    }

  } catch (error) {
    console.error("🔥 排程發生未預期錯誤:", error);
  }
});
