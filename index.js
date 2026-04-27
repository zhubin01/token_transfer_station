// 加载环境变量（必须第一行）
require("dotenv").config();
const express = require('express');
const app = express();

// 解析JSON请求体（激活接口用）
app.use(express.json());

// 跨域（快捷指令必备，支持GET+POST）
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// ===================== 多套飞书应用配置 =====================
const APP_CONFIG = {
  app1: {
    id: process.env.FEISHU_APP1_ID,
    secret: process.env.FEISHU_APP1_SECRET
  },
  app2: {
    id: process.env.FEISHU_APP2_ID,
    secret: process.env.FEISHU_APP2_SECRET,
    tableId: process.env.FEISHU_APP2_TABLE_ID // 激活专用表格ID
  }
};
// ============================================================

// 多套Token独立缓存（90分钟）
const tokenCache = {};
// 调用统计（日志用）
const stats = {
  fromCache: 0,   // 从缓存拿token次数
  fromApi: 0      // 从飞书接口拿token次数
};

// ===================== 统一获取Token（纯fetch + 缓存 + 完整日志） =====================
async function getToken(appKey) {
  if (!APP_CONFIG[appKey]) throw new Error("应用配置不存在");
  const { id, secret } = APP_CONFIG[appKey];
  const now = Date.now();
  const cacheKey = `token_${appKey}`;
  const expireKey = `expire_${appKey}`;

  // 缓存有效，直接返回 + 打印日志
  if (tokenCache[cacheKey] && now < tokenCache[expireKey]) {
    stats.fromCache++;
    console.log(`[${new Date().toLocaleString()}] [${appKey}] 从缓存返回Token | 缓存计数: ${stats.fromCache} | 接口计数: ${stats.fromApi}`);
    return tokenCache[cacheKey];
  }

  // 缓存失效，原生fetch请求飞书 + 打印日志
  stats.fromApi++;
  const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: id, app_secret: secret })
  });
  const data = await resp.json();

  if (data.code !== 0) throw new Error("飞书授权失败：" + data.msg);

  // 缓存 90 分钟（5400秒）
  const token = data.tenant_access_token;
  tokenCache[cacheKey] = token;
  tokenCache[expireKey] = now + 5400 * 1000;

  // 打印新获取Token的日志
  console.log(`[${new Date().toLocaleString()}] [${appKey}] 从飞书接口获取Token | 缓存计数: ${stats.fromCache} | 接口计数: ${stats.fromApi}`);
  return token;
}

// ===================== 原有接口：获取飞书Token =====================
app.get("/api/token", async (req, res) => {
  try {
    const appKey = req.query.app;
    if (!appKey || !APP_CONFIG[appKey]) {
      return res.json({ code: -1, msg: "请指定正确的应用标识" });
    }
    const token = await getToken(appKey);
    res.json({
      code: 0,
      token: token,
      expire_time: tokenCache[`expire_${appKey}`]
    });
  } catch (err) {
    res.json({ code: -1, msg: "获取失败", error: err.message });
  }
});

