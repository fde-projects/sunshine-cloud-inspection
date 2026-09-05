async (page) => {
  const out = "C:/Users/Administrator/Desktop/cursor-ygyw/apps/web/public/help-images/engineer";
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
        const root = document.body;
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
            "button, a, label, .rv-cell, .rv-tabbar-item, .home-start, .home-site-switch, input, textarea, .rv-button, .case-dock__primary, .case-dock__outline, .portal-card, .h5-login-btn, h1, h2, .my-hero, .inc-bill-sum",
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
        const pad = spec.pad || 4;
        const box = document.createElement("div");
        box.setAttribute("data-help-annot", "1");
        box.style.cssText = [
          "position:fixed",
          `left:${Math.max(2, r.left - pad)}px`,
          `top:${Math.max(2, r.top - pad)}px`,
          `width:${Math.min(window.innerWidth - 8, r.width + pad * 2)}px`,
          `height:${Math.min(window.innerHeight - 8, r.height + pad * 2)}px`,
          "border:3px solid #e11d48",
          "border-radius:7px",
          "z-index:2147483646",
          "pointer-events:none",
          "box-shadow:0 0 0 3px rgba(225,29,72,.16)",
        ].join(";");
        if (spec.label) {
          const tag = document.createElement("div");
          tag.textContent = spec.label;
          const above = r.top > 36;
          tag.style.cssText = [
            "position:absolute",
            above ? "bottom:100%;margin-bottom:4px" : "top:100%;margin-top:4px",
            "left:0",
            "background:#e11d48",
            "color:#fff",
            'font:11px/18px "Microsoft YaHei",sans-serif',
            "padding:0 6px",
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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    localStorage.removeItem("yangguang.jwt");
    localStorage.removeItem("yangguang.user");
    sessionStorage.clear();
  });

  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded" });
  await sleep(700);
  await shot("01-portal.png", [
    { selector: ".portal-card", text: "手机作业端", includes: true, label: "工程师点这里" },
  ]);

  await page.goto("http://localhost:3000/m/login", { waitUntil: "domcontentloaded" });
  await sleep(800);
  await page.evaluate(() => {
    document.querySelectorAll("input").forEach((el) => {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  await sleep(200);
  await shot("02-login.png", [
    { placeholder: "请输入用户名", label: "填用户名" },
    { placeholder: "请输入密码", label: "填密码" },
    { text: "进入作业端", label: "点这里登录" },
  ]);

  const userField = page.getByPlaceholder("请输入用户名");
  const pwdField = page.getByPlaceholder("请输入密码");
  await userField.fill("scgcs");
  await pwdField.fill("Help@2026");
  await sleep(200);
  await shot("03-login-filled.png", [{ text: "进入作业端", label: "点这里进入" }]);

  await page.getByRole("button", { name: "进入作业端" }).click();
  await step("wait-login", async () => {
    await page.getByText("现场作业台").first().waitFor({ timeout: 20000 });
    await sleep(1000);
  });

  if (!page.url().includes("/m")) {
    await page.goto("http://localhost:3000/m", { waitUntil: "domcontentloaded" });
    await sleep(800);
  }

  await shot("04-home.png", [
    { selector: ".home-start", label: "去接单" },
    { text: "待接单", includes: true, label: "看数量" },
  ]);

  await shot("05-tabs.png", [
    { selector: ".rv-tabbar", label: "底栏三个入口" },
  ]);

  await page.getByRole("button", { name: /切换网格/ }).first().click();
  await sleep(800);
  await shot("06-sites.png", [
    { text: "珠三角", includes: true, label: "点网格切换" },
  ]);

  await page.goto("http://localhost:3000/m/tasks", { waitUntil: "domcontentloaded" });
  await sleep(1000);
  await shot("07-tasks.png", [
    { text: "未开始", label: "待接单" },
    { text: "IN2608030005", includes: true, label: "点进去干活" },
  ]);

  await page.locator("a, button, .tasks-page__list *").filter({ hasText: "IN2608030005" }).first().click({ force: true }).catch(async () => {
    await page.goto("http://localhost:3000/m", { waitUntil: "domcontentloaded" });
    await sleep(600);
    await page.locator(".home-start").click();
  });
  await sleep(1200);

  let caseUrl = page.url();
  if (!caseUrl.includes("/finance-cases/")) {
    const href = await page.evaluate(() => {
      const el = [...document.querySelectorAll("a, button, [class]")].find((n) =>
        (n.textContent || "").includes("IN2608030005") || (n.textContent || "").includes("文灿"),
      );
      if (el && el.closest("a")) return el.closest("a").getAttribute("href");
      return null;
    });
    if (href) {
      await page.goto(`http://localhost:3000${href.startsWith("/") ? href : `/${href}`}`, {
        waitUntil: "domcontentloaded",
      });
      await sleep(800);
    } else {
      await page.locator(".home-start, .tasks-page__list button, .tasks-page__list a").first().click({ force: true });
      await sleep(1000);
    }
  }
  caseUrl = page.url();
  results.push({ name: "case-url", ok: true, caseUrl });

  await shot("08-case-detail.png", [
    { selector: ".case-dock__primary", label: "接单开始" },
    { selector: ".case-dock__outline", label: "填报销（可选）" },
  ]);

  await step("enter-inspect", async () => {
    const primary = page.locator(".case-dock__primary");
    if (await primary.count()) {
      await primary.click({ force: true });
      await sleep(1600);
    }
  });

  if (page.url().includes("/inspection/")) {
    await shot("09-inspect.png", [
      { text: "下一步", includes: true, label: "拍完点下一步" },
    ]);
    await page.goBack().catch(() => undefined);
    await sleep(800);
    if (!page.url().includes("/finance-cases/")) {
      await page.goto(caseUrl, { waitUntil: "domcontentloaded" });
      await sleep(800);
    }
  } else {
    await shot("09-inspect.png", [
      { selector: ".case-dock__primary", label: "进现场拍照" },
    ]);
  }

  await step("open-expense", async () => {
    const exp = page.locator(".case-dock__outline").filter({ hasText: "费用" });
    if (await exp.count()) {
      await exp.first().click({ force: true });
      await sleep(1000);
    } else if (caseUrl.includes("/finance-cases/")) {
      await page.goto(`${caseUrl.replace(/\/$/, "")}/expense`, { waitUntil: "domcontentloaded" });
      await sleep(800);
    }
  });
  await shot("10-expense.png", [
    { text: "保存草稿", label: "先保存" },
    { text: "提交审核", label: "齐了再交" },
  ]);

  await page.goto("http://localhost:3000/m/income", { waitUntil: "domcontentloaded" });
  await sleep(1000);
  await shot("11-income.png", [
    { selector: ".inc-bill-sum", label: "到手合计（只算已审）" },
  ]);

  await page.goto("http://localhost:3000/m/my", { waitUntil: "domcontentloaded" });
  await sleep(800);
  await shot("12-my.png", [
    { text: "使用帮助", includes: true, label: "打开手册" },
    { text: "我的收入", includes: true, label: "看钱" },
  ]);

  await page.goto("http://localhost:3000/m/settings", { waitUntil: "domcontentloaded" });
  await sleep(800);
  await shot("13-settings.png", [
    { text: "保存资料", label: "改完点这里" },
    { text: "修改密码", label: "改自己的密码" },
  ]);

  await page.getByRole("button", { name: "修改密码" }).click();
  await sleep(500);
  await shot("14-password.png", [
    { text: "确认修改", label: "填完点这里" },
  ]);
  await page.keyboard.press("Escape").catch(() => undefined);

  await page.goto("http://localhost:3000/m/my", { waitUntil: "domcontentloaded" });
  await sleep(700);
  const helpCell = page.locator(".rv-cell").filter({ hasText: "使用帮助" });
  await helpCell.scrollIntoViewIfNeeded();
  await shot("15-help-entry.png", [{ text: "使用帮助", includes: true, label: "以后在这里打开" }]);

  return results;
}
