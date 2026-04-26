const express = require('express');
const app = express();

// 跨域（快捷指令必备）
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET");
  next();
});

// ===================== 多套飞书应用配置（可无限添加） =====================
const APP_CONFIG = {
  // 第一套飞书应用（快捷指令传 ?app=app1）
  app1: {
    id: process.env.FEISHU_APP1_ID,
    secret: process.env.FEISHU_APP1_SECRET
  },
  // 第二套飞书应用（快捷指令传 ?app=app2）
  app2: {
    id: process.env.FEISHU_APP2_ID,
    secret: process.env.FEISHU_APP2_SECRET
  },
  // 想加更多？直接复制上面格式，app3、app4...
};
// ======================================================================

// 多套Token独立缓存
const tokenCache = {};

// 核心接口：支持多套飞书获取token
app.get("/api/token", async (req, res) => {
  try {
    // 1. 获取参数：?app=app1
    const appKey = req.query.app;
    if (!appKey || !APP_CONFIG[appKey]) {
      return res.json({ code: -1, msg: "请指定正确的应用标识" });
    }

    const { id, secret } = APP_CONFIG[appKey];
    const now = Date.now();
    const cacheKey = `token_${appKey}`;

    // 2. 缓存有效直接返回
    if (tokenCache[cacheKey] && now < tokenCache[`expire_${appKey}`]) {
      return res.json({ code: 0, token: tokenCache[cacheKey], expire_time: tokenCache[`expire_${appKey}`] });
    }

    // 3. 请求飞书获取新token
    const resp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_id: id, app_secret: secret })
    });
    const data = await resp.json();

    // 4. 缓存一个半小时
    tokenCache[cacheKey] = data.tenant_access_token;
    const expire_time = now + 5400 * 1000;
    tokenCache[`expire_${appKey}`] = expire_time;

    res.json({ code: 0, token: data.tenant_access_token, expire_time: expire_time});
  } catch (err) {
    res.json({ code: -1, msg: "获取失败", error: err.message });
  }
});

// 启动服务
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("服务启动"));
