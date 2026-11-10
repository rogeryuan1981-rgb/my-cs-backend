const { HttpsError } = require("firebase-functions/v2/https");
const { FieldPath } = require("firebase-admin/firestore");

const ROLES = {
  ADMIN: "後台管理者",
  USER: "一般使用者",
  VIEWER: "紀錄檢視者",
};

const SORT_FIELDS = new Set([
  "receiveTime",
  "instCode",
  "category",
  "isCorrection",
  "extraInfo",
  "receiver",
  "progress",
  "closeTime",
]);

const MAX_PAGE_SIZE = 100;
const MAX_REPORT_ROWS = 5000;

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
  } catch {
    throw new HttpsError("invalid-argument", "分頁游標格式錯誤");
  }
}

function normalizeRequest(input = {}) {
  const scope = input.scope === "all" ? "all" : "history";
  const sortKey = SORT_FIELDS.has(input.sortKey) ? input.sortKey : "receiveTime";
  const direction = input.direction === "asc" ? "asc" : "desc";
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(input.pageSize) || 50));
  return {
    scope,
    sortKey,
    direction,
    pageSize,
    search: String(input.search || "").trim(),
    startDate: String(input.startDate || "").slice(0, 10),
    endDate: String(input.endDate || "").slice(0, 10),
    progress: String(input.progress || "全部"),
    closeDateEnabled: Boolean(input.closeDateEnabled),
    closeStartDate: String(input.closeStartDate || "").slice(0, 10),
    closeEndDate: String(input.closeEndDate || "").slice(0, 10),
    cursor: decodeCursor(input.cursor),
  };
}

function getCloseTime(record) {
  if (record.progress !== "結案") return "";
  return String(record.closeTime || record.createdAt || "");
}

function matchesRecord(record, filters, categoryMapping = {}) {
  if (filters.scope === "history" && record.isDeleted) return false;

  if (filters.progress !== "全部") {
    if (filters.progress === "未結案") {
      if (record.progress === "結案") return false;
    } else if (record.progress !== filters.progress) {
      return false;
    }
  }

  const receiveDate = String(record.receiveTime || "").slice(0, 10);
  if (filters.startDate && receiveDate < filters.startDate) return false;
  if (filters.endDate && receiveDate > filters.endDate) return false;

  if (filters.closeDateEnabled) {
    const closeDate = getCloseTime(record).slice(0, 10);
    if (!closeDate) return false;
    if (filters.closeStartDate && closeDate < filters.closeStartDate) return false;
    if (filters.closeEndDate && closeDate > filters.closeEndDate) return false;
  }

  if (filters.search) {
    const mappedCategory = String(categoryMapping[record.category] || "").trim();
    const majorCategory = mappedCategory || "未歸屬大類別";
    const haystack = [
      record.ticketId,
      record.instName,
      record.extraInfo,
      record.category,
      majorCategory,
      record.receiver,
    ].map((value) => String(value || "")).join("\n");
    if (!haystack.includes(filters.search)) return false;
  }
  return true;
}

function compareRecords(a, b, sortKey, direction) {
  const left = sortKey === "receiveTime" ? Date.parse(a[sortKey] || "") || 0 : (a[sortKey] ?? "");
  const right = sortKey === "receiveTime" ? Date.parse(b[sortKey] || "") || 0 : (b[sortKey] ?? "");
  if (left < right) return direction === "asc" ? -1 : 1;
  if (left > right) return direction === "asc" ? 1 : -1;
  return String(a.id).localeCompare(String(b.id)) * (direction === "asc" ? 1 : -1);
}

async function authorize(db, request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "必須登入才能讀取案件");
  const username = String(request.data?.username || "").trim();
  const email = String(request.auth.token?.email || "").toLowerCase();
  if (!username || !email) throw new HttpsError("permission-denied", "找不到登入者識別資料");

  const expectedEmail = `${encodeURIComponent(username).replace(/%/g, "_")}@cs.local`.toLowerCase();
  if (email !== expectedEmail) throw new HttpsError("permission-denied", "登入身分與使用者資料不符");

  const snapshot = await db.collection("cs_users").where("username", "==", username).limit(1).get();
  if (snapshot.empty) throw new HttpsError("permission-denied", "沒有客服系統使用權限");
  const profile = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
  if (profile.isDisabled) throw new HttpsError("permission-denied", "此帳號已停用");
  return profile;
}

