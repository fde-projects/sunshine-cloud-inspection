const LEGACY_USER_KEY = "rememberedUsername";
const SINGLE_KEY = (portal: "pc" | "h5") => `rememberedLogin:${portal}`;
const LIST_KEY = (portal: "pc" | "h5") => `rememberedAccounts:${portal}`;
const MAX_ACCOUNTS = 8;

export type SavedAccount = {
  username: string;
  password: string;
  realName?: string;
};

function readList(portal: "pc" | "h5"): SavedAccount[] {
  try {
    const raw = localStorage.getItem(LIST_KEY(portal));
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((row) => ({
            username: String((row as SavedAccount)?.username || "").trim(),
            password: String((row as SavedAccount)?.password || ""),
            realName: String((row as SavedAccount)?.realName || "").trim() || undefined,
          }))
          .filter((row) => row.username);
      }
    }
  } catch {
    localStorage.removeItem(LIST_KEY(portal));
  }
  return migrateLegacy(portal);
}

function migrateLegacy(portal: "pc" | "h5"): SavedAccount[] {
  const accounts: SavedAccount[] = [];
  try {
    const raw = localStorage.getItem(SINGLE_KEY(portal));
    if (raw) {
      const parsed = JSON.parse(raw) as { username?: string; password?: string };
      const username = String(parsed.username || "").trim();
      if (username) {
        accounts.push({ username, password: String(parsed.password || "") });
      }
    }
  } catch {
    /* ignore */
  }
  if (portal === "pc" && !accounts.length) {
    const legacy = String(localStorage.getItem(LEGACY_USER_KEY) || "").trim();
    if (legacy) accounts.push({ username: legacy, password: "" });
  }
  if (accounts.length) writeList(portal, accounts);
  localStorage.removeItem(SINGLE_KEY(portal));
  if (portal === "pc") localStorage.removeItem(LEGACY_USER_KEY);
  return accounts;
}

function writeList(portal: "pc" | "h5", accounts: SavedAccount[]) {
  localStorage.setItem(LIST_KEY(portal), JSON.stringify(accounts.slice(0, MAX_ACCOUNTS)));
}

export function listSavedAccounts(portal: "pc" | "h5"): SavedAccount[] {
  return readList(portal);
}

export function rememberAccountAfterLogin(
  portal: "pc" | "h5",
  input: { username: string; password: string; realName?: string; rememberPassword: boolean },
) {
  const username = String(input.username || "").trim();
  if (!username) return;
  const rest = readList(portal).filter((row) => row.username.toLowerCase() !== username.toLowerCase());
  writeList(portal, [
    {
      username,
      password: input.rememberPassword ? input.password : "",
      realName: String(input.realName || "").trim() || undefined,
    },
    ...rest,
  ]);
}

export function removeSavedAccount(portal: "pc" | "h5", username: string) {
  const target = username.trim().toLowerCase();
  writeList(
    portal,
    readList(portal).filter((row) => row.username.toLowerCase() !== target),
  );
}

/** 最近一次登录成功的账号，用于打开页面时预填 */
export function loadRememberedLogin(portal: "pc" | "h5"): SavedAccount | null {
  return readList(portal)[0] || null;
}
