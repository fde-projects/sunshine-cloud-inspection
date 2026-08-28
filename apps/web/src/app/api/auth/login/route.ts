import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { adminGql } from "@/lib/hasura-admin";
import { pickDefaultRole, signHasuraUserJwt, type AppRole } from "@/lib/jwt";

type Row = {
  id: string;
  username: string;
  password: string;
  real_name: string;
  phone: string;
  role: AppRole;
  roles: AppRole[];
  status: string;
};

export async function POST(req: Request) {
  const body = (await req.json()) as { username?: string; password?: string };
  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!username || !password) {
    return NextResponse.json({ message: "请输入用户名和密码" }, { status: 400 });
  }

  const data = await adminGql<{ users: Row[] }>(
    `query ($username: String!) {
      users(where: { username: { _eq: $username } }, limit: 1) {
        id username password real_name phone role roles status
      }
    }`,
    { username },
  );
  const user = data.users[0];
  if (!user || user.status !== "active") {
    return NextResponse.json({ message: "用户名或密码错误" }, { status: 401 });
  }
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) {
    return NextResponse.json({ message: "用户名或密码错误" }, { status: 401 });
  }

  const roles = (Array.isArray(user.roles) && user.roles.length
    ? user.roles
    : [user.role]) as AppRole[];
  const role = pickDefaultRole(roles, user.role);
  const token = await signHasuraUserJwt(user.id, roles, role);

  return NextResponse.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      realName: user.real_name,
      phone: user.phone,
      role,
      roles,
    },
  });
}