async function loadCategoryMapping(db) {
  const snapshot = await db.collection("cs_settings").doc("dropdowns").get();
  return snapshot.exists ? (snapshot.data().categoryMapping || {}) : {};
}

function buildEfficientQuery(db, filters) {
  let query = db.collection("cs_records");
  if (filters.progress !== "全部" && filters.progress !== "未結案") {
    query = query.where("progress", "==", filters.progress);
  }
  if (filters.startDate) query = query.where("receiveTime", ">=", `${filters.startDate}T00:00`);
  if (filters.endDate) query = query.where("receiveTime", "<=", `${filters.endDate}T23:59:59.999`);
  query = query.orderBy("receiveTime", filters.direction).orderBy(FieldPath.documentId(), filters.direction);
  return query;
}

function canUseEfficientQuery(filters) {
  return filters.sortKey === "receiveTime"
    && !filters.search
    && !filters.closeDateEnabled
    && filters.progress !== "未結案";
}

async function runEfficientPage(db, filters) {
  const baseQuery = buildEfficientQuery(db, filters);
  const countPromises = [baseQuery.count().get()];
  if (filters.scope === "history") countPromises.push(baseQuery.where("isDeleted", "==", true).count().get());
  const countSnapshots = await Promise.all(countPromises);
  const totalCount = countSnapshots[0].data().count - (countSnapshots[1]?.data().count || 0);

  let pageQuery = baseQuery;
  if (filters.cursor) pageQuery = pageQuery.startAfter(filters.cursor.receiveTime, db.collection("cs_records").doc(filters.cursor.id));
  const matchedDocs = [];
  let exhausted = false;
  const batchSize = filters.pageSize + 1;
  while (matchedDocs.length <= filters.pageSize && !exhausted) {
    const snapshot = await pageQuery.limit(batchSize).get();
    snapshot.docs.forEach((snapshotDoc) => {
      if (filters.scope === "all" || snapshotDoc.get("isDeleted") !== true) matchedDocs.push(snapshotDoc);
    });
    exhausted = snapshot.size < batchSize;
    const lastScanned = snapshot.docs[snapshot.docs.length - 1];
    if (!exhausted && lastScanned) {
      pageQuery = baseQuery.startAfter(lastScanned.get("receiveTime") || "", lastScanned.ref);
    } else if (!lastScanned) {
      exhausted = true;
    }
  }
  const docs = matchedDocs.slice(0, filters.pageSize);
  const records = docs.map((snapshotDoc) => ({ id: snapshotDoc.id, ...snapshotDoc.data() }));
  const last = docs[docs.length - 1];
  return {
    records,
    totalCount,
    nextCursor: matchedDocs.length > filters.pageSize && last
      ? encodeCursor({ receiveTime: last.get("receiveTime") || "", id: last.id })
      : null,
    strategy: "indexed-cursor",
  };
}

async function runCompatibilityPage(db, filters) {
  // Firestore 沒有原生的 contains 全文搜尋。複合搜尋、結案日（含歷史回覆推導）
  // 及非 receiveTime 排序必須先取「日期範圍內」的候選資料再精確比對。
  // 這條路徑只在使用者明確使用上述功能時執行，保持舊版搜尋語意完整。
  let query = db.collection("cs_records");
  if (filters.startDate) query = query.where("receiveTime", ">=", `${filters.startDate}T00:00`);
  if (filters.endDate) query = query.where("receiveTime", "<=", `${filters.endDate}T23:59:59.999`);
  query = query.orderBy("receiveTime", "desc");
  const [snapshot, categoryMapping] = await Promise.all([query.get(), loadCategoryMapping(db)]);
  const matched = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((record) => matchesRecord(record, filters, categoryMapping))
    .sort((a, b) => compareRecords(a, b, filters.sortKey, filters.direction));

  let startIndex = 0;
  if (filters.cursor) {
    const index = matched.findIndex((record) => record.id === filters.cursor.id);
    startIndex = index >= 0 ? index + 1 : 0;
  }
  const records = matched.slice(startIndex, startIndex + filters.pageSize);
  const last = records[records.length - 1];
  return {
    records,
    totalCount: matched.length,
    nextCursor: startIndex + records.length < matched.length && last ? encodeCursor({ id: last.id }) : null,
    strategy: "compatibility-scan",
  };
}

