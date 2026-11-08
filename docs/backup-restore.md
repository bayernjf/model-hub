# 备份与恢复（model-hub）

> 脚本：`scripts/backup-hub.sh`（备）、`scripts/restore-hub.mjs`（回）。
> 原则：备份必须能安全恢复才算数；恢复失败一律 fail-closed。

## 1. 备份范围

单文件 SQLite：`/data/model-hub.db`（`HUB_DB_PATH`）。快照是 `VACUUM INTO` 产物，
因此**内容仍是密文**：`provider_keys` 里是 envelope 密文，解不开就等于没有。

不可重建的表：`projects`、`provider_keys`、`tokens`、`assignments`、`usage_events`、
`documents`、`chunks`。

## 2. 备份

`docker compose` 的 `backup` sidecar 每 `HUB_BACKUP_INTERVAL_SECONDS`（默认 86400）跑一次，
写到宿主 `./backups/hub-<stamp>.db`，权限 `0600`，按 `HUB_BACKUP_RETENTION_DAYS`（默认 7）剪枝。

手工触发一次：

```bash
BACKUP_ONCE=1 HUB_DB_PATH=/data/model-hub.db BACKUP_DIR=./backups sh scripts/backup-hub.sh
```

## 3. 恢复

```bash
docker compose stop model-hub
HUB_MASTER_KEY=… node --experimental-sqlite scripts/restore-hub.mjs \
  --snapshot ./backups/hub-20261108-000000.db --force
docker compose start model-hub
```

脚本行为：

- `PRAGMA integrity_check` + 7 张关键表计数；
- **没有 `projects` 表就拒绝**（校验通过但不是 model-hub 库的文件等于空壳）；
- 目标存在且无 `--force` 拒绝；`--force` 时旧库保留为 `.pre-restore-<stamp>`；
- 写完复校验，计数与快照不一致即报错；
- `HUB_MASTER_KEY` 未设置时**大声警告**：恢复能完成，但 envelope 解不开。

## 4. 两条硬要求

1. **密钥与快照必须分开保管。** `HUB_MASTER_KEY` 不得写进 `./backups`、也不得与快照同处
   一个卷或同一个 git 仓库；否则拿到快照的人同时拿到钥匙，备份等于没加密。
2. **回滚代码靠镜像 tag，不靠重建。** 具体流程与失效条件见 §4.1。

### 4.1 镜像回滚锚点（2026-11-08）

`docker-compose.yml` 的 `image: model-hub:${HUB_IMAGE_TAG:-latest}` 只是一个钩子，
默认行为不是锚点。

**默认值为什么是问题**：不设 `HUB_IMAGE_TAG` 时用的是 `latest`，而
`docker compose up -d --build` 会把 `latest` 直接覆盖成新构建。"上一版"在构建开始的
那一刻就没了——真出问题时手上只剩坏掉的新镜像，没有可指回的版本。

**发布前保留最近 3 个版本**：

```bash
stamp=$(date +%Y%m%d-%H%M)
docker tag model-hub:latest model-hub:$stamp
# 只留最新的 3 个 stamp tag，更早的删掉（latest 不动）
docker images --format '{{.Repository}}:{{.Tag}}' \
  | grep '^model-hub:' | grep -v ':latest$' | sort -r \
  | awk 'NR>3 {print}' | while read -r img; do docker rmi "$img"; done
```

然后照常 `docker compose up -d --build`。

**回滚命令**（可直接执行）：

```bash
HUB_IMAGE_TAG=20261108-1400 docker compose up -d model-hub
```

只重建容器，不加 `--build`；对应的镜像不存在时 compose 会直接报错，不会静默重新构建。

**这条路径在什么情况下失效**：

- tag 只存在于宿主机的本地 Docker daemon。`docker image prune -a`、
  `docker compose down --rmi all`、换机、重装 Docker 都会让它消失。
- 本仓没有 registry，tag 不跨机，也没有不可变 digest 可引用；它不等价于 registry 方案。
- 需要跨机回滚时只能提前 `docker save model-hub:<stamp> | gzip > model-hub-<stamp>.tgz`，
  在目标机 `docker load`；这份 tar 同样会过期，也可能没同步到别的机器。
- 镜像回滚只回代码。数据回滚走 §3 的快照恢复，两者互相独立，不能拿镜像 tag 当数据回滚。

**为什么不改成 `${HUB_IMAGE_TAG:?}` 强制显式版本**：会改变现有部署方式——
`docker compose up -d --build` 和不带该变量的 `scripts/migrate-to-cloud.sh` 调用会
直接报错退出。要收紧就得同步改 `DEPLOYMENT.md`、迁移脚本，并让每次发布先定 tag。
本次保持默认 `latest`，用上面的"发布前留 tag"补上锚点；等到有 registry 或发布流水线
再考虑强制显式版本。

## 5. 演练记录（2026-11-08）

| 场景 | 结果 |
|---|---|
| 已迁移库恢复 | 成功，打印 7 张表计数 |
| 目标存在无 `--force` | 拒绝，`exit 1` |
| 快照截断 | 拒绝（`database disk image is malformed`），`exit 1` |
| 未迁移库快照 | 拒绝（`not a migrated model-hub database`），`exit 1` |
| 未设 `HUB_MASTER_KEY` | 恢复成功 + 密钥缺失警告 |

### 5.1 季度复跑（2026-11-08 实际执行）

从当日快照恢复到临时目录，不碰生产库：

```bash
rm -rf /tmp/drill-mh && mkdir -p /tmp/drill-mh
node --experimental-sqlite scripts/restore-hub.mjs \
  --snapshot ./backups/hub-20261108-104639.db --target-db /tmp/drill-mh/hub.db
```

实际输出：

```text
restored /tmp/drill-mh/hub.db from ./backups/hub-20261108-104639.db
  (projects=3 provider_keys=3 tokens=4 assignments=9 usage_events=6 documents=0 chunks=0)
restore-hub: HUB_MASTER_KEY is not set — provider-key envelopes will not decrypt.
```

`exit 0`，产物权限 `0600`。恢复成功但密文不可解，说明密钥必须独立保管。

尚未做：异地副本；发布流程里仍未强制先 `docker tag` 留上一版。