// ===================== 激活码校验接口（纯fetch + 新增激活日志） =====================
app.post("/activate", async (req, res) => {
  try {
    const { code, macID } = req.body;

    // 入参校验
    if (!code || !macID) {
      console.log(`[${new Date().toLocaleString()}] [激活] 失败：激活码/设备ID为空`);
      return res.json({ code: 1, msg: "激活码和设备ID不能为空" });
    }

    // 1. 获取app2的Token（走缓存）
    const token = await getToken("app2");
    const tableId = "EFcWbVwcvaV9JfsHstOcRDg2nBg/tables/tblKB29u4pP0Z6Jl"

    // 2. 原生fetch查询激活码记录
    const searchResp = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/EFcWbVwcvaV9JfsHstOcRDg2nBg/tables/tblKB29u4pP0Z6Jl/records/search`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
          },
          body: JSON.stringify({
            view_id: "vewiOiyyJJ",
            field_names: ["code", "status", "macID"],
            filter: {
              conjunction: "and",
              conditions: [{ field_name: "code", operator: "is", value: [code] }]
            },
            automatic_fields: false
          })
        }
    );
    const searchData = await searchResp.json();
    const records = searchData.data?.items || [];

    // 未查到激活码
    if (records.length === 0) {
      console.log(`[${new Date().toLocaleString()}] [激活] 失败：校验码【${code}】不存在`);
      return res.json({ code: 1, msg: "校验码错误，请重新输入" });
    }

    // 3. 校验状态
    const record = records[0];
    const recordId = record.record_id;
    const currentStatus = record.fields.status || "";
    const allowStatus = ["待激活", "已分配"];

    if (!allowStatus.includes(currentStatus)) {
      console.log(`[${new Date().toLocaleString()}] [激活] 失败：校验码【${code}】状态异常【${currentStatus}】`);
      return res.json({ code: 2, msg: `该校验码已使用/过期：${currentStatus}` });
    }

    // 4. 原生fetch更新记录
    const updateResp = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${tableId}/records/${recordId}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
          },
          body: JSON.stringify({
            fields: {
              status: "已激活",
              macID: macID,
              updateTime: Date.now()
            }
          })
        }
    );
    // 激活成功日志
    console.log(`[${new Date().toLocaleString()}] [激活] 成功：校验码【${code}】绑定设备【${macID}】`);

    // 5. 激活成功返回
    return res.json({
      code: 0,
      msg: "激活成功",
      data: { recordId: recordId, code: code, macID: macID, status: "已激活", updateTime: Date.now()}
    });

  } catch (err) {
    console.log(`[${new Date().toLocaleString()}] [激活] 异常：${err.message}`);
    return res.json({ code: 1, msg: "激活失败：" + err.message });
  }
});

// ===================== 新增：根据激活码查询macID接口 =====================
app.post("/getMacId", async (req, res) => {
  try {
    const { code } = req.body;

    // 入参校验
    if (!code) {
      console.log(`[${new Date().toLocaleString()}] [查询macID] 失败：激活码为空`);
      return res.json({ code: 1, msg: "激活码不能为空" });
    }

    // 获取app2的Token（复用缓存）
    const token = await getToken("app2");
    const tableId = APP_CONFIG.app2.tableId;

    // ========== 飞书查询（100%无报错格式，替换为你的【字段ID】！！！ ==========
    const searchResp = await fetch(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/EFcWbVwcvaV9JfsHstOcRDg2nBg/tables/tblKB29u4pP0Z6Jl/records/search`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
          },
          body: JSON.stringify({
            field_names: ["code", "macID"], // 替换为你的【字段ID】
            filter: {
              conjunction: "and",
              conditions: [
                { field_name: "code", operator: "is", value: [code] } // 替换为你的code字段ID
              ]
            }
          })
        }
    );
    const searchData = await searchResp.json();
    const records = searchData.data?.items || [];

    // 未查询到激活码
    if (records.length === 0) {
      console.log(`[${new Date().toLocaleString()}] [查询macID] 失败：校验码【${code}】不存在`);
      return res.json({ code: 1, msg: "校验码不存在" });
    }

    // 获取macID
    const macID = records[0].fields.macID; // 替换为你的macID字段ID
    console.log(`[${new Date().toLocaleString()}] [查询macID] 成功：校验码【${code}】对应设备【${macID}】`);

    // 成功返回
    return res.json({
      code: 0,
      msg: "查询成功",
      macID: macID,
      updateTime: Date.now()
    });

  } catch (err) {
    console.log(`[${new Date().toLocaleString()}] [查询macID] 异常：${err.message}`);
    return res.json({ code: 1, msg: "查询失败：" + err.message });
  }
});

// 启动服务
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 服务启动成功：http://localhost:${PORT}`);
  console.log(`🔑 Token接口：GET  /api/token?app=app1 或 app2`);
  console.log(`✅ 激活接口：POST /activate`);
});