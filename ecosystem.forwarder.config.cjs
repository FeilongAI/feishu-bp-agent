module.exports = {
  apps: [
    {
      name: "feishu-bp-forwarder",
      script: "src/forwarderMain.ts",
      cwd: __dirname,
      interpreter: "node",
      node_args: "--experimental-strip-types",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "256M",
      kill_timeout: 20000,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: "production",
        FORWARDER_CORE_URL: "http://127.0.0.1:8090",
        FORWARDER_SPOOL_DIR: "/var/lib/feishu-bp-forwarder/spool"
      }
    }
  ]
};
