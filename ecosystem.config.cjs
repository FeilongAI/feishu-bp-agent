module.exports = {
  apps: [
    {
      name: "feishu-bp-agent",
      script: "src/index.ts",
      cwd: __dirname,
      interpreter: "node",
      node_args: "--experimental-strip-types",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_memory_restart: "512M",
      kill_timeout: 15000,
      listen_timeout: 10000,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