async function queryRecords(db, request) {
  const profile = await authorize(db, request);
  const filters = normalizeRequest(request.data);
  if (filters.scope === "all" && profile.role !== ROLES.ADMIN) {
    throw new HttpsError("permission-denied", "只有後台管理者可讀取原始資料總表");
  }
  if (!canUseEfficientQuery(filters)) return runCompatibilityPage(db, filters);
  try {
    return await runEfficientPage(db, filters);
  } catch (error) {
    // 新索引部署後可能仍在 BUILDING。這段期間維持功能正確，改走按需相容路徑；
    // 索引完成後下一次請求會自然恢復 indexed-cursor。
    if (error?.code === 9 || error?.code === "failed-precondition") {
      console.warn("Firestore 索引尚未就緒，暫時改用 compatibility-scan。", error.message);
      return runCompatibilityPage(db, filters);
    }
    throw error;
  }
}

async function reportRecords(db, request) {
  const profile = await authorize(db, request);
  const filters = normalizeRequest({ ...request.data, pageSize: MAX_PAGE_SIZE });
  const reportType = String(request.data?.reportType || "export");
  if ((filters.scope === "all" || reportType === "audit" || reportType === "anomaly") && profile.role !== ROLES.ADMIN) {
    throw new HttpsError("permission-denied", "沒有讀取此報表的權限");
  }

  if (reportType === "maintenance") {
    const [openSnapshot, pendingInstitutionSnapshot, usersSnapshot] = await Promise.all([
      db.collection("cs_records").where("progress", "!=", "結案").get(),
      db.collection("cs_records").where("progress", "==", "結案").where("instCode", "==", "999").get(),
      db.collection("cs_users").select("username", "operationProxy").get(),
    ]);
    const proxyByUser = {};
    usersSnapshot.forEach((doc) => { proxyByUser[doc.get("username")] = doc.get("operationProxy") || ""; });
    const isVisible = (record) => profile.role === ROLES.ADMIN
      || record.receiver === profile.username
      || record.assignee === profile.username
      || proxyByUser[record.receiver] === profile.username
      || proxyByUser[record.assignee] === profile.username;
    const byId = new Map();
    [...openSnapshot.docs, ...pendingInstitutionSnapshot.docs].forEach((doc) => {
      const record = { id: doc.id, ...doc.data() };
      if (!record.isDeleted && isVisible(record)) byId.set(record.id, record);
    });
    const records = [...byId.values()].sort((a, b) => compareRecords(a, b, "receiveTime", filters.direction));
    return { records, totalCount: records.length, strategy: "maintenance-scope" };
  }

  let query = db.collection("cs_records");
  if (filters.startDate) query = query.where("receiveTime", ">=", `${filters.startDate}T00:00`);
  if (filters.endDate) query = query.where("receiveTime", "<=", `${filters.endDate}T23:59:59.999`);
  query = query.orderBy("receiveTime", "desc").orderBy(FieldPath.documentId(), "desc");
  const chunkCursor = decodeCursor(request.data?.reportCursor);
  if (chunkCursor) query = query.startAfter(chunkCursor.receiveTime, db.collection("cs_records").doc(chunkCursor.id));
  const chunkSize = 1000;
  const snapshotPromise = reportType === "export" ? query.get() : query.limit(chunkSize).get();
  const [snapshot, categoryMapping] = await Promise.all([snapshotPromise, loadCategoryMapping(db)]);
  const records = snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((record) => matchesRecord(record, filters, categoryMapping))
    .sort((a, b) => compareRecords(a, b, filters.sortKey, filters.direction));
  if (reportType === "export" && records.length > MAX_REPORT_ROWS) {
    throw new HttpsError("resource-exhausted", `結果超過 ${MAX_REPORT_ROWS} 筆，請縮小日期或搜尋範圍`);
  }
  const last = snapshot.docs[snapshot.docs.length - 1];
  const reportCursor = reportType !== "export" && snapshot.size === chunkSize && last
    ? encodeCursor({ receiveTime: last.get("receiveTime") || "", id: last.id })
    : null;
  return { records, totalCount: records.length, reportCursor, strategy: "on-demand-report" };
}

module.exports = {
  ROLES,
  authorize,
  compareRecords,
  matchesRecord,
  normalizeRequest,
  queryRecords,
  reportRecords,
};
