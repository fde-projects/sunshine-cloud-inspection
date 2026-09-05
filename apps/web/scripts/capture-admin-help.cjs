async (page) => {
  const out = "C:/Users/Administrator/Desktop/cursor-ygyw/apps/web/public/help-images/admin";
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
      const found = [];
      const findEl = (spec) => {
        if (spec.selector) {
          const nodes = [...document.querySelectorAll(spec.selector)];
          if (spec.text) {
            return (
              nodes.find((el) => {
                const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
                return spec.includes ? t.includes(spec.text) : t === spec.text;
              }) || null
            );
          }
          return nodes[0] || null;
        }
        const pool = [
          ...document.querySelectorAll(
            "button, a, label, .ant-btn, .ant-menu-title-content, .ant-statistic-title, .ant-modal-title, .portal-card, .pc-login-btn, input, textarea, .ant-tabs-tab, .app-user, .ant-form-item-label, .ant-select-selection-placeholder, .ant-input, .ant-input-search-button",
          ),
        ];
        return pool.find((el) => {
          const t = (el.innerText || el.textContent || el.getAttribute("placeholder") || "")
            .trim()
            .replace(/\s+/g, " ");
          if (spec.placeholder && el.getAttribute("placeholder") === spec.placeholder) return true;
          if (!spec.text) return false;
          return spec.includes ? t.includes(spec.text) : t === spec.text;
        });
      };
      list.forEach((spec) => {
        const el = findEl(spec);
        if (!el) {
          found.push({ text: spec.text || spec.selector, ok: false });
          return;
        }
        el.scrollIntoView({ block: "center", inline: "nearest" });
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) {
          found.push({ text: spec.text || spec.selector, ok: false });
          return;
        }
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
            "box-shadow:0 2px 6px rgba(0,0,0,.18)",
          ].join(";");
          const arrow = document.createElement("div");
          arrow.style.cssText = above
            ? "position:absolute;left:12px;bottom:-6px;border:6px solid transparent;border-top-color:#e11d48;border-bottom:0"
            : "position:absolute;left:12px;top:-6px;border:6px solid transparent;border-bottom-color:#e11d48;border-top:0";
          tag.appendChild(arrow);
          box.appendChild(tag);
        }
        document.body.appendChild(box);
        found.push({ text: spec.text || spec.selector || spec.placeholder, ok: true });
      });
      return found;
    }, items);
  }

  async function shot(name, items) {
    try {
      if (items?.length) await annotate(items);
      await sleep(200);
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

  async function closeModal() {
    const cancel = page.getByRole("button", { name: "取消" });
    if ((await cancel.count()) > 0) {
      await cancel.first().click({ timeout: 3000 }).catch(() => page.keyboard.press("Escape"));
    } else {
      await page.keyboard.press("Escape");
    }
    await sleep(250);
  }

  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await sleep(600);
  await shot("01-portal.png", [
    { selector: ".portal-card", text: "电脑管理后台", includes: true, label: "点这里进入管理端" },
  ]);

  await page.goto("http://localhost:3000/login", { waitUntil: "domcontentloaded" });
  await sleep(700);
  await shot("02-login.png", [
    { placeholder: "请输入用户名", label: "填用户名" },
    { placeholder: "请输入密码", label: "填密码" },
    { text: "进入管理端", label: "填完点这里" },
  ]);

  await page.getByPlaceholder("请输入用户名").fill("admin");
  await page.getByPlaceholder("请输入密码").fill("admin123");
  await sleep(200);
  await shot("03-login-filled.png", [{ text: "进入管理端", label: "点这里登录" }]);

  await page.getByRole("button", { name: "进入管理端" }).click();
  await step("wait-login", async () => {
    await page.getByText("超级管理员").first().waitFor({ timeout: 20000 });
    await sleep(900);
    if (!page.url().includes("/dashboard")) {
      await page.goto("http://localhost:3000/dashboard", { waitUntil: "domcontentloaded" });
      await sleep(700);
    }
  });

  await shot("04-dashboard.png", [
    { selector: ".ant-statistic-title", text: "网格数", label: "数字可点进去" },
    { selector: ".ant-statistic-title", text: "待审核", label: "待审照片" },
  ]);
  await shot("05-sidebar.png", [
    { selector: ".ant-menu-title-content", text: "账号管理", label: "先开账号" },
    { selector: ".ant-menu-title-content", text: "网格管理", label: "再任命人员" },
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

  await step("users", async () => {
    await clickMenu("账号管理");
    await page.getByRole("button", { name: "新增账号" }).waitFor({ timeout: 10000 });
    await sleep(400);
  });
  await shot("07-users.png", [
    { text: "新增账号", label: "点这里开新号" },
    { placeholder: "搜索用户名/姓名/手机", label: "可按姓名搜索" },
  ]);

  await step("users-create", async () => {
    await page.getByRole("button", { name: "新增账号" }).click();
    await sleep(400);
  });
  await shot("08-users-create.png", [
    { text: "用户名", label: "登录名，不能重复" },
    { text: "密码", label: "至少 6 位" },
    { text: "确定", label: "填完点确定" },
  ]);
  await closeModal();

  await step("users-reset", async () => {
    await page.getByRole("button", { name: "重置密码" }).first().click();
    await sleep(350);
  });
  await shot("09-users-reset.png", [
    { text: "新密码", label: "至少 6 位" },
    { text: "确定", label: "点确定后私下告诉对方" },
  ]);
  await closeModal();

  await step("sites", async () => {
    await clickMenu("网格管理");
    await page.getByRole("button", { name: "新增网格" }).waitFor({ timeout: 10000 });
    await sleep(400);
  });
  await shot("10-sites.png", [
    { text: "新增网格", label: "先建网格" },
    { text: "人员", label: "再点人员任命" },
  ]);

  await step("sites-create", async () => {
    await page.getByRole("button", { name: "新增网格" }).click();
    await sleep(450);
  });
  await shot("11-sites-create.png", [
    { text: "网格名称", label: "填电站/片区名" },
    { text: "网格编码", label: "创建后不能改" },
    { text: "完整地址", label: "省+市+区+详细地点" },
    { text: "解析", label: "填完地址点解析" },
  ]);
  await closeModal();

  await step("sites-staff", async () => {
    await page.getByRole("button", { name: "人员" }).first().click();
    await sleep(500);
  });
  await shot("12-sites-staff.png", [
    { text: "加入", label: "选账号后点加入" },
    { text: "正长", label: "勾正网格长" },
    { text: "副长", label: "勾副网格长" },
    { text: "工程师", label: "勾现场作业人" },
  ]);
  await page.keyboard.press("Escape");
  await sleep(250);

  await step("templates", async () => {
    await clickMenu("服务类型");
    await page.getByRole("button", { name: "新建服务类型" }).waitFor({ timeout: 10000 });
    await sleep(400);
  });
  await shot("13-templates.png", [{ text: "新建服务类型", label: "点这里新建" }]);

  await step("templates-edit", async () => {
    await page.getByRole("button", { name: "编辑" }).first().click();
    await sleep(600);
  });
  await shot("14-templates-edit.png", [
    { text: "添加产品线", label: "可再加一条产品线" },
  ]);
  await closeModal();

  await step("finance-open", async () => {
    await page.locator(".ant-menu-submenu-title", { hasText: "费用结算" }).first().click();
    await sleep(350);
  });
  await shot("15-finance-menu.png", [
    { selector: ".ant-menu-title-content", text: "案例管理", label: "日常在这里派工" },
    { selector: ".ant-menu-title-content", text: "结算审核", label: "完工后来审钱" },
  ]);

  await step("fin-dash", async () => {
    await clickMenu("经营看板");
    await sleep(800);
  });
  await shot("16-finance-dashboard.png", []);

  await step("cases", async () => {
    await clickMenu("案例管理");
    await page.getByRole("button", { name: "导入案例" }).waitFor({ timeout: 10000 });
    await sleep(500);
  });
  await shot("17-finance-cases.png", [
    { text: "导入案例", label: "把表格导进来" },
    { text: "批量分配/改派网格", label: "勾选后才亮" },
    { text: "批量派单", label: "派给工程师" },
  ]);

  await step("cases-import", async () => {
    await page.getByRole("button", { name: "导入案例" }).click();
    await sleep(400);
  });
  await shot("18-finance-cases-import.png", [{ selector: ".ant-modal-content", label: "选填好的 Excel" }]);
  await closeModal();

  await step("cases-assign", async () => {
    await page.locator(".ant-table-tbody .ant-checkbox-input").first().check({ force: true });
    await sleep(200);
    await page.getByRole("button", { name: /批量分配/ }).click();
    await sleep(400);
  });
  await shot("19-finance-cases-assign.png", [
    { selector: ".ant-modal-content", label: "选目标网格后确定" },
  ]);
  await closeModal();

  await step("po", async () => {
    await clickMenu("PO 管理");
    await sleep(700);
  });
  await shot("20-finance-po.png", [
    { text: "导入 PO", label: "先下载模板再导入" },
    { text: "待匹配队列", label: "没对上的在这里" },
  ]);

  await step("prices", async () => {
    await clickMenu("价格库");
    await sleep(700);
  });
  await shot("21-finance-prices.png", [
    { text: "新增价格", label: "一条条加" },
    { text: "下载模板", label: "或按模板批量导" },
  ]);

  await step("review", async () => {
    await clickMenu("结算审核");
    await sleep(700);
  });
  await shot("22-finance-review.png", [{ text: "待审核", label: "先看这一页" }]);

  await step("assessment", async () => {
    await clickMenu("考核管理");
    await sleep(700);
  });
  await shot("23-finance-assessment.png", [{ text: "查询", label: "选月份后查询" }]);

  await step("monthly", async () => {
    await clickMenu("月度结算");
    await sleep(700);
  });
  await shot("24-finance-monthly.png", [
    { text: "查询", label: "先查当月" },
  ]);

  await step("hard", async () => {
    await clickMenu("AI 硬规则");
    await sleep(700);
  });
  await shot("25-hard-rules.png", []);

  await step("audit", async () => {
    await clickMenu("验图审核");
    await sleep(700);
  });
  await shot("26-audit.png", []);

  await step("records", async () => {
    await clickMenu("历史查询");
    await sleep(700);
  });
  await shot("27-records.png", [{ text: "导出", label: "需要存档就导出" }]);

  await step("analysis", async () => {
    await clickMenu("数据分析");
    await sleep(800);
  });
  await shot("28-analysis.png", [{ text: "查 询", label: "选条件后查询" }]);

  await step("settings", async () => {
    await clickMenu("系统设置");
    await sleep(500);
  });
  await shot("29-settings.png", [
    { text: "个人资料", label: "改姓名手机" },
    { text: "保存资料", label: "改完点保存" },
  ]);

  await step("pwd-tab", async () => {
    await page.getByRole("tab", { name: "修改密码" }).click();
    await sleep(300);
  });
  await shot("30-settings-password.png", [
    { text: "原密码", label: "先填旧密码" },
    { text: "修改密码", label: "两遍新密码后点这里" },
  ]);

  await step("brand-tab", async () => {
    await page.getByRole("tab", { name: "系统品牌" }).click();
    await sleep(300);
  });
  await shot("31-settings-branding.png", [
    { text: "系统名称", label: "会出现在登录页和菜单" },
    { text: "保存品牌设置", label: "上传后还要保存" },
  ]);

  await shot("32-faq.png", [
    { selector: ".ant-menu-title-content", text: "使用帮助", label: "以后从这里打开手册" },
  ]);

  return {
    url: page.url(),
    saved: results.filter((r) => r.ok && !r.kind).map((r) => r.name),
    failed: results.filter((r) => !r.ok),
  };
}
