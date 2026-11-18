# 小鱼隔离开发工作区

此处仅供离线开发和合成测试，不是部署目录。禁止读取生产配置、凭据、消息和数据；禁止连接真实平台或向其发消息；禁止操作真实设备、账号和红果；禁止部署、重启或修改生产服务。不要直接运行原 package.json 的 start/check/dry 或未经审查的其他脚本。目录本身不是安全沙箱，直接运行程序可能访问外部资源。

来源：src、scripts、public、assets、package.json 复制自 /root/backups/xiaoyu-before-rollback-20261118-001624；test 和 docs 复制自 /root/ai-companion-xiaoyu/ai-companion-kit/packages/companion，当时配套情况未逐项验证。未复制生产数据配置压缩包、config.json、data、凭据，排除 Python 字节码缓存，以及可能是登录二维码的 public/room_assets/douyin_qr.png 和 douyin_qr_live.png（这两项仍保存在原始备份中）。node_modules 中 playwright-core、better-sqlite3、bindings、file-uri-to-path、ws 为独立副本；并非完整依赖集，原生模块依赖当前 Node ABI，不保证其他环境可用。

SOURCE-MANIFEST.sha256 记录 1024 份复制源文件及其 SHA-256（不包括依赖和本说明、脚本、结果）；复制后与各源文件逐一比对，测试后 manifest 校验通过。后续开发修改会使校验不再全部通过。测试和文档来自当前项目，不证明与备份代码的每一项均兼容。

执行 ./run-offline-synthetic.sh 复现已选合成测试：需要有权创建 mount/network namespace 和挂载；脚本清空环境变量、隐藏 /root 和 /run、隔离 /tmp，使用无外网的网络命名空间。它不是通用恶意代码沙箱；其他目录和设备不一定被隔离，严禁用它运行未经安全审查的任意测试。已运行 3 个测试文件，13/13 通过，详见 OFFLINE-TEST-RESULT.txt；未进行全量测试、真实服务或设备验收。
