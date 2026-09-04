# 生产部署（国内镜像仓 + 天翼云）

Release 发布后，GitHub Actions 会构建镜像并推送到 `registry.truss3.weweknow.com`，再 SSH 到服务器拉起 `/opt/sunshine-cloud-inspection`。

## 镜像

- `registry.truss3.weweknow.com/sunshine-cloud-inspection/web:<version>`
- `registry.truss3.weweknow.com/sunshine-cloud-inspection/web:latest`

仓库免登录，workflow 与服务器均不执行 `docker login`。

## GitHub Secrets

在仓库 **Settings → Secrets and variables → Actions** 配置：

| Secret | 示例 / 说明 |
|--------|-------------|
| `DEPLOY_HOST` | `121.229.113.196` |
| `DEPLOY_USER` | `root` |
| `DEPLOY_SSH_KEY` | 部署用私钥全文（含 `BEGIN`/`END` 行） |

服务器 `~/.ssh/authorized_keys` 需放入对应公钥。不要把密码或私钥提交进 git。

## 服务器首次准备

1. 安装 Docker Engine 与 Compose 插件
2. 创建目录：`mkdir -p /opt/sunshine-cloud-inspection`
3. 将已填好的生产 `.env` 放到该目录（与 `docker-compose.yml` 同级），例如：

   ```bash
   scp .env root@<DEPLOY_HOST>:/opt/sunshine-cloud-inspection/.env
   ssh root@<DEPLOY_HOST> 'chmod 600 /opt/sunshine-cloud-inspection/.env'
   ```

4. 配置 GitHub Secrets（见上）
5. 在 GitHub 创建 Release（打 tag，如 `v0.1.0`）→ Actions 自动 build / push / deploy

之后发版只需新建 Release；除非改密钥，否则不必再动服务器上的 `.env`。

## 本地对照

- 根目录 `docker-compose.yml`：本地 `build` 开发用
- 本目录 `docker-compose.yml`：生产 `image` 拉取用（由 CI 同步到服务器）
