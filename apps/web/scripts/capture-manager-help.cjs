async (page) => {
  const out = "C:/Users/Administrator/Desktop/cursor-ygyw/apps/web/public/help-images/manager";
  const results = [];
  const sleep = (ms) => page.waitForTimeout(ms);

  async function clearAnnot() {
    await page.evaluate(() => {
      document.querySelectorAll("[data-help-annot]").forEach((el) => el.remove());
    });
  }

  async function annotate(items) {
    await clearAnnot();
    return page.evaluate((list) => {
      const findEl = (spec) => {
        const root = spec.inModal
          ? document.querySelector(".ant-modal-content") || document.body
          : document.body;
        if (spec.selector && spec.text) {
          return (
            [...root.querySelectorAll(spec.selector)].find((el) => {
              const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
              return spec.includes ? t.includes(spec.text) : t === spec.text;
            }) || null
          );
        }
        if (spec.selector) return root.querySelector(spec.selector);
        const pool = [
          ...root.querySelectorAll(
            "button, a, label, .ant-btn, .ant-menu-title-content, .ant-statistic-title, .ant-modal-title, .portal-card, input, .ant-tabs-tab, .app-user, .ant-form-item-label, .ant-select-selector, th",
          ),
        ];
        return pool.find((el) => {
          const t = (el.innerText || el.textContent || el.getAttribute("placeholder") || "")
            .trim()
            .replace(/\s+/g, " ");
          if (spec.placeholder && el.getAttribute("placeholder") === spec.placeholder) return true;
          if (!spec.text) return false;
          const compact = t.replace(/\s+/g, "");
          const want = spec.text.replace(/\s+/g, "");
          return spec.includes ? compact.includes(want) : compact === want || t === spec.text;
        });
      };
      list.forEach((spec) => {
        const el = findEl(spec);
        if (!el) return;
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        const pad = spec.pad || 5;
        const box = document.createElement("div");
        box.setAttribute("data-help-annot", "1");
        box.style.cssText = [
          "position:fixed",
          `left:${Math.max(2, r.left - pad)}px`,
          `top:${Math.max(2, r.top - pad)}px`,
          `width:${Math.min(window.innerWidth - 8, r.width + pad * 2)}px`,
          `height:${r.height + pad * 2}px`,
          "border:3px solid #e11d48",
          "border-radius:7px",
          "z-index:2147483646",
          "pointer-events:none",
          "box-shadow:0 0 0 3px rgba(225,29,72,.16)",
        ].join(";");
        if (spec.label) {
          const tag = document.createElement("div");
          tag.textContent = spec.label;
          const above = r.top > 40;
          tag.style.cssText = [
            "position:absolute",
            above ? "bottom:100%;margin-bottom:6px" : "top:100%;margin-top:6px",
            "left:0",
            "background:#e11d48",
            "color:#fff",
            'font:12px/22px "Microsoft YaHei",sans-serif',
            "padding:0 8px",
            "border-radius:4px",
            "white-space:nowrap",
          ].join(";");
          box.appendChild(tag);
        }
        document.body.appendChild(box);
      });
    }, items);
  }

  async function shot(name, items) {
    try {
      if (items?.length) await annotate(items);
      await sleep(220);
      await page.screenshot({ path: `${out}/${name}`, type: "png" });
      await clearAnnot();
      results.push({ name, ok: true });
    } catch (error) {
      await clearAnnot().catch(() => undefined);
      results.push({ name, ok: false, error: String(error && error.message ? error.message : error) });
    }
  }

  async function step(name, fn) {
    try {
      await fn();
      results.push({ name, ok: true, kind: "step" });
    } catch (error) {
      results.push({
        name,
        ok: false,
        kind: "step",
        error: String(error && error.message ? error.message : error),
      });
    }
  }

  async function clickMenu(label) {
    await page.locator(".ant-menu-title-content", { hasText: label }).first().click({ timeout: 6000 });
    await sleep(600);
  }

  await page.setViewportSize({ width: 1440, height: 900 });

  await page.evaluate(() => {
    localStorage.removeItem("yangguang.jwt");
    localStorage.removeItem("yangguang.user");
  });
  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await sleep(600);
  await shot("01-portal.png", [
    { selector: ".portal-card", text: "电脑管理后台", includes: true, label: "网格长也点这里" },
  ]);

  await page.goto("http://localhost:3000/login", { waitUntil: "domcontentloaded" });
  await sleep(600);
  const session = await page.locator(".pc-login-session").count();
  if (session) {
    await page.getByText("退出当前账号").click().catch(() => undefined);
    await sleep(400);
  }
  await shot("02-login.png", [
    { placeholder: "请输入用户名", label: "填网格长用户名" },
    { placeholder: "请输入密码", label: "填密码" },
    { text: "进入管理端", label: "点这里登录" },
  ]);

  await page.getByPlaceholder("请输入用户名").fill("scwgcz");
  await page.getByPlaceholder("请输入密码").fill("Help@2026");
  await sleep(200);
  await shot("03-login-filled.png", [{ text: "进入管理端", label: "点这里进入" }]);
  await page.getByRole("button", { name: "进入管理端" }).click();
  await step("wait-login", async () => {
    await page.getByText("网格长").first().waitFor({ timeout: 20000 });
    await sleep(900);
  });

  if (!page.url().includes("/dashboard")) {
    await page.goto("http://localhost:3000/dashboard", { waitUntil: "domcontentloaded" });
    await sleep(700);
  }
  await shot("04-dashboard.png", [
    { text: "案例管理", label: "去派工" },
    { text: "验图审核", label: "去审照片" },
    { selector: ".ant-statistic-title", text: "待审核", label: "本网格待审" },
  ]);
  await shot("05-sidebar.png", [
    { selector: ".ant-menu-title-content", text: "网格管理", label: "管本网格人员" },
    { selector: ".ant-menu-title-content", text: "案例管理", label: "派工程师" },
    { selector: ".ant-menu-title-content", text: "使用帮助", label: "手册在这里" },
  ]);

  await step("user-menu", async () => {
    await page.locator(".app-user").first().click();
    await sleep(350);
  });
  await shot("06-user-menu.png", [
    { text: "系统设置", label: "改自己的资料" },
    { text: "退出登录", label: "换人先退出" },
  ]);
  await page.keyboard.press("Escape");
  await sleep(200);

  await step("sites", async () => {
    await clickMenu("网格管理");
    await page.getByRole("button", { name: "人员" }).waitFor({ timeout: 10000 });
    await sleep(400);
  });
  await shot("07-sites.png", [
    { text: "人员", label: "点这里管任职" },
    { text: "编辑", label: "可改本网格资料" },
  ]);

  await step("staff", async () => {
    await page.getByRole("button", { name: "人员" }).first().click({ force: true });
    await page.locator(".ant-modal-title").filter({ hasText: "网格人员" }).waitFor({ timeout: 8000 });
    await sleep(500);
  });
  await shot("08-sites-staff.png", [
    { text: "副长", inModal: true, label: "正长可勾副长" },
    { text: "工程师", inModal: true, label: "勾现场作业人" },
    { text: "加入", inModal: true, label: "先加入账号再勾" },
  ]);
  await page.keyboard.press("Escape");
  await sleep(300);

  await step("templates", async () => {
    await clickMenu("服务类型");
    await page.getByRole("button", { name: "新建服务类型" }).waitFor({ timeout: 10000 });
    await sleep(400);
  });
  await shot("09-templates.png", [{ text: "新建服务类型", label: "可维护检查项" }]);

  await step("tpl-edit", async () => {
    await page.getByRole("button", { name: "编辑" }).first().click();
    await sleep(600);
  });
  await shot("10-templates-edit.png", [{ text: "添加产品线", label: "名称要和案例一致" }]);
  await page.keyboard.press("Escape");
  await sleep(300);

  await step("fin-open", async () => {
    await page.locator(".ant-menu-submenu-title", { hasText: "费用结算" }).first().click();
    await sleep(350);
  });
  await shot("11-finance-menu.png", [
    { selector: ".ant-menu-title-content", text: "案例管理", label: "日常派工在这里" },
    { selector: ".ant-menu-title-content", text: "考核管理", label: "本网格打分" },
    { selector: ".ant-menu-title-content", text: "月度结算", label: "只能看本网格" },
  ]);

  await step("cases", async () => {
    await clickMenu("案例管理");
    await page.getByRole("button", { name: "批量派单" }).waitFor({ timeout: 10000 });
    await sleep(500);
  });
  await shot("12-cases.png", [
    { text: "批量派单", label: "勾选后派给工程师" },
    { text: "导出 Excel", label: "导出本网格案例" },
  ]);

  await step("audit", async () => {
    await clickMenu("验图审核");
    await sleep(800);
  });
  await shot("13-audit.png", [
    { text: "待人工审核", label: "先审这些" },
    { text: "查看单元", label: "点进去看照片" },
  ]);

  await step("audit-open", async () => {
    const btn = page.getByRole("button", { name: "查看单元" }).first();
    if ((await btn.count()) > 0) {
      await btn.click();
      await sleep(800);
    }
  });
  await shot("14-audit-detail.png", []);
  await page.keyboard.press("Escape");
  await sleep(250);

  await step("records", async () => {
    await clickMenu("历史查询");
    await sleep(700);
  });
  await shot("15-records.png", [{ text: "导出", label: "需要存档就导出" }]);

  await step("analysis", async () => {
    await clickMenu("数据分析");
    await sleep(800);
  });
  await shot("16-analysis.png", [{ text: "查询", label: "选条件后查询" }]);

  await step("assessment", async () => {
    await clickMenu("考核管理");
    await sleep(700);
  });
  await shot("17-assessment.png", [{ text: "本网格排名", label: "给本网格算名次" }]);

  await step("monthly", async () => {
    await clickMenu("月度结算");
    await sleep(700);
  });
  await shot("18-monthly.png", [{ text: "查询", label: "选月份后查看" }]);

  await step("settings", async () => {
    await clickMenu("系统设置");
    await sleep(500);
  });
  await shot("19-settings.png", [
    { text: "个人资料", label: "改姓名手机" },
    { text: "保存资料", label: "改完点保存" },
  ]);

  await step("pwd", async () => {
    await page.getByRole("tab", { name: "修改密码" }).click();
    await sleep(300);
  });
  await shot("20-settings-password.png", [
    { text: "原密码", label: "先填旧密码" },
    { text: "修改密码", label: "两遍新密码后点这里" },
  ]);

  await shot("21-faq.png", [
    { selector: ".ant-menu-title-content", text: "使用帮助", label: "以后从这里打开手册" },
  ]);

  return {
    url: page.url(),
    saved: results.filter((r) => r.ok && !r.kind).map((r) => r.name),
    failed: results.filter((r) => !r.ok),
  };
}
