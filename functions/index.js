const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const axios = require("axios");

// 初始化 Firebase
admin.initializeApp();
const db = admin.firestore();

// 從環境變數讀取 LINE Token
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;

/**
 * 終極偵錯版排程：
 * 每 1 分鐘執行一次，並印出所有偵錯資訊
 */
exports.checkOverdueTickets = onSchedule("* * * * *", async (event) => {
  try {
    console.log("=== 🚀 開始執行逾期案件檢查 ===");
    console.log(`目前的 LINE_TOKEN 狀態: ${LINE_ACCESS_TOKEN ? '✅ 已設定' : '❌ 未設定'}`);

    // 1. 抓取設定檔
    const settingsSnap = await db.collectionGroup("cs_settings").get();
    let overdueHours = 24;
    settingsSnap.forEach(doc => {
      if (doc.id === 'dropdowns' && doc.data().overdueHours) {
        overdueHours = doc.data().overdueHours;
      }
    });
    console.log(`⏳ 系統當前逾期標準：${overdueHours} 小時`);

    // 2. 抓取所有紀錄並過濾
    const recordsSnap = await db.collectionGroup("cs_records").get();
    console.log(`📦 資料庫共掃描到 ${recordsSnap.size} 筆客服紀錄`);
    
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

    console.log(`⚠️ 篩選出【符合逾期】且【未通知過】的案件數：${overdueTickets.length} 件`);

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
    console.log(`👥 系統共 ${usersSnap.size} 名使用者。目前已綁定 LINE UID 的對照表為：`, userMap);

    if (!LINE_ACCESS_TOKEN) {
      console.error("❌ 嚴重錯誤：沒有抓到 LINE_ACCESS_TOKEN，請檢查 GitHub Secrets 與 deploy.yml");
      return;
    }

    // 4. 開始發送推播
    const batch = db.batch();
    let pushCount = 0;

    for (const ticket of overdueTickets) {
      const targetUser = ticket.assignee || ticket.receiver;
      const lineUserId = userMap[targetUser];
      
      console.log(`🎯 [案件 ${ticket.ticketId}] 目標負責人: ${targetUser} | 對應到的 UID: ${lineUserId || '找不到 (無)'}`);

      if (lineUserId) {
        const message = `⚠️ 【案件逾期測試】\n` +
                        `案件號：${ticket.ticketId || ticket.id.slice(0, 8)}\n` +
                        `院所：${ticket.instName}\n` +
                        `當前進度：${ticket.progress}\n\n` +
                        `這是一則測試訊息，案件已模擬超過 ${overdueHours} 小時未結案！`;
        try {
          console.log(`📤 正在呼叫 LINE API 發送給 ${lineUserId}...`);
          await axios.post('https://api.line.me/v2/bot/message/push', {
            to: lineUserId,
            messages: [{ type: 'text', text: message }]
          }, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_ACCESS_TOKEN}` }
          });
          
          console.log(`✅ [案件 ${ticket.ticketId}] 發送成功！`);
          batch.update(ticket.ref, { notifiedOverdue: true, notifiedAt: new Date().toISOString() });
          pushCount++;
        } catch (err) {
          console.error(`❌ [案件 ${ticket.ticketId}] 發送 LINE 失敗，API 回應:`, err.response?.data || err.message);
        }
      }
    }

    if (pushCount > 0) {
      await batch.commit();
      console.log(`🎉 批次標記完成，本次共成功發送 ${pushCount} 筆推播！`);
    } else {
      console.log(`ℹ️ 雖然有逾期案件，但因為「負責人沒有對應的 UID」或「發送失敗」，本次送出 0 筆通知。`);
    }

  } catch (error) {
    console.error("🔥 排程發生未預期錯誤:", error);
  }
});
